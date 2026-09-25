/**
 * OWNER: planner. Question → typed plan → SQL. Pure TS (no DOM/React) so bun scripts can run it.
 *
 *   planQuestion: extract candidates (value index, years, numbers) → /api/plan (Jev) or the
 *   offline planner → QueryPlan → compilePlan → CompiledQuery, plus the slots Jev chose (for
 *   interpretation chips) and up to two "Did you mean" alternatives from runner-up options.
 */
import type { Catalog, CatalogColumn, CompiledQuery, JevMeta, PlanAnswers, PlanFilter, PlanRequest, QueryPlan, TryPrompt } from "@shared/contract"
import { JevUnavailable, postPlan } from "@/lib/jev/client"
import { findCandidates } from "./candidates"
import { compilePlan } from "./compile"
import { nearestTimeColumn } from "./graph"
import { isGenericDisplayName, singularizeLabel } from "./normalize"
import { offlineAnswers } from "./offline"
import { buildPlanRequest } from "./request"
import { interpretAnswers } from "./interpret"
import type { Alternative, SlotKey, SlotView } from "./interpret"

export { compilePlan } from "./compile"
export type { Alternative, Interpretation, SlotKey, SlotOption, SlotView } from "./interpret"

export interface PlanOutcome {
  status: "ok" | "out_of_scope" | "no_match" | "error"
  question: string
  plan: QueryPlan | null
  compiled: CompiledQuery | null
  /** minimum confidence over the slots the plan uses (function-calling cookbook) */
  confidence: number
  slots: SlotView[]
  alternatives: Alternative[]
  /** raw answers + the request, kept so applyChoice can rebuild without asking Jev again */
  answers: PlanAnswers | null
  request: PlanRequest | null
  meta: JevMeta
  /** user-facing explanation for non-ok statuses ("That isn't in the Nobel Prizes data") */
  message?: string
}

function safeCompile(plan: QueryPlan | null, catalog: Catalog): CompiledQuery | null {
  if (!plan) return null
  try {
    return compilePlan(plan, catalog)
  } catch (err) {
    console.error("[plan] compile failed", err)
    return null
  }
}

export async function planQuestion(question: string, catalog: Catalog, opts: { signal?: AbortSignal } = {}): Promise<PlanOutcome> {
  const trimmed = question.trim().slice(0, 300)
  const candidates = findCandidates(trimmed, catalog)
  const request = buildPlanRequest(trimmed, catalog, candidates)

  let answers: PlanAnswers
  let meta: JevMeta
  try {
    const res = await postPlan(request, opts.signal)
    answers = res.answers
    meta = res.meta
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err
    const reason = err instanceof JevUnavailable ? err.reason : "error"
    answers = offlineAnswers(request)
    meta = { source: "offline", model: "jev-offline", latencyMs: 0, questionCount: Object.keys(request.measures).length, reason }
  }

  const interpretation = interpretAnswers(answers, request, catalog)
  const compiled = safeCompile(interpretation.plan, catalog)
  const status = interpretation.status === "no_match" && !compiled ? "no_match" : interpretation.status
  return {
    status,
    question: trimmed,
    plan: interpretation.plan,
    compiled,
    confidence: interpretation.confidence,
    slots: interpretation.slots,
    alternatives: interpretation.alternatives,
    answers,
    request,
    meta,
    message: interpretation.message,
  }
}

/** Swap one slot (chip picker / Did-you-mean) and recompile, without another Jev call. */
export function applyChoice(outcome: PlanOutcome, slot: SlotKey, optionKey: string, catalog: Catalog): PlanOutcome {
  if (!outcome.answers || !outcome.request) return outcome
  const answers = structuredClone(outcome.answers)
  const forced = (probabilities: Record<string, number>, value: string): { value: string; confidence: number; probabilities: Record<string, number> } => ({
    value,
    confidence: probabilities[value] ?? 1,
    probabilities,
  })

  // Per-candidate slots ("<prefix>:<id>") map onto a keyed answers record; the rest onto one field.
  const keyed: Record<string, "filters" | "filterRoles" | "thresholds" | "texts" | "combine" | "rankWindows"> = {
    filter: "filters",
    role: "filterRoles",
    threshold: "thresholds",
    text: "texts",
    combine: "combine",
    window: "rankWindows",
  }
  const single: Partial<Record<SlotKey, "answerKind" | "measure" | "measure2" | "groupBy" | "timeGrain" | "limit" | "rowTable" | "sortColumn" | "missing" | "per" | "timeCalc">> = {
    answerKind: "answerKind",
    measure: "measure",
    measure2: "measure2",
    groupBy: "groupBy",
    timeGrain: "timeGrain",
    limit: "limit",
    rowTable: "rowTable",
    sortColumn: "sortColumn",
    missing: "missing",
    per: "per",
    timeCalc: "timeCalc",
  }
  const sep = slot.indexOf(":")
  const field = sep > 0 ? keyed[slot.slice(0, sep)] : undefined
  if (field) {
    const id = slot.slice(sep + 1)
    const record = answers[field] as Record<string, { probabilities: Record<string, number> }> | undefined
    const existing = record?.[id]
    if (record && existing) record[id] = forced(existing.probabilities, optionKey)
  } else {
    const name = single[slot]
    const existing = name ? (answers[name] as { probabilities: Record<string, number> } | undefined) : undefined
    if (name && existing) (answers as unknown as Record<string, unknown>)[name] = forced(existing.probabilities, optionKey)
  }

  const interpretation = interpretAnswers(answers, outcome.request, catalog)
  const compiled = safeCompile(interpretation.plan, catalog)
  return {
    ...outcome,
    status: interpretation.status,
    plan: interpretation.plan,
    compiled,
    confidence: interpretation.confidence,
    slots: interpretation.slots,
    alternatives: interpretation.alternatives,
    answers,
    message: interpretation.message,
  }
}

/** Lowercase a label for mid-sentence use, keeping acronyms and codes (GDP, CO2, ID) intact —
 *  same rule as compile.ts's private `lc`, duplicated here since it's tiny and self-contained. */
const lc = (s: string) => s.replace(/\S+/g, (w) => (/\d|[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()))

function catalogColumnByKey(catalog: Catalog, key: string): CatalogColumn | undefined {
  const table = key.split(".")[0]!
  return catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.key === key)
}

interface DimPick {
  key: string
  label: string
}

/** The referenced table's display column for an FK-role column, e.g. sales.store_id -> stores.name.
 *  A generic display column name ("name", "title", ...) reads far better in a starter prompt as
 *  the table it identifies ("store", "product") than as its own generic label ("Name") — every
 *  FK-linked table would otherwise read "by name" (see isGenericDisplayName's doc comment). */
function fkDisplay(catalog: Catalog, col: CatalogColumn): DimPick | undefined {
  if (!col.fk) return undefined
  const target = catalog.tables.find((t) => t.name === col.fk!.split(".")[0])
  const display = target?.columns.find((c) => c.name === target.display)
  if (!display || !target) return undefined
  const label = isGenericDisplayName(display.name) ? singularizeLabel(target.label) : display.label
  return { key: display.key, label }
}

/** The dataset's main "group by" dimension: a business dimension reached through one of the
 *  default fact's own FK columns (e.g. sales.store_id -> stores.name) when there is one, else a
 *  plain dimension column on the fact, else the first dimension anywhere. */
function mainDimension(catalog: Catalog): DimPick | undefined {
  const fact = catalog.tables.find((t) => t.name === catalog.defaultFact)
  if (fact) {
    for (const col of fact.columns) {
      if (col.role !== "fk") continue
      const hit = fkDisplay(catalog, col)
      if (hit) return hit
    }
    const own = fact.columns.find((c) => c.role === "dimension")
    if (own) return { key: own.key, label: own.label }
  }
  const col = catalog.tables.flatMap((t) => t.columns).find((c) => c.role === "dimension")
  return col ? { key: col.key, label: col.label } : undefined
}

/** A second, lower-cardinality dimension for a "Number of X by Y" prompt — distinct from the main
 *  one above, so the two starter prompts show different cuts of the data. */
function smallDimension(catalog: Catalog, exceptKey: string | undefined): DimPick | undefined {
  const fact = catalog.tables.find((t) => t.name === catalog.defaultFact)
  if (!fact) return undefined
  const candidates: (DimPick & { distinct: number })[] = []
  for (const col of fact.columns) {
    if (col.role === "dimension" && col.key !== exceptKey) candidates.push({ key: col.key, label: col.label, distinct: col.distinctCount ?? Infinity })
    if (col.role === "fk") {
      const hit = fkDisplay(catalog, col)
      const targetTable = col.fk ? catalog.tables.find((t) => t.name === col.fk!.split(".")[0]) : undefined
      if (hit && hit.key !== exceptKey) candidates.push({ ...hit, distinct: targetTable?.rowCount ?? Infinity })
    }
  }
  candidates.sort((a, b) => a.distinct - b.distinct)
  return candidates[0]
}

/** The first geo_code column's display name anywhere in the catalog, for the map starter prompt. */
function geoDimension(catalog: Catalog): DimPick | undefined {
  for (const t of catalog.tables) {
    for (const c of t.columns) {
      if (c.role !== "geo_code") continue
      return fkDisplay(catalog, c) ?? { key: c.key, label: c.label }
    }
  }
  return undefined
}

/** The "main sum" the spec's starter prompts revolve around: a curated/auto SUM metric (e.g. the
 *  auto catalog's derived "Revenue") when there is one, else any additive measure column, else
 *  whatever metric or measure is available. */
function mainMeasureLabel(catalog: Catalog): string | undefined {
  const sumMetric = catalog.metrics.find((m) => /^sum\(/i.test(m.sql.trim()))
  if (sumMetric) return sumMetric.label
  const additive = catalog.tables.flatMap((t) => t.columns).find((c) => c.role === "measure" && c.additive)
  if (additive) return additive.label
  const otherMetric = catalog.metrics.find((m) => !/^count/i.test(m.sql.trim()))
  if (otherMetric) return otherMetric.label
  const anyMeasure = catalog.tables.flatMap((t) => t.columns).find((c) => c.role === "measure")
  return anyMeasure?.label ?? catalog.metrics[0]?.label
}

const MAX_FALLBACKS = 4

/** "matches"/"seasons"/"laureates" — the plain-English plural noun the plan is about, used to
 *  phrase a fallback's reason. Catalog table labels are already plural by convention (see
 *  CatalogTable.label across every data/*.semantic.json), so this only lowercases, never
 *  re-pluralizes. Falls back to "results" when neither a row table nor a row-count measure is
 *  available to name (an aggregate over a curated metric, say). */
function subjectLabel(catalog: Catalog, plan: QueryPlan): string {
  const lc = (s: string) => s.replace(/\S+/g, (w) => (/\d|[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()))
  const tableName = plan.kind === "rows" ? plan.rowTable : plan.measure?.startsWith("n:") ? plan.measure.slice(2) : undefined
  const t = tableName ? catalog.tables.find((x) => x.name === tableName) : undefined
  return t ? lc(t.label) : "results"
}

/** Same recompiled-SQL signature `compilePlan` would produce, so two fallback candidates that
 *  happen to land on the identical query (e.g. dropping a filter that was already the least
 *  confident AND role-ambiguous) are offered only once. */
function sqlSignature(compiled: CompiledQuery | null): string | undefined {
  return compiled ? `${compiled.sql}\u0000${JSON.stringify(compiled.params)}` : undefined
}

/** The `SlotView` with the lowest confidence among those with a real runner-up to fall back to
 *  (a "Top"/limit-style slot with an empty `options` list can never supply one). */
function leastConfidentSlot(slots: SlotView[]): SlotView | undefined {
  let worst: SlotView | undefined
  for (const s of slots) {
    if (s.options.length < 2) continue
    if (!worst || s.confidence < worst.confidence) worst = s
  }
  return worst
}

/**
 * Empty-result fallbacks (no Jev call): ordered relaxations of an answered plan, each recompiled,
 * for the pipeline to try in turn when the original returns no rows (or one all-null row): a
 * role-ambiguous filter widened to "any" role, the runner-up of the least confident slot, the least
 * confident filter dropped, an out-of-range year clamped. `reason` is user-facing, e.g.
 * "No grand finals won by Fremantle; showing grand finals Fremantle played in".
 */
export function fallbackPlans(outcome: PlanOutcome, catalog: Catalog): { outcome: PlanOutcome; reason: string }[] {
  if (!outcome.plan || !outcome.compiled || !outcome.answers || !outcome.request) return []
  const originalKey = sqlSignature(outcome.compiled)
  const out: { outcome: PlanOutcome; reason: string }[] = []
  const seen = new Set<string>(originalKey ? [originalKey] : [])

  const offer = (next: PlanOutcome, reason: string) => {
    if (out.length >= MAX_FALLBACKS) return
    const key = sqlSignature(next.compiled)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ outcome: next, reason })
  }

  // (a) a value filter with a single, specific role picked -> widen it to "any" role — "played in"
  // instead of just "won"/"home games"/whichever role Jev landed on.
  for (const f of outcome.request.filters) {
    if (out.length >= MAX_FALLBACKS) break
    if (!f.roles?.length) continue
    const roleAnswer = outcome.answers.filterRoles?.[f.id]
    if (!roleAnswer || roleAnswer.value === "any") continue
    const role = f.roles.find((r) => r.key === roleAnswer.value)
    const next = applyChoice(outcome, `role:${f.id}`, "any", catalog)
    if (!next.compiled) continue
    const subject = subjectLabel(catalog, outcome.plan)
    offer(next, `No ${subject} where ${f.display} is the ${role ? role.label.toLowerCase() : "specific role"}; showing ${subject} involving ${f.display} in any role.`)
  }

  // (b) the runner-up option of the least confident slot the plan actually used (role chip
  // included — see interpret.ts).
  if (out.length < MAX_FALLBACKS) {
    const worst = leastConfidentSlot(outcome.slots)
    if (worst) {
      const runnerUp = worst.options.find((o) => o.key !== worst.value)
      if (runnerUp) {
        const next = applyChoice(outcome, worst.slot, runnerUp.key, catalog)
        if (next.compiled) offer(next, `Wasn't sure about ${worst.label.toLowerCase()} (${worst.display}); trying ${runnerUp.display} instead.`)
      }
    }
  }

  // (c) drop the least confident active filter entirely.
  if (out.length < MAX_FALLBACKS) {
    const filterSlots = outcome.slots.filter((s): s is SlotView & { slot: `filter:${string}` } => s.slot.startsWith("filter:"))
    if (filterSlots.length) {
      const worst = filterSlots.reduce((min, s) => (s.confidence < min.confidence ? s : min))
      const next = applyChoice(outcome, worst.slot, "not_a_filter", catalog)
      if (next.compiled) offer(next, `Dropped the least certain filter (${worst.display}).`)
    }
  }

  // (d) a year filter outside the column's own min/max -> clamp to the nearest year with data.
  if (out.length < MAX_FALLBACKS) {
    for (const f of outcome.plan.filters) {
      if (f.op !== "eq" && f.op !== "gte" && f.op !== "lte") continue
      const col = catalogColumnByKey(catalog, f.column)
      if (!col || (col.role !== "time" && col.role !== "date") || col.min === undefined || col.max === undefined) continue
      let changed = false
      const values = f.values.map((v) => {
        const n = Number(v)
        if (!Number.isFinite(n)) return v
        if (n < col.min!) {
          changed = true
          return col.min!
        }
        if (n > col.max!) {
          changed = true
          return col.max!
        }
        return v
      })
      if (!changed) continue
      const clamped: PlanFilter = { ...f, values, label: f.label.replace(/-?\d+/, String(values[0])) }
      const nextPlan: QueryPlan = { ...outcome.plan, filters: outcome.plan.filters.map((flt) => (flt === f ? clamped : flt)) }
      const compiled = safeCompile(nextPlan, catalog)
      if (!compiled) continue
      const next: PlanOutcome = { ...outcome, plan: nextPlan, compiled }
      offer(next, `${f.label} was outside the data's range; clamped to ${values[0]}.`)
      break
    }
  }

  return out
}

/**
 * Deterministic starter prompts for an uploaded dataset (bundled ones use catalog.tryPrompts).
 * 5-6 plain-English, sentence-case prompts built only from the catalog: a main sum by a dimension
 * reached through an FK, a ranking, a trend (by month when there's a real date column, else over
 * time), a count broken down by a small dimension, a share, and a map when a geo_code exists.
 */
export function suggestPrompts(catalog: Catalog, n = 6): TryPrompt[] {
  if (catalog.tryPrompts.length) return catalog.tryPrompts.slice(0, n)

  const prompts: TryPrompt[] = []
  const measure = mainMeasureLabel(catalog)
  const dim = mainDimension(catalog)
  const fact = catalog.tables.find((t) => t.name === catalog.defaultFact)

  if (measure && dim) prompts.push({ text: `${measure} by ${lc(dim.label)}`, chart: "bar" })

  if (measure && dim) {
    const rankTable = catalog.tables.find((t) => t.name === dim.key.split(".")[0])
    if (rankTable) prompts.push({ text: `Top 5 ${rankTable.label.toLowerCase()} by ${lc(measure)}`, chart: "hbar" })
  }

  const nearest = fact ? nearestTimeColumn(catalog, fact.name) : undefined
  const timeCol = nearest ? catalogColumnByKey(catalog, nearest.key) : undefined
  if (measure && timeCol?.role === "date") prompts.push({ text: `${measure} by month`, chart: "line" })
  else if (measure && timeCol?.role === "time") prompts.push({ text: `${measure} over time`, chart: "line" })

  if (fact) {
    const small = smallDimension(catalog, dim?.key)
    if (small) prompts.push({ text: `Number of ${lc(fact.label)} by ${lc(small.label)}`, chart: "bar" })
  }

  if (measure && dim) prompts.push({ text: `Share of ${lc(measure)} by ${lc(dim.label)}`, chart: "donut" })

  const geo = geoDimension(catalog)
  if (measure && geo) prompts.push({ text: `${measure} by ${lc(geo.label)}`, chart: "choropleth" })

  return prompts.slice(0, n)
}

/**
 * OWNER: implementer A (filters). Turns the filter-ish answers (value / year / "now" candidates,
 * FK roles, and v0.2: ranges, periods, thresholds, text search, or-pairs, missing data, rank
 * windows, share-of) into the plan's WHERE filters, HAVING filters, share spec and rank window,
 * plus the chips ("slots") that explain them. interpret.ts calls the exported functions below and
 * never builds a filter itself.
 */
import type { FilterCandidate, HavingFilter, OptionText, PeriodUnit, PlanAnswers, PlanFilter, PlanRequest, QueryPlan } from "@shared/contract"
import { topOptions, type SlotView } from "./slots"

type FilterGroup = { column: string; field: string; values: (string | number)[]; ids: string[]; via?: string[] }

/** How a merged year/"now" group reads in a chip: "the latest year" for the "latest" placeholder
 *  (resolved to a real year at compile time — see compile.ts's resolveNowPlaceholders), the plain
 *  number otherwise. */
const yearValueLabel = (v: string | number) => (v === "latest" ? "the latest year" : String(v))

/** A period's plan label, e.g. "Last 10 years of data", "Year to date". */
function periodFilterLabel(n: number, unit: PeriodUnit): string {
  if (unit === "ytd") return "Year to date"
  const unitWord = n === 1 ? unit : `${unit}s`
  return `Last ${n} ${unitWord} of data`
}

function optionWhat(t: OptionText): string {
  return typeof t === "string" ? t : t.what
}
function sortColumnLabel(req: PlanRequest, key: string): string {
  const opt = req.sortColumns[key]
  return opt ? optionWhat(opt) : key
}
function textColumnLabel(req: PlanRequest, key: string): string {
  if (key === "not_a_filter") return "not a filter"
  const opt = req.textColumns?.[key]
  return opt ? optionWhat(opt) : key
}
function thresholdOptionText(req: PlanRequest, key: string): string {
  if (key === "agg") return "the calculated amount"
  if (key === "not_a_filter") return "not a filter"
  return sortColumnLabel(req, key)
}
function nullableColumnLabel(req: PlanRequest, key: string): string {
  const opt = req.nullableColumns?.[key]
  return opt ? optionWhat(opt) : key
}
/** "<column key>:missing" / "<column key>:present" -> its parts. Column keys are always
 *  `table.column` (dots, never colons), so splitting on the LAST colon is safe. */
function splitMissingAnswer(value: string): { key: string; state: "missing" | "present" } | undefined {
  const idx = value.lastIndexOf(":")
  if (idx === -1) return undefined
  const state = value.slice(idx + 1)
  if (state !== "missing" && state !== "present") return undefined
  return { key: value.slice(0, idx), state }
}
function missingOptionText(req: PlanRequest, key: string): string {
  if (key === "none") return "not mentioned"
  const parsed = splitMissingAnswer(key)
  if (!parsed) return key
  return `${nullableColumnLabel(req, parsed.key)} ${parsed.state === "missing" ? "is missing" : "is recorded"}`
}

/** For a value candidate whose table plays several roles in the fact (see FilterCandidate.roles
 *  and graph.ts's fkRoleGroupFor): the one FK column Jev picked, or every role's FK column for
 *  "any" (or no role answer at all — a safe default matching the old any-role reading of
 *  "played"). Undefined for a candidate with no roles at all, which keeps the plain default join
 *  path (compile.ts's ordinary `col.table` lookup) completely untouched. Shared by buildFilters
 *  and buildShare so a "share" answer resolves through the same role as an "include_only" one would. */
function viaFor(c: FilterCandidate, answers: PlanAnswers): string[] | undefined {
  if (!c.roles?.length) return undefined
  const chosen = answers.filterRoles?.[c.id]?.value
  if (chosen && chosen !== "any") {
    const hit = c.roles.find((r) => r.key === chosen)
    if (hit) return [hit.key]
  }
  return c.roles.map((r) => r.key)
}

/**
 * Builds the plan filters, merging candidates that share a column, an op AND the same role
 * resolution into one IN/NOT IN: include_only/exclude value candidates, and same-column in_year
 * candidates ("2000 vs 2020" -> one `year IN (2000, 2020)`, not two contradictory equalities).
 * from/until/before/after stay per-candidate range bounds. v0.2 adds: range/period candidates,
 * threshold candidates whose target is a record field (a sortColumns key -> WHERE), text
 * fragments (-> LIKE), a value candidate answered "share" is deliberately NOT added here (see
 * buildShare), the missing-data slot (-> IS NULL/NOT NULL), and combine "either" pairs grouped
 * for buildWhere's OR handling.
 */
export function buildFilters(answers: PlanAnswers, req: PlanRequest): PlanFilter[] {
  const includeGroups = new Map<string, FilterGroup>()
  const excludeGroups = new Map<string, FilterGroup>()
  const yearInGroups = new Map<string, FilterGroup>()
  const filters: PlanFilter[] = []

  const addTo = (groups: Map<string, FilterGroup>, groupKey: string, column: string, field: string, value: string | number, id: string, via?: string[]) => {
    const g = groups.get(groupKey) ?? { column, field, values: [], ids: [], via }
    g.values.push(value)
    g.ids.push(id)
    groups.set(groupKey, g)
  }

  /** The chosen role's own label ("Winner"), for a nicer chip/subtitle than the generic field
   *  label ("Club") — undefined for "any"/no roles, which keeps the plain field label. */
  const roleLabelFor = (c: FilterCandidate): string | undefined => {
    const chosen = answers.filterRoles?.[c.id]?.value
    if (!chosen || chosen === "any") return undefined
    return c.roles?.find((r) => r.key === chosen)?.label
  }

  // Two or more bare years (or a relative "now"/"latest" mention alongside one) on the SAME column
  // ("2000 vs 2020", "population now vs 1986") are structurally parallel — each filter Choice
  // answers independently, so it's easy for Jev to land one confidently on "in_year" and waffle
  // the other to "not_a_filter" even though they're clearly meant together. Unless any of them is
  // a real range bound (from/until/before/after), trust the parallel structure: one confident
  // "in_year" promotes the rest of that column's bare-year/"now" mentions too.
  const yearCandidatesByColumn = new Map<string, FilterCandidate[]>()
  for (const c of req.filters) {
    if (c.kind !== "year" && c.kind !== "now") continue
    const list = yearCandidatesByColumn.get(c.column) ?? []
    list.push(c)
    yearCandidatesByColumn.set(c.column, list)
  }
  const promoteToInYear = new Set<string>()
  for (const list of yearCandidatesByColumn.values()) {
    if (list.length < 2) continue
    const uses = list.map((c) => answers.filters[c.id]?.value)
    if (uses.some((u) => u === "from" || u === "until" || u === "before" || u === "after")) continue
    // Use the probability, not the argmax: "2000 vs 2020" often lands near 50/50 per year.
    const inYearP = (c: FilterCandidate) => answers.filters[c.id]?.probabilities.in_year ?? 0
    if (uses.some((u) => u === "in_year") || list.some((c) => inYearP(c) >= 0.3)) for (const c of list) promoteToInYear.add(c.id)
  }

  for (const c of req.filters) {
    const a = answers.filters[c.id]
    if (!a) continue

    if (c.kind === "year" || c.kind === "now") {
      // A "now" candidate's value is the "latest" placeholder (resolved to a real year at compile
      // time by compile.ts's resolveNowPlaceholders); a "year" candidate's is a real year number.
      const value: string | number = c.kind === "now" ? c.value : Number(c.value)
      const use = promoteToInYear.has(c.id) ? "in_year" : a.value
      if (use === "in_year") addTo(yearInGroups, c.column, c.column, c.field, value, c.id)
      else if (a.value === "from") filters.push({ column: c.column, op: "gte", values: [value], label: `${c.field} from ${yearValueLabel(value)}`, candidateId: c.id })
      else if (a.value === "until") filters.push({ column: c.column, op: "lte", values: [value], label: `${c.field} until ${yearValueLabel(value)}`, candidateId: c.id })
      else if (a.value === "before") filters.push({ column: c.column, op: "lt", values: [value], label: `${c.field} before ${yearValueLabel(value)}`, candidateId: c.id })
      else if (a.value === "after") filters.push({ column: c.column, op: "gt", values: [value], label: `${c.field} after ${yearValueLabel(value)}`, candidateId: c.id })
      continue
    }

    if (c.kind === "range") {
      if (a.value === "not_a_filter") continue
      const start = Number(c.value)
      const end = Number(c.value2)
      if (a.value === "between") {
        filters.push({ column: c.column, op: "between", values: [start, end], label: `${c.field} between ${start} and ${end}`, candidateId: c.id })
      } else if (a.value === "separately") {
        filters.push({ column: c.column, op: "in", values: [start, end], label: `${c.field} is ${start} or ${end}`, candidateId: c.id })
      }
      continue
    }

    if (c.kind === "period") {
      if (a.value !== "within") continue
      const n = Number(c.value)
      const unit = c.unit!
      filters.push({ column: c.column, op: "within", values: [], label: periodFilterLabel(n, unit), candidateId: c.id, period: { n, unit } })
      continue
    }

    // kind "value" (share is handled by buildShare, not here — it is never a WHERE filter)
    if (a.value === "share") continue
    const via = viaFor(c, answers)
    const field = roleLabelFor(c) ?? c.field
    // A candidate with roles resolving to different FK paths cannot share one IN-list with another
    // candidate on the same column but a different role — key the group by column + via so "Fitzroy
    // won" and "Collingwood lost" stay two separate filters even though both name `clubs.name`.
    const groupKey = via ? `${c.column}::${via.join(",")}` : c.column
    if (a.value === "include_only") addTo(includeGroups, groupKey, c.column, field, c.value, c.id, via)
    else if (a.value === "exclude") addTo(excludeGroups, groupKey, c.column, field, c.value, c.id, via)
  }

  for (const g of yearInGroups.values()) {
    const op = g.values.length > 1 ? "in" : "eq"
    filters.push({ column: g.column, op, values: g.values, label: `${g.field} is ${g.values.map(yearValueLabel).join(" or ")}`, candidateId: g.ids[0] })
  }
  for (const g of includeGroups.values()) {
    filters.push({ column: g.column, op: "in", values: g.values, label: `${g.field} is ${g.values.join(" or ")}`, candidateId: g.ids[0], via: g.via })
  }
  for (const g of excludeGroups.values()) {
    // 1 value -> neq, several -> not_in; where.ts keeps NULL rows for both.
    const op = g.values.length === 1 ? "neq" : "not_in"
    filters.push({ column: g.column, op, values: g.values, label: `${g.field} is not ${g.values.join(" or ")}`, candidateId: g.ids[0], via: g.via })
  }

  // v0.2: thresholds whose chosen target is a record field (a sortColumns key) -> a WHERE filter.
  // "agg" (the calculated amount per group) goes to buildHavingFilters instead; "not_a_filter"
  // drops the candidate.
  for (const t of req.thresholds ?? []) {
    const a = answers.thresholds?.[t.id]
    if (!a || a.value === "not_a_filter" || a.value === "agg") continue
    const column = a.value
    filters.push({ column, op: t.op, values: t.values, label: `${sortColumnLabel(req, column)} ${t.display}`, candidateId: t.id })
  }

  // v0.2: text fragments -> LIKE, on the chosen text column.
  for (const x of req.texts ?? []) {
    const a = answers.texts?.[x.id]
    if (!a || a.value === "not_a_filter") continue
    const verb = x.mode === "starts" ? "starts with" : x.mode === "ends" ? "ends with" : "contains"
    filters.push({ column: a.value, op: "like", values: [x.value], label: `${textColumnLabel(req, a.value)} ${verb} '${x.value}'`, candidateId: x.id, pattern: x.mode })
  }

  // v0.2: missing-data slot -> IS NULL / IS NOT NULL. Only adopted when Jev's top probability for
  // the chosen state is reasonably confident (>= 0.5) — otherwise the row set stays unrestricted.
  if (answers.missing && answers.missing.value !== "none" && answers.missing.confidence >= 0.5) {
    const parsed = splitMissingAnswer(answers.missing.value)
    if (parsed && req.nullableColumns?.[parsed.key]) {
      const op = parsed.state === "missing" ? "is_null" : "not_null"
      filters.push({ column: parsed.key, op, values: [], label: `${nullableColumnLabel(req, parsed.key)} is ${parsed.state === "missing" ? "missing" : "recorded"}` })
    }
  }

  // v0.2: combine "either" — both candidates' resulting filters (if both are still active) share a
  // group id so buildWhere puts them in one `(a OR b)` clause instead of AND-ing them. "both"
  // needs no grouping: plain AND is already the default. Candidates on the same column never reach
  // here as separate filters (they already merged into one IN list above), matching findOrPairs's
  // own different-column requirement.
  for (const pair of req.orPairs ?? []) {
    const a = answers.combine?.[pair.id]
    if (!a || a.value !== "either") continue
    const fa = filters.find((f) => f.candidateId === pair.a)
    const fb = filters.find((f) => f.candidateId === pair.b)
    if (!fa || !fb) continue
    fa.group = pair.id
    fb.group = pair.id
  }

  return filters
}

/** The chips for every active filter candidate (and its FK role), plus v0.2: thresholds, texts,
 *  combine and rank-window candidates, the missing slot, and confidences the plan used. */
export function filterSlotViews(answers: PlanAnswers, req: PlanRequest): { slots: SlotView[]; confidences: number[] } {
  const slots: SlotView[] = []
  const confidences: number[] = []

  const useText: Record<string, string> = { include_only: "only", exclude: "excluding", share: "share of", in_year: "in", from: "from", until: "until", before: "before", after: "after" }
  const rangeText: Record<string, string> = { between: "as a span", separately: "each year separately", not_a_filter: "not a filter" }
  const periodText: Record<string, string> = { within: "within the period", not_a_filter: "not a filter" }

  for (const c of req.filters) {
    const a = answers.filters[c.id]
    if (!a || a.value === "not_a_filter") continue
    confidences.push(a.confidence)

    if (c.kind === "range") {
      const display = a.value === "between" ? `${c.field} between ${c.value} and ${c.value2}` : `${c.field} is ${c.value} or ${c.value2}`
      slots.push({ slot: `filter:${c.id}`, label: "Filter", value: a.value, display, confidence: a.confidence, options: topOptions(a.probabilities, (k) => rangeText[k] ?? k) })
      continue
    }
    if (c.kind === "period") {
      const display = a.value === "within" ? periodFilterLabel(Number(c.value), c.unit!) : `${c.display} not a filter`
      slots.push({ slot: `filter:${c.id}`, label: "Filter", value: a.value, display, confidence: a.confidence, options: topOptions(a.probabilities, (k) => periodText[k] ?? k) })
      continue
    }

    const isShare = a.value === "share"
    slots.push({
      slot: `filter:${c.id}`,
      label: isShare ? "Share" : "Filter",
      value: a.value,
      display: isShare ? `Share of ${c.field.toLowerCase()} that is ${c.display}` : `${c.field}: ${useText[a.value] ?? a.value} ${c.display}`,
      confidence: a.confidence,
      options: topOptions(a.probabilities, (k) => useText[k] ?? k),
    })
  }

  // A role chip only for a filter candidate that's actually active (not "not_a_filter") and has
  // roles at all — the "which part does it play" pick behind that filter's chip.
  const roleTextOf = (c: FilterCandidate, k: string) => (k === "any" ? "any role" : (c.roles?.find((r) => r.key === k)?.label ?? k))
  for (const c of req.filters) {
    if (!c.roles?.length) continue
    const filterAnswer = answers.filters[c.id]
    if (!filterAnswer || filterAnswer.value === "not_a_filter") continue
    const roleAnswer = answers.filterRoles?.[c.id]
    if (!roleAnswer) continue
    confidences.push(roleAnswer.confidence)
    slots.push({
      slot: `role:${c.id}`,
      label: "As",
      value: roleAnswer.value,
      display: roleTextOf(c, roleAnswer.value),
      confidence: roleAnswer.confidence,
      options: topOptions(roleAnswer.probabilities, (k) => roleTextOf(c, k)),
    })
  }

  // v0.2: thresholds -> "Filter" chips ("Crowd > 50,000", "Total > 200").
  for (const t of req.thresholds ?? []) {
    const a = answers.thresholds?.[t.id]
    if (!a || a.value === "not_a_filter") continue
    confidences.push(a.confidence)
    const targetLabel = a.value === "agg" ? "Total" : sortColumnLabel(req, a.value)
    slots.push({
      slot: `threshold:${t.id}`,
      label: "Filter",
      value: a.value,
      display: `${targetLabel} ${t.display}`,
      confidence: a.confidence,
      options: topOptions(a.probabilities, (k) => thresholdOptionText(req, k)),
    })
  }

  // v0.2: text fragments -> "Search" chips ("Title contains 'love'").
  for (const x of req.texts ?? []) {
    const a = answers.texts?.[x.id]
    if (!a || a.value === "not_a_filter") continue
    confidences.push(a.confidence)
    const verb = x.mode === "starts" ? "starts with" : x.mode === "ends" ? "ends with" : "contains"
    slots.push({
      slot: `text:${x.id}`,
      label: "Search",
      value: a.value,
      display: `${textColumnLabel(req, a.value)} ${verb} '${x.value}'`,
      confidence: a.confidence,
      options: topOptions(a.probabilities, (k) => textColumnLabel(req, k)),
    })
  }

  // v0.2: combine (or-pairs) -> "Compare" chips.
  for (const pair of req.orPairs ?? []) {
    const a = answers.combine?.[pair.id]
    if (!a) continue
    confidences.push(a.confidence)
    const fa = req.filters.find((f) => f.id === pair.a)
    const fb = req.filters.find((f) => f.id === pair.b)
    const joiner = a.value === "either" ? "or" : "and"
    slots.push({
      slot: `combine:${pair.id}`,
      label: "Compare",
      value: a.value,
      display: `${fa?.display ?? pair.a} ${joiner} ${fb?.display ?? pair.b}`,
      confidence: a.confidence,
      options: topOptions(a.probabilities, (k) => (k === "either" ? "either" : "both")),
    })
  }

  // v0.2: rank windows -> "Ranks" chips.
  for (const w of req.rankWindows ?? []) {
    const a = answers.rankWindows?.[w.id]
    if (!a || a.value === "not_a_filter") continue
    confidences.push(a.confidence)
    slots.push({
      slot: `window:${w.id}`,
      label: "Ranks",
      value: a.value,
      display: `Ranks ${w.from}–${w.to}`,
      confidence: a.confidence,
      options: topOptions(a.probabilities, (k) => (k === "window" ? `Ranks ${w.from}–${w.to}` : "not a window")),
    })
  }

  // v0.2: the missing slot -> a "Missing" chip.
  if (answers.missing && answers.missing.value !== "none") {
    confidences.push(answers.missing.confidence)
    slots.push({
      slot: "missing",
      label: "Missing",
      value: answers.missing.value,
      display: missingOptionText(req, answers.missing.value),
      confidence: answers.missing.confidence,
      options: topOptions(answers.missing.probabilities, (k) => missingOptionText(req, k)),
    })
  }

  return { slots, confidences }
}

/** Thresholds Jev pointed at the calculated amount ("agg") -> HAVING. Empty when none. */
export function buildHavingFilters(answers: PlanAnswers, req: PlanRequest): HavingFilter[] {
  const having: HavingFilter[] = []
  for (const t of req.thresholds ?? []) {
    const a = answers.thresholds?.[t.id]
    if (!a || a.value !== "agg") continue
    having.push({ op: t.op, values: t.values, label: `Total ${t.display}`, candidateId: t.id })
  }
  return having
}

/** A value candidate answered "share" -> the plan's share spec (numerator condition), merging
 *  several same-column "share" answers into one (e.g. "share of physics or chemistry laureates").
 *  `QueryPlan.share` is a single spec, so when candidates on DIFFERENT columns were both answered
 *  "share" (an ambiguous question), the first one found wins — a deliberate, documented choice. */
export function buildShare(answers: PlanAnswers, req: PlanRequest): QueryPlan["share"] {
  const groups = new Map<string, FilterGroup>()
  for (const c of req.filters) {
    if (c.kind !== "value") continue
    const a = answers.filters[c.id]
    if (!a || a.value !== "share") continue
    const via = viaFor(c, answers)
    const key = via ? `${c.column}::${via.join(",")}` : c.column
    const g = groups.get(key) ?? { column: c.column, field: c.field, values: [], ids: [], via }
    g.values.push(c.value)
    g.ids.push(c.id)
    groups.set(key, g)
  }
  // One share per plan: when values on different columns were all read as "share" ("what share of
  // the world's X is in V"), the most confidently-share one is the part; the others name the whole.
  const shareP = (g: FilterGroup) => Math.max(...g.ids.map((id) => answers.filters[id]?.probabilities.share ?? 0))
  const best = [...groups.values()].sort((a, b) => shareP(b) - shareP(a))[0]
  if (!best) return undefined
  return { column: best.column, values: best.values, label: `${best.field} is ${best.values.join(" or ")}`, via: best.via, candidateId: best.ids[0] }
}

/** A rank window answered "window" -> offset + limit ("ranked 11 to 20" -> offset 10, limit 10).
 *  Only one window can apply to a plan's single offset/limit — the first active one wins. */
export function rankWindow(answers: PlanAnswers, req: PlanRequest): { offset: number; limit: number } | undefined {
  for (const w of req.rankWindows ?? []) {
    const a = answers.rankWindows?.[w.id]
    if (!a || a.value !== "window") continue
    return { offset: w.from - 1, limit: w.to - w.from + 1 }
  }
  return undefined
}

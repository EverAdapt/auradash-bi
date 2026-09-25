#!/usr/bin/env bun
/**
 * OWNER: planner. Dev CLI: runs the full plan pipeline against a bundled dataset, calling Jev
 * directly (no Worker), executing the compiled SQL with bun:sqlite, and printing everything.
 *
 *   bun scripts/plan-cli.ts --dataset nobel "How many women have won a Nobel Prize?"
 *   bun scripts/plan-cli.ts --all                 # every tryPrompt of both catalogs
 *   bun scripts/plan-cli.ts --extra                # 10+ hand-written questions per dataset
 *   bun scripts/plan-cli.ts --v02 [filters|calc|agnostic]   # v0.2 feature questions (SQL expectations)
 *   bun scripts/plan-cli.ts --dataset world "..." --offline   # force the offline planner
 */
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import path from "node:path"
import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { Catalog, Cell, JevMeta, PlanAnswers } from "@shared/contract"
import { normalizePlanAnswers, planQuestions, planState, type RawPlanAnswers } from "@shared/jev/questions"
import { tryResults } from "@/fixtures"
import { findCandidates } from "@/lib/plan/candidates"
import { compilePlan } from "@/lib/plan/compile"
import { interpretAnswers } from "@/lib/plan/interpret"
import { fallbackPlans, type PlanOutcome } from "@/lib/plan"
import { offlineAnswers } from "@/lib/plan/offline"
import { buildPlanRequest } from "@/lib/plan/request"
import { bundledDatasetIds } from "./datasets"
import { QUESTIONS as V02_AGNOSTIC } from "./questions/agnostic"
import { QUESTIONS as V02_CALC } from "./questions/calc"
import { QUESTIONS as V02_FILTERS } from "./questions/filters"
import type { V02Question } from "./questions/types"

const ROOT = path.resolve(import.meta.dir, "..")

function loadDevVars(): Record<string, string> {
  try {
    const text = readFileSync(path.join(ROOT, ".dev.vars"), "utf8")
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "")
    }
    return out
  } catch {
    return {}
  }
}

function loadCatalog(id: string): Catalog {
  return JSON.parse(readFileSync(path.join(ROOT, "public", "data", `${id}.catalog.json`), "utf8")) as Catalog
}

const devVars = loadDevVars()
const apiKey = devVars.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY
const model = devVars.JEV_MODEL ?? process.env.JEV_MODEL ?? "jev-latest"
const jev = apiKey ? new TypeSafeClient({ apiKey, defaultModel: model, timeout: 4000, retry: { maxRetries: 0 } }) : undefined

const dbCache = new Map<string, Database>()
function db(id: string): Database {
  let d = dbCache.get(id)
  if (!d) {
    d = new Database(path.join(ROOT, "data", `${id}.sqlite`), { readonly: true })
    dbCache.set(id, d)
  }
  return d
}

function fmtProb(p: Record<string, number>, n = 3): string {
  return Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join(" ")
}

function printAnswers(a: PlanAnswers) {
  console.log(`    in_scope=${a.inScope.toFixed(2)} answerKind=${a.answerKind.value}(${a.answerKind.confidence.toFixed(2)}) [${fmtProb(a.answerKind.probabilities)}]`)
  console.log(`    measure=${a.measure.value}(${a.measure.confidence.toFixed(2)}) measure2=${a.measure2.value} groupBy=${a.groupBy.value} timeGrain=${a.timeGrain.value}`)
  console.log(`    sort=${a.sort.value} limit=${a.limit.value} rowTable=${a.rowTable.value} sortColumn=${a.sortColumn.value} namedChart=${a.namedChart.value}`)
  for (const [id, f] of Object.entries(a.filters)) console.log(`    filter:${id} -> ${f.value} [${fmtProb(f.probabilities)}]`)
  for (const [id, f] of Object.entries(a.filterRoles ?? {})) console.log(`    role:${id} -> ${f.value} [${fmtProb(f.probabilities)}]`)
  // v0.2
  for (const [name, rec] of [["threshold", a.thresholds], ["text", a.texts], ["combine", a.combine], ["window", a.rankWindows]] as const)
    for (const [id, f] of Object.entries(rec ?? {})) console.log(`    ${name}:${id} -> ${f.value} [${fmtProb(f.probabilities)}]`)
  for (const [name, f] of [["missing", a.missing], ["per", a.per], ["timeCalc", a.timeCalc]] as const) if (f) console.log(`    ${name} -> ${f.value} [${fmtProb(f.probabilities)}]`)
}

interface RunResult {
  ok: boolean
  status: string
  rowCount: number
  sql?: string
  error?: string
}

async function runOne(datasetId: string, question: string, opts: { offline: boolean }): Promise<RunResult> {
  const catalog = loadCatalog(datasetId)
  const candidates = findCandidates(question, catalog)
  const req = buildPlanRequest(question, catalog, candidates)

  let answers: PlanAnswers
  let meta: JevMeta
  const t0 = performance.now()
  if (!opts.offline && jev) {
    const questions = planQuestions(req)
    try {
      const res = await jev.systemOne({ state: planState(req), questions })
      meta = { source: "jev", model: res.model, latencyMs: Math.round(performance.now() - t0), questionCount: Object.keys(questions).length }
      answers = normalizePlanAnswers(res.answers as unknown as RawPlanAnswers, req)
    } catch (err) {
      console.log(`    [jev error, falling back to offline] ${err instanceof Error ? err.message : err}`)
      answers = offlineAnswers(req)
      meta = { source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason: "jev_error" }
    }
  } else {
    answers = offlineAnswers(req)
    meta = { source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason: opts.offline ? "forced" : "no_key" }
  }

  console.log(`\n=== [${datasetId}] "${question}" (${meta.source}, ${meta.latencyMs}ms, q=${meta.questionCount}) ===`)
  console.log(`  filters found: ${candidates.filters.map((f) => `${f.kind}:${f.display}(${f.column})`).join(", ") || "(none)"}  numbers: ${candidates.numbers.join(",") || "(none)"}`)
  const extra = [
    ...candidates.thresholds.map((t) => `threshold:${t.op} ${t.values.join("..")} "${t.matched}"`),
    ...candidates.texts.map((t) => `text:${t.mode} "${t.value}"`),
    ...candidates.orPairs.map((o) => `or:${o.a}|${o.b}`),
    ...candidates.rankWindows.map((w) => `window:${w.from}-${w.to}`),
    ...Object.entries(candidates.cues).filter(([, v]) => v).map(([k]) => `cue:${k}`),
  ]
  if (extra.length) console.log(`  v0.2 found: ${extra.join(", ")}`)
  printAnswers(answers)

  const interpretation = interpretAnswers(answers, req, catalog)
  console.log(`  status=${interpretation.status} confidence=${interpretation.confidence.toFixed(2)}${interpretation.message ? ` message="${interpretation.message}"` : ""}`)
  if (interpretation.alternatives.length) {
    console.log(`  alternatives: ${interpretation.alternatives.map((a) => `${a.text} (${a.p.toFixed(2)})`).join(" | ")}`)
  }
  if (!interpretation.plan) {
    return { ok: interpretation.status === "out_of_scope", status: interpretation.status, rowCount: 0 }
  }
  console.log(`  plan: ${JSON.stringify(interpretation.plan)}`)

  try {
    const compiled = compilePlan(interpretation.plan, catalog)
    console.log(`  sql: ${compiled.sql}`)
    console.log(`  params: ${JSON.stringify(compiled.params)}`)
    console.log(`  displaySql: ${compiled.displaySql}`)
    console.log(`  title: ${compiled.title}${compiled.subtitle ? ` (${compiled.subtitle})` : ""}`)
    const stmt = db(datasetId).query(compiled.sql)
    const rows = stmt.all(...(compiled.params as Cell[])) as Record<string, unknown>[]
    console.log(`  rows: ${rows.length}  columns: ${compiled.columns.map((c) => `${c.name}:${c.kind}`).join(", ")}`)
    console.log(`  first rows: ${JSON.stringify(rows.slice(0, 5))}`)

    const fixture = tryResults.find((f) => f.datasetId === datasetId && f.text.toLowerCase() === question.trim().toLowerCase())
    if (fixture) {
      const match = rows.length === fixture.result.rows.length
      console.log(`  fixture: expected ${fixture.result.rows.length} rows, ${fixture.result.columns.join(",")} -> ${match ? "OK (row count matches)" : "DIFFERS"}`)
    }

    const isEmpty = rows.length === 0 || (rows.length === 1 && Object.values(rows[0]!).every((v) => v === null))
    if (isEmpty) {
      const outcome: PlanOutcome = {
        status: interpretation.status,
        question,
        plan: interpretation.plan,
        compiled,
        confidence: interpretation.confidence,
        slots: interpretation.slots,
        alternatives: interpretation.alternatives,
        answers,
        request: req,
        meta,
        message: interpretation.message,
      }
      const fallbacks = fallbackPlans(outcome, catalog)
      console.log(`  empty result -> ${fallbacks.length} fallback(s)`)
      for (const fb of fallbacks) {
        if (!fb.outcome.compiled) continue
        const fbStmt = db(datasetId).query(fb.outcome.compiled.sql)
        const fbRows = fbStmt.all(...(fb.outcome.compiled.params as Cell[])) as Record<string, unknown>[]
        console.log(`    fallback: ${fb.reason}`)
        console.log(`      sql: ${fb.outcome.compiled.sql}`)
        console.log(`      rows: ${fbRows.length}`)
        if (fbRows.length > 0) {
          console.log(`      first rows: ${JSON.stringify(fbRows.slice(0, 5))}`)
          break
        }
      }
    }

    return { ok: true, status: interpretation.status, rowCount: rows.length, sql: compiled.sql }
  } catch (err) {
    console.log(`  COMPILE/SQL ERROR: ${err instanceof Error ? err.stack : err}`)
    return { ok: false, status: "error", rowCount: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// Keyed by dataset id; a dataset with no entry here (a new one landing at merge — see
// scripts/datasets.ts's bundledDatasetIds) just runs with none, rather than crashing --extra.
const EXTRA_QUESTIONS: Record<string, string[]> = {
  nobel: [
    // joins + simple filter
    "How many Nobel prizes has France won?",
    // negation, single value
    "Prizes by category excluding literature",
    // negation, multiple values
    "Laureates excluding the United States and United Kingdom",
    // include, multiple values
    "Nobel prizes in physics or chemistry",
    "Laureates born in France or Germany",
    // top/bottom N
    "Top 5 countries by laureates born there",
    "Bottom 5 categories by number of laureates",
    "Which universities have the most Nobel laureates?",
    "Which country has won the most peace prizes?",
    // filter + aggregate
    "Average age at award for women",
    "Physics laureates born in Germany",
    "How many organisations have won a Nobel Prize?",
    // year filters (until/from)
    "Nobel prizes awarded before 1950",
    "Peace prize winners since 2000",
    // rows, listing, sorted
    "List the oldest laureates",
    "Show me laureates who declined their prize",
    // rows + filter + year
    "Who won the peace prize in 2020?",
    // trend over time
    "How has the average age at award changed over time?",
    // per-decade grain
    "Prizes per decade",
    "Physics laureates by decade",
    "Nobel laureates by birth decade",
    // distribution
    "Distribution of prize shares",
    // relationship
    "Is there a relationship between age at award and prize money?",
    // map / group-by-country
    "Institutions by country",
    // out of scope
    "What's the weather in Paris tomorrow?",
    "What's the capital of Japan?",
    // typos
    "laureats born in Grmany",
    // numeric threshold (out of scope for v1 — should degrade gracefully, not crash)
    "How many people won a Nobel prize before turning 30?",
    // relative time ("now"/"latest") and year comparisons
    "Laureates born in the latest decade",
    "Between 1950 and 1970 how many prizes per category",
    "Physics prizes since 2000",
    "Nobel prizes this year compared to 1950",
    "Laureates born since 1990",
    "Peace prizes in 2000 and 2020",
    "Prizes awarded until 1950",
  ],
  world: [
    // joins + simple filter
    "Population of Nigeria",
    // named entities on one measure (not a relationship)
    "GDP per person in Japan vs China",
    "Life expectancy in Australia vs Japan",
    // negation, single + multiple values
    "CO2 emissions excluding China",
    "Countries excluding China and India",
    // include, multiple values
    "Renewable energy in France or Germany",
    // top/bottom N
    "Countries with the lowest life expectancy",
    "Top 5 countries by population",
    "Top 3 countries by GDP",
    "Bottom 10 countries by life expectancy",
    "Which country has the most forest cover?",
    "Which region has the highest infant mortality?",
    // year filter
    "Internet users in 2010",
    // group-by dimension
    "Fertility rate by income group",
    "Health spending by region",
    // trend over time
    "Urban population trend in Brazil",
    "How has global population grown since 1960?",
    "Fertility rate trend in India",
    // per-decade grain
    "GDP per person per decade",
    // distribution
    "Distribution of GDP per capita",
    // relationship
    "Is there a link between renewable energy and CO2 emissions?",
    // map / group-by-country
    "Electricity access in Sub-Saharan Africa",
    // grouped comparison across years
    "Urban population by income group since 1990",
    // out of scope
    "What's the capital of France?",
    "What's the population of Mars?",
    // typos
    "populaton of Nigeria",
    // relative time ("now"/"latest") and year comparisons
    "Population now compared to 1986",
    "World population now vs 1960",
    "Life expectancy today compared to 1960",
    "CO2 emissions in 1990 and 2020 by region",
    "GDP per person since 2000 for Brazil",
    "Renewable energy between 1990 and 2010",
    "Internet users right now",
  ],
  afl: [
    // FK roles: "played in" -> any role (home OR away OR winner OR loser)
    "When was the last time Fremantle played a grand final?",
    // FK roles: "won" -> the winner role only; this one is empty (Fremantle never won a GF) and
    // should trigger fallback (a), widening to "any role" and finding the 2013 GF they played in.
    "When did Fremantle last win a grand final?",
    // FK roles: "any" vs "won" give different (correct) counts for the same club
    "How many grand final matches has Collingwood played in?",
    "How many grand final matches has Collingwood won?",
    // FK roles: one specific role (home) plus an unrelated single-FK filter (venue)
    "Richmond home games at the MCG",
    // FK roles: the loser role specifically
    "Which club has the most grand final losses?",
    // FK roles: the winner role specifically, ranked by margin — rows + listColumns
    // (Hawthorn, not Geelong: "Geelong" also names a venue city — see followUps, a pre-existing
    // candidates.ts ambiguity unrelated to FK roles, where a dimension-role match always beats a
    // label-role one even when the label is the better-targeted candidate)
    "Hawthorn's biggest wins",
    // regressions: existing (non-role) filter/aggregate/rows behaviour
    "Which clubs have played in a grand final?",
    "Essendon's away games since 2000",
    "What's the tallest mountain in Australia?",
  ],
}

async function main() {
  const args = process.argv.slice(2)
  const offline = args.includes("--offline")
  const datasetIdx = args.indexOf("--dataset")
  const results: { prompt: string; dataset: string; r: RunResult }[] = []

  if (args.includes("--all")) {
    for (const id of bundledDatasetIds(ROOT)) {
      const catalog = loadCatalog(id)
      for (const p of catalog.tryPrompts) {
        const r = await runOne(id, p.text, { offline })
        results.push({ prompt: p.text, dataset: id, r })
      }
    }
  } else if (args.includes("--extra")) {
    for (const id of bundledDatasetIds(ROOT)) {
      for (const q of EXTRA_QUESTIONS[id] ?? []) {
        const r = await runOne(id, q, { offline })
        results.push({ prompt: q, dataset: id, r })
      }
    }
  } else if (args.includes("--v02")) {
    const pick = args[args.indexOf("--v02") + 1]
    const sets: Record<string, V02Question[]> = { filters: V02_FILTERS, calc: V02_CALC, agnostic: V02_AGNOSTIC }
    const list = pick && sets[pick] ? sets[pick]! : [...V02_FILTERS, ...V02_CALC, ...V02_AGNOSTIC]
    for (const v of list) {
      const r = await runOne(v.dataset, v.q, { offline })
      const sql = r.sql ?? ""
      const missed = (v.expect ?? []).filter((re) => !re.test(sql)).map(String)
      const unwanted = (v.reject ?? []).filter((re) => re.test(sql)).map(String)
      const enoughRows = r.rowCount >= (v.minRows ?? 1)
      const ok = r.ok && !missed.length && !unwanted.length && enoughRows
      if (!ok) console.log(`  V02 FAIL: ${[missed.length ? `missing ${missed.join(" ")}` : "", unwanted.length ? `unwanted ${unwanted.join(" ")}` : "", enoughRows ? "" : `rows ${r.rowCount} < ${v.minRows ?? 1}`].filter(Boolean).join("; ")}`)
      results.push({ prompt: v.q, dataset: v.dataset, r: { ...r, ok } })
    }
  } else if (datasetIdx !== -1) {
    const id = args[datasetIdx + 1]!
    const question = args.filter((a, i) => i !== datasetIdx && i !== datasetIdx + 1 && !a.startsWith("--")).join(" ")
    const r = await runOne(id, question, { offline })
    results.push({ prompt: question, dataset: id, r })
  } else {
    console.log("usage: bun scripts/plan-cli.ts --dataset <id> \"question\" | --all | --extra | --v02 [filters|calc|agnostic] [--offline]")
    process.exit(1)
  }

  console.log("\n\n=== SUMMARY ===")
  console.log("dataset | prompt | status | rows | ok")
  for (const { prompt, dataset, r } of results) {
    console.log(`${dataset} | ${prompt} | ${r.status} | ${r.rowCount} | ${r.ok ? "OK" : "FAIL"}`)
  }
  const failed = results.filter((x) => !x.r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} OK`)
  if (failed.length) {
    console.log("FAILED:")
    for (const f of failed) console.log(`  [${f.dataset}] ${f.prompt}: ${f.r.error ?? f.r.status}`)
  }
}

await main()

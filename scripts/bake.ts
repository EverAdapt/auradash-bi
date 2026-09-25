#!/usr/bin/env bun
/**
 * Bake Jev's answers for every curated Try prompt (bun scripts/bake.ts).
 *
 *   public/data/<id>.catalog.json + data/<id>.sqlite + Jev (key from .dev.vars)
 *     → public/data/<id>.baked.json   { plan: { [planBakeKey]: PlanResponse },
 *                                        chart: { [chartBakeKey]: ChartResponse } }
 *
 * Runs the exact browser pipeline (candidates → request → Jev plan → interpret → compile → SQL →
 * profile → eligible charts → Jev chart) so the keys match what src/lib/jev/client.ts looks up.
 * Try prompts then cost no Jev calls, answer instantly and keep working when Jev is rate limited.
 */
import { Database } from "bun:sqlite"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { bundledDatasetIds } from "./datasets"
import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { Catalog, Cell, ChartRequest, ChartResponse, ChartType, PlanResponse, ResultSet } from "@shared/contract"
import {
  chartQuestions,
  chartState,
  normalizeChartAnswer,
  normalizePlanAnswers,
  planQuestions,
  planState,
  type RawPlanAnswers,
} from "@shared/jev/questions"
import { chartBakeKey, planBakeKey } from "@/lib/jev/bake-key"
import { findCandidates } from "@/lib/plan/candidates"
import { compilePlan } from "@/lib/plan/compile"
import { interpretAnswers } from "@/lib/plan/interpret"
import { buildPlanRequest } from "@/lib/plan/request"
import { chartCriteria } from "@/lib/viz/criteria"
import { eligibleCharts } from "@/lib/viz/eligible"
import { profileResult } from "@/lib/viz/profile"

const ROOT = path.resolve(import.meta.dir, "..")
// `bun scripts/bake.ts world afl` bakes only those datasets; no arguments bakes them all.
const ONLY = process.argv.slice(2)
const DATASETS = bundledDatasetIds(ROOT).filter((id) => ONLY.length === 0 || ONLY.includes(id))

const devVars = Object.fromEntries(
  readFileSync(path.join(ROOT, ".dev.vars"), "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z_]+)\s*=\s*(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
) as Record<string, string>
if (!devVars.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY missing from .dev.vars")
const model = devVars.JEV_MODEL ?? "jev-1.13.0"
const jev = new TypeSafeClient({ apiKey: devVars.TYPESAFE_API_KEY, defaultModel: model, timeout: 8000, retry: { maxRetries: 2 } })

function run(db: Database, sql: string, params: Cell[]): ResultSet {
  const t0 = performance.now()
  const stmt = db.query(sql)
  const rows = stmt.values(...(params as never[])) as Cell[][]
  return { columns: stmt.columnNames, rows: rows.slice(0, 5000), truncated: rows.length > 5000, elapsedMs: Math.round(performance.now() - t0) }
}

const summary: string[] = []

for (const id of DATASETS) {
  const catalog = JSON.parse(readFileSync(path.join(ROOT, "public", "data", `${id}.catalog.json`), "utf8")) as Catalog
  const db = new Database(path.join(ROOT, "data", `${id}.sqlite`), { readonly: true })
  const baked: { plan: Record<string, PlanResponse>; chart: Record<string, ChartResponse> } = { plan: {}, chart: {} }

  for (const prompt of catalog.tryPrompts) {
    const question = prompt.text
    const candidates = findCandidates(question, catalog)
    const req = buildPlanRequest(question, catalog, candidates)
    const questions = planQuestions(req)
    const t0 = performance.now()
    const res = await jev.systemOne({ state: planState(req), questions })
    const answers = normalizePlanAnswers(res.answers as unknown as RawPlanAnswers, req)
    const planResponse: PlanResponse = {
      answers,
      meta: { source: "jev", model: res.model, latencyMs: Math.round(performance.now() - t0), questionCount: Object.keys(questions).length },
    }
    baked.plan[planBakeKey(req)] = planResponse

    const interp = interpretAnswers(answers, req, catalog)
    if (interp.status !== "ok" || !interp.plan) {
      summary.push(`${id} ✗ ${question} → ${interp.status} ${interp.message ?? ""}`)
      continue
    }
    const compiled = compilePlan(interp.plan, catalog)
    const result = run(db, compiled.sql, compiled.params)
    const profile = profileResult(result, compiled.columns)
    const eligible = eligibleCharts(profile)
    let chosen: ChartType = eligible[0] ?? "table"
    if (eligible.length > 1) {
      const chartReq: ChartRequest = {
        datasetId: id,
        question,
        result: {
          row_count: profile.rowCount,
          columns: profile.columns.map((c) => ({ name: c.name, kind: c.kind, distinct: c.distinct, unit: c.unit })),
          first_rows: profile.firstRows.slice(0, 8),
        },
        eligible: eligible.reduce<ChartRequest["eligible"]>((acc, t) => {
          acc[t] = chartCriteria[t]
          return acc
        }, {}),
      }
      const cq = chartQuestions(chartReq)
      const t1 = performance.now()
      const cres = await jev.systemOne({ state: chartState(chartReq), questions: cq })
      const answer = normalizeChartAnswer(cres.answers as unknown as Parameters<typeof normalizeChartAnswer>[0])
      baked.chart[chartBakeKey(chartReq)] = {
        answer,
        meta: { source: "jev", model: cres.model, latencyMs: Math.round(performance.now() - t1), questionCount: Object.keys(cq).length },
      }
      chosen = answer.value
    }
    const intended = prompt.chart ? ` (curated: ${prompt.chart})` : ""
    summary.push(
      `${id} ✓ ${question} → ${compiled.title} · ${result.rows.length} rows · chart ${chosen}${intended} · conf ${interp.confidence.toFixed(2)}`,
    )
  }

  writeFileSync(path.join(ROOT, "public", "data", `${id}.baked.json`), JSON.stringify(baked))
  db.close()
}

console.log(summary.join("\n"))

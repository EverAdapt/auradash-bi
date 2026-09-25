/**
 * OWNER: ask-board. Question → answer, end to end:
 *
 *   getCatalog → planQuestion → query(compiled.sql, compiled.params) → profileResult →
 *   decideChart → encodeChart
 *
 * This module only orchestrates other workstreams' public APIs (`@/lib/catalog`, `@/lib/plan`,
 * `@/lib/db`, `@/lib/viz`); it never touches SQL or chart encoding itself. Two lighter paths reuse
 * the same result without re-asking Jev: `rerunFromOutcome` (after `applyChoice`, no plan call) and
 * `switchChart` (encode only, no query). `useAsk` is the debounced, abortable, LRU-cached React hook
 * the ask panel drives while typing.
 *
 * Empty-result fallback: a query that comes back with 0 rows (or one row of all NULLs — the same
 * shape a LEFT JOIN/aggregate with no matches produces) never reaches the screen as a bare null/0
 * table. `withFallback` tries `fallbackPlans`' relaxed candidates (max 3, in order) and swaps in the
 * first one that actually returns data, carrying `fallback: { reason, original }` so the preview can
 * show a calm notice ("showing X instead") with a "Show original" link back to the true answer.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ChartSpec,
  ChartType,
  DatasetId,
  ResultProfile,
  ResultSet,
} from "@shared/contract"
import { CHART_TYPES } from "@shared/contract"
import { getCatalog } from "@/lib/catalog"
import { query } from "@/lib/db"
import { compilePlan, fallbackPlans, type PlanOutcome, planQuestion } from "@/lib/plan"
import { logEvent } from "@/lib/telemetry"
import {
  type ChartDecision,
  decideChart,
  encodeChart,
  profileResult,
} from "@/lib/viz"
import { useUiStore } from "@/state/ui"
import { LRU, normalizeKey } from "./lru"

export type AskStage = "plan" | "sql" | "chart"

/** The ask pipeline's own result shape (not part of shared/contract — ask-board owns this module). */
export interface AskResult {
  outcome: PlanOutcome
  result?: ResultSet
  profile?: ResultProfile
  decision?: ChartDecision
  spec?: ChartSpec
  timings: { plan: number; sql: number; chart: number; total: number }
  error?: string
  /** Set when the original query came back empty and a relaxed candidate answered instead. */
  fallback?: { reason: string; original: AskResult }
}

const CHART_TYPE_SET = new Set<string>(CHART_TYPES)

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

/** A chart the user named explicitly ("pie chart of ..."), read off the plan's answers. */
function namedChartFromOutcome(outcome: PlanOutcome): ChartType | undefined {
  const answer = outcome.answers?.namedChart
  if (!answer || answer.value === "none" || answer.confidence < 0.5)
    return undefined
  return CHART_TYPE_SET.has(answer.value)
    ? (answer.value as ChartType)
    : undefined
}

export interface RunAskOptions {
  signal?: AbortSignal
  onStage?: (stage: AskStage) => void
}

/** The full pipeline for a fresh question: plan, run the SQL, profile, and choose a chart. */
export async function runAsk(
  question: string,
  datasetId: DatasetId,
  opts: RunAskOptions = {}
): Promise<AskResult> {
  const { signal, onStage } = opts
  const t0 = performance.now()

  onStage?.("plan")
  const catalog = await getCatalog(datasetId)
  const outcome = await planQuestion(question, catalog, { signal })
  const tPlan = performance.now()
  useUiStore.getState().setLastJevMeta(outcome.meta)

  if (outcome.status !== "ok" || !outcome.compiled) {
    const res: AskResult = {
      outcome,
      timings: { plan: tPlan - t0, sql: 0, chart: 0, total: tPlan - t0 },
    }
    logResultShown(datasetId, outcome, res)
    return res
  }

  const res = await runCompiledOnce(outcome, datasetId, { signal, onStage, t0, tPlan })
  return withFallback(outcome, datasetId, res, { signal, onStage })
}

/** Re-run an outcome that already has a compiled query (e.g. after `applyChoice`); no plan call. */
export async function rerunFromOutcome(
  outcome: PlanOutcome,
  datasetId: DatasetId,
  opts: RunAskOptions = {}
): Promise<AskResult> {
  const t0 = performance.now()
  if (outcome.status !== "ok" || !outcome.compiled) {
    const res: AskResult = {
      outcome,
      timings: { plan: 0, sql: 0, chart: 0, total: performance.now() - t0 },
    }
    logResultShown(datasetId, outcome, res)
    return res
  }
  const res = await runCompiledOnce(outcome, datasetId, { ...opts, t0, tPlan: t0 })
  return withFallback(outcome, datasetId, res, opts)
}

/** Whether a result is the empty shape a fallback should kick in for: no rows, or one row whose
 *  every value is NULL (a LEFT JOIN / aggregate that matched nothing still returns one such row). */
function isEmptyResult(result: ResultSet): boolean {
  if (result.rows.length === 0) return true
  return result.rows.length === 1 && result.rows[0]!.every((v) => v === null)
}

function logResultShown(datasetId: DatasetId, outcome: PlanOutcome, res: AskResult, fallbackReason?: string): void {
  const chartType = res.decision?.type ?? res.spec?.type
  const chartP = res.decision?.ranking.find((r) => r.type === res.decision?.type)?.p
  logEvent({
    type: "result",
    datasetId,
    question: outcome.question,
    data: {
      status: res.error ? "error" : outcome.status,
      title: outcome.compiled?.title,
      chart: chartType,
      chartProbability: chartP,
      rows: res.profile?.rowCount,
      source: (res.decision?.meta ?? outcome.meta).source,
      confidence: outcome.confidence,
      empty: res.result ? isEmptyResult(res.result) : undefined,
      fallbackReason,
    },
  })
}

/** Tries `fallbackPlans`' relaxed candidates (max 3) in order when `res` came back empty, swapping
 *  in the first one with data; logs the "result" telemetry event either way. Best-effort: a
 *  fallback candidate that itself errors is skipped, and any unexpected failure just falls back to
 *  showing the true (empty) result rather than losing the original answer. */
async function withFallback(outcome: PlanOutcome, datasetId: DatasetId, res: AskResult, opts: RunAskOptions): Promise<AskResult> {
  if (res.error || !res.result || !isEmptyResult(res.result)) {
    logResultShown(datasetId, outcome, res)
    return res
  }
  try {
    const catalog = await getCatalog(datasetId)
    for (const candidate of fallbackPlans(outcome, catalog).slice(0, 3)) {
      const attempt = await runCompiledOnce(candidate.outcome, datasetId, {
        signal: opts.signal,
        t0: performance.now(),
        tPlan: performance.now(),
      })
      if (!attempt.error && attempt.result && !isEmptyResult(attempt.result)) {
        const withNotice: AskResult = { ...attempt, fallback: { reason: candidate.reason, original: res } }
        logResultShown(datasetId, candidate.outcome, withNotice, candidate.reason)
        return withNotice
      }
    }
  } catch (err) {
    if (isAbortError(err)) throw err
    // no usable fallback — fall through to the true (empty) result below
  }
  logResultShown(datasetId, outcome, res)
  return res
}

async function runCompiledOnce(
  outcome: PlanOutcome,
  datasetId: DatasetId,
  opts: RunAskOptions & { t0: number; tPlan: number }
): Promise<AskResult> {
  const { signal, onStage, t0, tPlan } = opts
  const compiled = outcome.compiled
  if (!compiled) {
    return {
      outcome,
      timings: {
        plan: tPlan - t0,
        sql: 0,
        chart: 0,
        total: performance.now() - t0,
      },
    }
  }

  onStage?.("sql")
  let result: ResultSet
  try {
    result = await query(datasetId, compiled.sql, compiled.params, { signal })
  } catch (err) {
    if (isAbortError(err)) throw err
    return {
      outcome,
      timings: {
        plan: tPlan - t0,
        sql: performance.now() - tPlan,
        chart: 0,
        total: performance.now() - t0,
      },
      error:
        err instanceof Error ? err.message : "That question could not be run.",
    }
  }
  const tSql = performance.now()

  const profile = profileResult(result, compiled.columns)

  onStage?.("chart")
  const decision = await decideChart({
    question: outcome.question,
    datasetId,
    profile,
    named: namedChartFromOutcome(outcome),
    signal,
  })
  const tChart = performance.now()
  useUiStore.getState().setLastJevMeta(decision.meta)

  const spec = encodeChart(decision.type, profile)

  return {
    outcome,
    result,
    profile,
    decision,
    spec,
    timings: {
      plan: tPlan - t0,
      sql: tSql - tPlan,
      chart: tChart - tSql,
      total: tChart - t0,
    },
  }
}

/**
 * v0.2: the rows-table "Next 50" pager. Recompiles the outcome's own plan at a different `offset`
 * (`compilePlan`, no plan rewrite of any other slot) and re-runs ONLY the query + profile steps —
 * never `decideChart`, so paging spends no extra Jev call and never flips the chart the original
 * answer already picked. View-only: the caller keeps showing the original `outcome`/`compiled` (a
 * pin still cites the un-paged query); this only swaps the rows a rendered table component reads.
 * Returns null (logged, not thrown) on a compile/query failure, so a bad page never blanks the
 * table already on screen.
 */
export async function pageRows(
  outcome: PlanOutcome,
  datasetId: DatasetId,
  offset: number,
  opts: { signal?: AbortSignal } = {}
): Promise<{ result: ResultSet; profile: ResultProfile } | null> {
  if (!outcome.plan) return null
  try {
    const catalog = await getCatalog(datasetId)
    const compiled = compilePlan({ ...outcome.plan, offset }, catalog)
    const result = await query(datasetId, compiled.sql, compiled.params, { signal: opts.signal })
    return { result, profile: profileResult(result, compiled.columns) }
  } catch (err) {
    if (isAbortError(err)) throw err
    console.error("[pageRows] failed", err)
    return null
  }
}

/** Switch the chart type on an existing result: encode only, no requery, no Jev call. */
export function switchChart(askResult: AskResult, type: ChartType): AskResult {
  if (!askResult.profile) return askResult
  const spec = encodeChart(type, askResult.profile)
  const decision = askResult.decision
    ? { ...askResult.decision, type }
    : undefined
  return { ...askResult, spec, decision }
}

// ─────────────────────────────── useAsk ───────────────────────────────

export type AskStatus = "idle" | "thinking" | "ready" | "error"

const DEBOUNCE_MS = 450
const MIN_WORDS = 3
const MIN_CHARS = 14

/** Live preview kicks in once the question looks intentional, not on every keystroke. Also used
 *  by the ask panel to tell "a run is pending/in flight" apart from "no run will happen" while
 *  the input text has moved on from the shown preview (the calm staleness indicator). */
export function looksLikeAQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= MIN_WORDS || trimmed.length >= MIN_CHARS
}

const askCache = new LRU<string, AskResult>(50)
const cacheKey = (datasetId: DatasetId, text: string) =>
  `${datasetId}::${normalizeKey(text)}`

export interface UseAskState {
  status: AskStatus
  stage: AskStage | null
  askResult: AskResult | null
  /** The text `askResult` was computed for (may lag `text` while debouncing). */
  askedText: string
  /** Enter, or a Try chip: run immediately, bypassing the debounce/length gate. */
  runNow: (question?: string) => void
  /** Clear the current result (Esc). */
  clear: () => void
}

/**
 * Debounced (450 ms), abortable, stale-safe live preview. Only questions that look intentional
 * (>= 3 words or >= 14 chars) trigger automatically; `runNow` (Enter / a Try chip) always runs.
 */
export function useAsk(text: string, datasetId: DatasetId): UseAskState {
  const [status, setStatus] = useState<AskStatus>("idle")
  const [stage, setStage] = useState<AskStage | null>(null)
  const [askResult, setAskResult] = useState<AskResult | null>(null)
  const [askedText, setAskedText] = useState("")
  const controllerRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const execute = useCallback(
    (question: string) => {
      const trimmed = question.trim()
      controllerRef.current?.abort()
      if (!trimmed) {
        setStatus("idle")
        setStage(null)
        setAskResult(null)
        setAskedText("")
        return
      }

      const key = cacheKey(datasetId, trimmed)
      const cached = askCache.get(key)
      const id = ++seqRef.current
      if (cached) {
        setAskResult(cached)
        setAskedText(trimmed)
        setStage(null)
        setStatus(cached.error ? "error" : "ready")
        return
      }

      const ctrl = new AbortController()
      controllerRef.current = ctrl
      setStatus("thinking")
      setStage("plan")
      runAsk(trimmed, datasetId, {
        signal: ctrl.signal,
        onStage: (s) => {
          if (id === seqRef.current) setStage(s)
        },
      })
        .then((res) => {
          if (id !== seqRef.current) return
          askCache.set(key, res)
          setAskResult(res)
          setAskedText(trimmed)
          setStage(null)
          setStatus(res.error ? "error" : "ready")
        })
        .catch((err) => {
          if (isAbortError(err) || id !== seqRef.current) return
          setStage(null)
          setStatus("error")
        })
    },
    [datasetId]
  )

  useEffect(() => {
    if (!looksLikeAQuestion(text)) return
    const timer = setTimeout(() => execute(text), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, execute])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const runNow = useCallback(
    (question?: string) => execute(question ?? text),
    [execute, text]
  )
  const clear = useCallback(() => {
    controllerRef.current?.abort()
    seqRef.current += 1
    setStatus("idle")
    setStage(null)
    setAskResult(null)
    setAskedText("")
  }, [])

  return { status, stage, askResult, askedText, runNow, clear }
}

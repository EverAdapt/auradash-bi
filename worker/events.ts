/**
 * OWNER: platform. Anonymous interaction history (public demo only, D1 binding `EVENTS`).
 *
 * Two writers:
 *  - `logServerEvent`: called from /api/plan and /api/chart via `ctx.waitUntil` — a compact,
 *    server-computed summary of the answer (never the raw question text beyond what the client
 *    already sent, never IP, never a user-agent string).
 *  - POST /api/events (`handlePostEvent`): client-reported interaction events (pin, chart switch,
 *    thumbs up/down, ...), validated with zod, cheap per-IP rate limited.
 *
 * No-ops everywhere when `env.EVENTS` isn't bound (repo default / non-demo deploys) — callers don't
 * need to check for the binding themselves.
 */
import { z } from "zod"
import type { PlanAnswers } from "../shared/contract"

const MAX_QUESTION_LEN = 300
const MAX_DATA_BYTES = 2 * 1024

/**
 * Kept identical to `src/lib/telemetry.ts`'s TELEMETRY_EVENT_TYPES by hand (not imported from
 * there): that module is bundled for the browser (zustand-backed `useDemo` store) and pulling it
 * into the Worker bundle for one literal array isn't worth the coupling.
 */
const CLIENT_EVENT_TYPES = ["result", "try_prompt", "pin", "chart_switch", "slot_change", "did_you_mean", "feedback"] as const

export interface EventRow {
  ts: string
  session?: string | null
  type: string
  dataset?: string | null
  question?: string | null
  data?: unknown
  source?: string | null
  model?: string | null
  latencyMs?: number | null
  country?: string | null
  colo?: string | null
}

async function insertEvent(env: Env, row: EventRow): Promise<void> {
  if (!env.EVENTS) return
  const dataJson = row.data === undefined ? null : JSON.stringify(row.data).slice(0, MAX_DATA_BYTES)
  try {
    await env.EVENTS.prepare(
      `INSERT INTO events (ts, session, type, dataset, question, data, source, model, latency_ms, country, colo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.ts,
        row.session ?? null,
        row.type,
        row.dataset ?? null,
        row.question ?? null,
        dataJson,
        row.source ?? null,
        row.model ?? null,
        row.latencyMs ?? null,
        row.country ?? null,
        row.colo ?? null,
      )
      .run()
  } catch {
    // Best-effort only — a telemetry write must never break the actual request.
  }
}

/** A short, non-identifying summary of what the plan answered — no free-text beyond the question. */
function summarizePlanAnswers(answers: PlanAnswers): Record<string, unknown> {
  return {
    inScope: answers.inScope,
    answerKind: answers.answerKind.value,
    measure: answers.measure.value,
    measure2: answers.measure2.value,
    groupBy: answers.groupBy.value,
    time: answers.timeGrain.value,
    sort: answers.sort.value,
    rowTable: answers.rowTable.value,
    filters: Object.fromEntries(Object.entries(answers.filters).map(([id, a]) => [id, a.value])),
    filterRoles: answers.filterRoles ? Object.fromEntries(Object.entries(answers.filterRoles).map(([id, a]) => [id, a.value])) : undefined,
  }
}

export function logPlanEvent(
  ctx: { waitUntil(p: Promise<unknown>): void },
  env: Env,
  p: { datasetId: string; question: string; answers: PlanAnswers; source: string; model: string; latencyMs: number; cf?: { country?: string; colo?: string } },
): void {
  if (!env.EVENTS) return
  ctx.waitUntil(
    insertEvent(env, {
      ts: new Date().toISOString(),
      type: "plan",
      dataset: p.datasetId,
      question: p.question.slice(0, MAX_QUESTION_LEN),
      data: summarizePlanAnswers(p.answers),
      source: p.source,
      model: p.model,
      latencyMs: p.latencyMs,
      country: p.cf?.country,
      colo: p.cf?.colo,
    }),
  )
}

export function logChartEvent(
  ctx: { waitUntil(p: Promise<unknown>): void },
  env: Env,
  p: {
    datasetId: string
    question: string
    answer: { value: string; confidence: number; probabilities: Record<string, number> }
    source: string
    model: string
    latencyMs: number
    cf?: { country?: string; colo?: string }
  },
): void {
  if (!env.EVENTS) return
  ctx.waitUntil(
    insertEvent(env, {
      ts: new Date().toISOString(),
      type: "chart",
      dataset: p.datasetId,
      question: p.question.slice(0, MAX_QUESTION_LEN),
      data: { pick: p.answer.value, confidence: p.answer.confidence, probabilities: p.answer.probabilities },
      source: p.source,
      model: p.model,
      latencyMs: p.latencyMs,
      country: p.cf?.country,
      colo: p.cf?.colo,
    }),
  )
}

// ─────────────────────────────── POST /api/events (client-reported) ───────────────────────────────

export const clientEventSchema = z.object({
  type: z.enum(CLIENT_EVENT_TYPES),
  session: z.string().uuid(),
  dataset: z.string().max(80).optional(),
  question: z.string().max(MAX_QUESTION_LEN).optional(),
  data: z.unknown().optional(),
})
export type ClientEvent = z.infer<typeof clientEventSchema>

/** Rejects an oversized body before it ever reaches JSON.parse/zod (same shape as the plan/chart guard). */
export function clientEventTooLarge(raw: string): boolean {
  return new TextEncoder().encode(raw).byteLength > MAX_DATA_BYTES + 1024 // + headroom for type/session/dataset/question
}

export function logClientEvent(ctx: { waitUntil(p: Promise<unknown>): void }, env: Env, ev: ClientEvent, cf?: { country?: string; colo?: string }): void {
  if (!env.EVENTS) return
  ctx.waitUntil(
    insertEvent(env, {
      ts: new Date().toISOString(),
      session: ev.session,
      type: ev.type,
      dataset: ev.dataset,
      question: ev.question,
      data: ev.data,
      country: cf?.country,
      colo: cf?.colo,
    }),
  )
}

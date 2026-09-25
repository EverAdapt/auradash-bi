/**
 * OWNER: planner (routing/Jev pipeline); platform owns demo-mode gating, security headers and
 * anonymous interaction history layered on top (see inline comments below). The Cloudflare Worker:
 * static assets (SPA) + the Jev API.
 *
 *   GET  /api/health  → { mode: "jev" | "offline", model, demo, telemetry }
 *   POST /api/plan    PlanRequest  → PlanResponse   (Jev plan call; 503 offline, 429 rate limited)
 *   POST /api/chart   ChartRequest → ChartResponse  (Jev chart call)
 *   POST /api/events  client-reported anonymous interaction event → 204 (platform)
 *
 * Pipeline for /api/plan and /api/chart: validate (400) -> demo-mode dataset restriction (403
 * "demo_restricted") -> rate limit, per-IP and global (429 "rate_limited") -> cache, isolate LRU +
 * best-effort Cache API (X-Jev-Cache: hit|miss) -> missing or placeholder key (503 "offline") ->
 * Jev (RateLimitError -> 429, timeout -> 504, anything else -> 502) -> normalize -> anonymous event
 * log (ctx.waitUntil, only when EVENTS is bound). Errors are never cached; the key is never logged.
 *
 * Every /api/* response gets the same security headers as public/_headers plus Cache-Control:
 * no-store (see ./headers.ts) — API responses are never meant to be cached by a browser or a CDN.
 */
import { RateLimitError } from "@typesafe-ai/sdk"
import { Hono } from "hono"
import type { ChartResponse, JevMeta, PlanResponse } from "../shared/contract"
import { chartQuestions, chartState, normalizeChartAnswer, normalizePlanAnswers, planQuestions, planState, type RawPlanAnswers } from "../shared/jev/questions"
import { chartRequestSchema, MAX_BODY_BYTES, planRequestSchema } from "../shared/validate"
import { BUNDLED_DATASETS } from "../shared/bundled"
import { cacheKey, readCache, writeCache } from "./cache"
import { clientEventSchema, clientEventTooLarge, logChartEvent, logClientEvent, logPlanEvent } from "./events"
import { NO_STORE_HEADER, SECURITY_HEADERS } from "./headers"
import { getJevClient, looksLikeKey } from "./jev"

const app = new Hono<{ Bindings: Env }>()

app.use("*", async (c, next) => {
  await next()
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
  c.header("Cache-Control", NO_STORE_HEADER["Cache-Control"])
})

/** `vars.DEMO_MODE` is a plain string ("true"/"false") — widened here so this stays correct
 *  regardless of which literal type `wrangler types` infers for it from a given environment. */
function isDemoMode(env: Env): boolean {
  return (env.DEMO_MODE as unknown as string | undefined) === "true"
}

function requestCf(c: { req: { raw: Request } }): { country?: string; colo?: string } | undefined {
  // Cast through unknown: `cf` is a workerd-only extension of Request, not always present in the
  // ambient DOM/runtime types this file resolves against.
  const cf = (c.req.raw as unknown as { cf?: { country?: string; colo?: string } }).cf
  return cf ? { country: cf.country, colo: cf.colo } : undefined
}

app.get("/api/health", (c) =>
  c.json({
    mode: looksLikeKey(c.env.TYPESAFE_API_KEY) ? "jev" : "offline",
    model: c.env.JEV_MODEL ?? "jev-latest",
    demo: isDemoMode(c.env),
    telemetry: !!c.env.EVENTS,
  }),
)

async function readBoundedJson(c: { req: { text(): Promise<string> } }): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  const raw = await c.req.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { ok: false, reason: "request body too large" }
  try {
    return { ok: true, json: JSON.parse(raw) }
  } catch {
    return { ok: false, reason: "invalid JSON" }
  }
}

async function underRateLimit(env: Env, ip: string): Promise<boolean> {
  const [perIp, global] = await Promise.all([env.JEV_PER_IP.limit({ key: ip }), env.JEV_GLOBAL.limit({ key: "all" })])
  return perIp.success && global.success
}

function errorStatus(err: unknown): 429 | 504 | 502 {
  if (err instanceof RateLimitError) return 429
  if (err instanceof Error && err.name === "APITimeoutError") return 504
  return 502
}

function errorBody(err: unknown): { error: string; reason?: string } {
  if (err instanceof RateLimitError) return { error: "rate_limited" }
  if (err instanceof Error && err.name === "APITimeoutError") return { error: "timeout" }
  return { error: "jev_error", reason: err instanceof Error ? err.message : "unknown error" }
}

app.post("/api/plan", async (c) => {
  const body = await readBoundedJson(c)
  if (!body.ok) return c.json({ error: "invalid_request", reason: body.reason }, 400)
  const parsed = planRequestSchema.safeParse(body.json)
  if (!parsed.success) return c.json({ error: "invalid_request", reason: parsed.error.issues[0]?.message ?? "invalid request" }, 400)
  const req = parsed.data

  // Demo mode only answers for the datasets it ships with, and only when the client's schema
  // matches exactly (a stale schemaHash means the bundled dataset was rebuilt without this deploy
  // picking up the new shared/bundled.ts — safer to refuse than to silently plan against a schema
  // that no longer matches the running database).
  if (isDemoMode(c.env) && BUNDLED_DATASETS[req.datasetId] !== req.schemaHash) {
    return c.json({ error: "demo_restricted" }, 403)
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown"
  if (!(await underRateLimit(c.env, ip))) return c.json({ error: "rate_limited" }, 429)

  const key = await cacheKey(c.env.JEV_MODEL, req)
  const cached = await readCache<PlanResponse>("plan", key)
  if (cached) {
    c.header("X-Jev-Cache", "hit")
    logPlanEvent(c.executionCtx, c.env, { datasetId: req.datasetId, question: req.question, answers: cached.answers, source: "cache", model: cached.meta.model, latencyMs: cached.meta.latencyMs, cf: requestCf(c) })
    return c.json({ ...cached, meta: { ...cached.meta, source: "cache" } })
  }
  c.header("X-Jev-Cache", "miss")

  if (!looksLikeKey(c.env.TYPESAFE_API_KEY)) return c.json({ error: "offline", reason: "no_key" }, 503)

  const started = performance.now()
  try {
    const questions = planQuestions(req)
    const result = await getJevClient(c.env).systemOne({ state: planState(req), questions }, { signal: c.req.raw.signal })
    const meta: JevMeta = { source: "jev", model: result.model, latencyMs: Math.round(performance.now() - started), questionCount: Object.keys(questions).length }
    const answers = normalizePlanAnswers(result.answers as unknown as RawPlanAnswers, req)
    const response: PlanResponse = { answers, meta }
    writeCache("plan", key, response, c.executionCtx)
    logPlanEvent(c.executionCtx, c.env, { datasetId: req.datasetId, question: req.question, answers, source: meta.source, model: meta.model, latencyMs: meta.latencyMs, cf: requestCf(c) })
    return c.json(response)
  } catch (err) {
    return c.json(errorBody(err), errorStatus(err))
  }
})

app.post("/api/chart", async (c) => {
  const body = await readBoundedJson(c)
  if (!body.ok) return c.json({ error: "invalid_request", reason: body.reason }, 400)
  const parsed = chartRequestSchema.safeParse(body.json)
  if (!parsed.success) return c.json({ error: "invalid_request", reason: parsed.error.issues[0]?.message ?? "invalid request" }, 400)
  const req = parsed.data

  // Same restriction as /api/plan (see there); ChartRequest carries no schemaHash, so datasetId
  // membership in the bundled set is the whole check here.
  if (isDemoMode(c.env) && !(req.datasetId in BUNDLED_DATASETS)) {
    return c.json({ error: "demo_restricted" }, 403)
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown"
  if (!(await underRateLimit(c.env, ip))) return c.json({ error: "rate_limited" }, 429)

  const key = await cacheKey(c.env.JEV_MODEL, req)
  const cached = await readCache<ChartResponse>("chart", key)
  if (cached) {
    c.header("X-Jev-Cache", "hit")
    logChartEvent(c.executionCtx, c.env, { datasetId: req.datasetId, question: req.question, answer: cached.answer, source: "cache", model: cached.meta.model, latencyMs: cached.meta.latencyMs, cf: requestCf(c) })
    return c.json({ ...cached, meta: { ...cached.meta, source: "cache" } })
  }
  c.header("X-Jev-Cache", "miss")

  if (!looksLikeKey(c.env.TYPESAFE_API_KEY)) return c.json({ error: "offline", reason: "no_key" }, 503)

  const started = performance.now()
  try {
    const questions = chartQuestions(req)
    const result = await getJevClient(c.env).systemOne({ state: chartState(req), questions }, { signal: c.req.raw.signal })
    const meta: JevMeta = { source: "jev", model: result.model, latencyMs: Math.round(performance.now() - started), questionCount: Object.keys(questions).length }
    const answer = normalizeChartAnswer(result.answers as unknown as Parameters<typeof normalizeChartAnswer>[0])
    const response: ChartResponse = { answer, meta }
    writeCache("chart", key, response, c.executionCtx)
    logChartEvent(c.executionCtx, c.env, { datasetId: req.datasetId, question: req.question, answer, source: meta.source, model: meta.model, latencyMs: meta.latencyMs, cf: requestCf(c) })
    return c.json(response)
  } catch (err) {
    return c.json(errorBody(err), errorStatus(err))
  }
})

// OWNER: platform. Client-reported anonymous interaction events (pin, chart switch, feedback, ...).
// Always 204 on success — the client never awaits or inspects this response (see lib/telemetry.ts).
app.post("/api/events", async (c) => {
  const raw = await c.req.text()
  if (clientEventTooLarge(raw)) return c.json({ error: "invalid_request", reason: "event too large" }, 400)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return c.json({ error: "invalid_request", reason: "invalid JSON" }, 400)
  }
  const parsed = clientEventSchema.safeParse(json)
  if (!parsed.success) return c.json({ error: "invalid_request", reason: parsed.error.issues[0]?.message ?? "invalid request" }, 400)

  const ip = c.req.header("cf-connecting-ip") ?? "unknown"
  const limit = await c.env.EVENTS_PER_IP.limit({ key: ip })
  if (!limit.success) return c.json({ error: "rate_limited" }, 429)

  logClientEvent(c.executionCtx, c.env, parsed.data, requestCf(c))
  return new Response(null, { status: 204 })
})

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

export default app satisfies ExportedHandler<Env>

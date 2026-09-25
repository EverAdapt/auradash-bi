/**
 * OWNER: planner. Browser client for the Worker's Jev endpoints.
 *
 * - Abortable (pass the caller's signal; aborts rethrow the AbortError untouched).
 * - Three layers, fastest first: baked Try-prompt answers (public/data/<id>.baked.json, lazily
 *   fetched, may 404) → a client LRU (300) keyed by the canonical request JSON → the Worker.
 * - Throws JevUnavailable (rate limited / offline / timeout / 5xx) so callers fall back to
 *   their offline implementation (plan: offline planner, viz: offline chart ranking).
 * - Reports every call's outcome to `useJevStatus` (status.ts).
 */
import type { ChartRequest, ChartResponse, PlanRequest, PlanResponse } from "@shared/contract"
import { canonicalJson } from "@shared/canonical"
import { chartBakeKey, planBakeKey } from "./bake-key"
import { useJevStatus } from "./status"

export type JevUnavailableReason = "no_key" | "rate_limited" | "timeout" | "error"

export class JevUnavailable extends Error {
  readonly reason: JevUnavailableReason
  constructor(reason: JevUnavailableReason, message?: string) {
    super(message ?? `Jev unavailable: ${reason}`)
    this.name = "JevUnavailable"
    this.reason = reason
  }
}

const CLIENT_TIMEOUT_MS = 6000
const LRU_SIZE = 300

class Lru<T> {
  private readonly map = new Map<string, T>()
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }
  get(key: string): T | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }
  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }
}

const planLru = new Lru<PlanResponse>(LRU_SIZE)
const chartLru = new Lru<ChartResponse>(LRU_SIZE)

interface BakedFile {
  plan: Record<string, PlanResponse>
  chart: Record<string, ChartResponse>
}
const bakedCache = new Map<string, BakedFile | null>()

async function loadBaked(datasetId: string): Promise<BakedFile | null> {
  const cached = bakedCache.get(datasetId)
  if (cached !== undefined) return cached
  try {
    const res = await fetch(`/data/${datasetId}.baked.json`)
    if (!res.ok) {
      bakedCache.set(datasetId, null)
      return null
    }
    const data = (await res.json()) as BakedFile
    bakedCache.set(datasetId, data)
    return data
  } catch {
    bakedCache.set(datasetId, null)
    return null
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return res.statusText
  }
}

async function postJson<TReq, TRes>(path: string, body: TReq, signal: AbortSignal | undefined): Promise<TRes> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener("abort", onAbort)
  }
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), CLIENT_TIMEOUT_MS)

  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.ok) return (await res.json()) as TRes
    if (res.status === 429) throw new JevUnavailable("rate_limited", await safeText(res))
    if (res.status === 504) throw new JevUnavailable("timeout", await safeText(res))
    throw new JevUnavailable("error", `${res.status}: ${await safeText(res)}`)
  } catch (err) {
    if (err instanceof JevUnavailable) throw err
    if (signal?.aborted) throw err // the caller's own abort — rethrow untouched
    if (controller.signal.aborted) throw new JevUnavailable("timeout", "client timeout")
    throw new JevUnavailable("error", err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

export async function postPlan(req: PlanRequest, signal?: AbortSignal): Promise<PlanResponse> {
  const baked = await loadBaked(req.datasetId)
  const bakedHit = baked?.plan[planBakeKey(req)]
  if (bakedHit) {
    const res: PlanResponse = { ...bakedHit, meta: { ...bakedHit.meta, source: "baked", latencyMs: 0 } }
    useJevStatus.getState().report(res.meta)
    return res
  }

  const lruKey = canonicalJson(req)
  const cached = planLru.get(lruKey)
  if (cached) {
    const res: PlanResponse = { ...cached, meta: { ...cached.meta, source: "cache", latencyMs: 0 } }
    useJevStatus.getState().report(res.meta)
    return res
  }

  try {
    const res = await postJson<PlanRequest, PlanResponse>("/api/plan", req, signal)
    planLru.set(lruKey, res)
    useJevStatus.getState().report(res.meta)
    return res
  } catch (err) {
    if (err instanceof JevUnavailable) useJevStatus.getState().report({ source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason: err.reason })
    throw err
  }
}

export async function postChart(req: ChartRequest, signal?: AbortSignal): Promise<ChartResponse> {
  const baked = await loadBaked(req.datasetId)
  const bakedHit = baked?.chart[chartBakeKey(req)]
  if (bakedHit) {
    const res: ChartResponse = { ...bakedHit, meta: { ...bakedHit.meta, source: "baked", latencyMs: 0 } }
    useJevStatus.getState().report(res.meta)
    return res
  }

  const lruKey = canonicalJson(req)
  const cached = chartLru.get(lruKey)
  if (cached) {
    const res: ChartResponse = { ...cached, meta: { ...cached.meta, source: "cache", latencyMs: 0 } }
    useJevStatus.getState().report(res.meta)
    return res
  }

  try {
    const res = await postJson<ChartRequest, ChartResponse>("/api/chart", req, signal)
    chartLru.set(lruKey, res)
    useJevStatus.getState().report(res.meta)
    return res
  } catch (err) {
    if (err instanceof JevUnavailable) useJevStatus.getState().report({ source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason: err.reason })
    throw err
  }
}

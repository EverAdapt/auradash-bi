/**
 * OWNER: planner. Response cache for /api/plan and /api/chart: an in-isolate LRU (survives while
 * the isolate is warm, which is most of the time on Workers) plus a best-effort write-through to
 * the Cache API via a synthetic GET URL. The Cache API may be a no-op on workers.dev (every
 * request can land in a different PoP there) — the isolate LRU is the layer that's always live.
 * Never caches an error response (callers only call `writeCache` on success).
 */
import { canonicalJson } from "../shared/canonical"

const LRU_SIZE = 1000

class Lru<T> {
  private map = new Map<string, T>()
  get(key: string): T | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }
  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= LRU_SIZE) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }
}

const isolateLru = new Lru<unknown>()

/** Bump whenever the Jev question set or wording changes, so cached answers to the old questions are never reused. */
const QUESTIONS_VERSION = "v0.2"

/** SHA-256(questions version + JEV_MODEL + canonical request JSON), hex-encoded. */
export async function cacheKey(model: string, body: unknown): Promise<string> {
  const data = new TextEncoder().encode(`${QUESTIONS_VERSION}|${model}|${canonicalJson(body)}`)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function syntheticUrl(route: string, key: string): string {
  return `https://cache.auradash-bi.internal/${route}/${key}`
}

export async function readCache<T>(route: string, key: string): Promise<T | undefined> {
  const hit = isolateLru.get(key) as T | undefined
  if (hit !== undefined) return hit
  try {
    const cache = (caches as unknown as { readonly default: Cache }).default
    const res = await cache.match(syntheticUrl(route, key))
    if (res) {
      const data = (await res.json()) as T
      isolateLru.set(key, data)
      return data
    }
  } catch {
    // Cache API unavailable in this environment — the isolate LRU alone is fine.
  }
  return undefined
}

/** Only `waitUntil` is needed — a narrower type than Hono's own `ExecutionContext` re-export so
 *  callers can pass `c.executionCtx` regardless of which `ExecutionContext` shape it structurally is. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void
}

export function writeCache<T>(route: string, key: string, value: T, ctx: WaitUntil): void {
  isolateLru.set(key, value)
  try {
    const cache = (caches as unknown as { readonly default: Cache }).default
    const res = new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })
    ctx.waitUntil(cache.put(syntheticUrl(route, key), res))
  } catch {
    // best-effort only — the isolate LRU already has it.
  }
}

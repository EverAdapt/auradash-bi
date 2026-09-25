/**
 * OWNER: planner. Stable JSON stringification (keys sorted, recursively) used for cache keys —
 * the Worker's SHA-256(JEV_MODEL + canonical body) and the browser client's LRU key — so the
 * same request always hashes the same way regardless of property insertion order.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sort(value))
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sort((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

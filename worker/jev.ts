/**
 * OWNER: planner. Lazy per-isolate `TypeSafeClient` singleton, plus the "does this look like a
 * real key" heuristic (reused from shapeshift's src/lib/jev/client.ts `looksLikeKey`).
 */
import { TypeSafeClient } from "@typesafe-ai/sdk"

/** A real-looking key: not empty and not a copied placeholder like "sk-..." or "your-key-here". */
export function looksLikeKey(key: string | undefined): key is string {
  const k = key?.trim() ?? ""
  return k.length >= 12 && !/\.\.\.|your|xxx|placeholder|changeme|<|>/i.test(k)
}

let client: TypeSafeClient | undefined

/** One client per warm isolate — cheap to reuse, and the SDK has no per-request state. */
export function getJevClient(env: Env): TypeSafeClient {
  if (!client) {
    client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, defaultModel: env.JEV_MODEL, timeout: 3500, retry: { maxRetries: 0 } })
  }
  return client
}

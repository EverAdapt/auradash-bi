/**
 * OWNER: platform. Public-demo flag. The Worker reports it from GET /api/health ({ demo: true }
 * when the DEMO_MODE var is "true"); the repo's default build runs with demo off (uploads on).
 * Also carries `telemetry` from the same response, so `lib/telemetry.ts` doesn't need its own
 * fetch — one `/api/health` call at startup answers both questions.
 */
import { create } from "zustand"

interface DemoState {
  /** true on the public demo: uploads greyed out, only bundled datasets answered */
  demo: boolean
  /** true when the Worker has an EVENTS binding (anonymous interaction history is being recorded) */
  telemetry: boolean
  loaded: boolean
}

export const useDemo = create<DemoState>(() => ({ demo: false, telemetry: false, loaded: false }))

let loaded = false

/** Reads the flag once at startup (idempotent) — safe to call from multiple components. */
export async function loadDemoFlag(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const res = await fetch("/api/health")
    if (!res.ok) return
    const body = (await res.json()) as { demo?: boolean; telemetry?: boolean }
    useDemo.setState({ demo: body.demo === true, telemetry: body.telemetry === true, loaded: true })
  } catch {
    // Offline / network error: stay with the safe defaults (demo off, telemetry off).
    useDemo.setState({ loaded: true })
  }
}

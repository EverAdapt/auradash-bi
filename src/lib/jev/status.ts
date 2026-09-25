/**
 * OWNER: planner. Jev status the UI reads to show "Jev" vs "Offline" ("How Jev read this" panel,
 * a quiet corner of the shell — no fixed model HUD). Updated by client.ts after
 * every plan/chart call, plus a one-shot health check other code can call any time.
 */
import { create } from "zustand"
import type { JevMeta } from "@shared/contract"

export interface JevStatusState {
  mode: "jev" | "offline" | "unknown"
  reason?: string
  lastMeta?: JevMeta
  report: (meta: JevMeta) => void
}

export const useJevStatus = create<JevStatusState>((set) => ({
  mode: "unknown",
  report: (meta) => set({ mode: meta.source === "offline" ? "offline" : "jev", reason: meta.reason, lastMeta: meta }),
}))

interface HealthResponse {
  mode: "jev" | "offline"
  model: string
}

let healthChecked = false

/** GET /api/health once per session; updates the store as a side effect. */
export async function getHealth(): Promise<HealthResponse | null> {
  if (healthChecked) return null
  healthChecked = true
  try {
    const res = await fetch("/api/health")
    if (!res.ok) return null
    const data = (await res.json()) as HealthResponse
    useJevStatus.setState({ mode: data.mode, reason: data.mode === "offline" ? "the server reports offline" : undefined })
    return data
  } catch {
    return null
  }
}

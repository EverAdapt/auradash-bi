/**
 * Status-dot data for the shell, read from the global Jev status (`@/lib/jev/status`): the
 * one-shot /api/health check says whether the server has a key, and every plan/chart call
 * reports its JevMeta. The pipeline's last meta (`src/state/ui.ts`) is the fallback.
 */
import { useEffect } from "react"
import { getHealth, useJevStatus as useGlobalJevStatus } from "@/lib/jev/status"
import { useUiStore } from "@/state/ui"

export type JevStatusSource = "jev" | "offline" | "cache" | "baked" | "unknown"

export interface JevStatus {
  source: JevStatusSource
  model: string | null
  latencyMs: number | null
  /** short label for the tooltip, e.g. "Jev · jev-1.13.0 · 640 ms" or "Offline planner" */
  label: string
}

const SOURCE_LABEL: Record<JevStatusSource, string> = {
  jev: "Jev is answering",
  offline: "Offline planner",
  cache: "Answered from cache",
  baked: "Answered from a baked Try prompt",
  unknown: "Jev is ready",
}

const REASON_LABEL: Record<string, string> = {
  no_key: "no API key",
  rate_limited: "busy, rate limited",
  timeout: "Jev timed out",
  error: "Jev is unavailable",
}

/** Safe to call before any question was asked; triggers the health check once. */
export function useJevStatus(): JevStatus {
  useEffect(() => {
    void getHealth()
  }, [])
  const global = useGlobalJevStatus()
  const localMeta = useUiStore((s) => s.lastJevMeta)
  const meta = global.lastMeta ?? localMeta ?? null

  if (!meta) {
    const source: JevStatusSource = global.mode === "offline" ? "offline" : "unknown"
    const label =
      global.mode === "offline"
        ? `${SOURCE_LABEL.offline} (${REASON_LABEL[global.reason ?? ""] ?? "server offline"})`
        : global.mode === "jev"
          ? "Jev is online"
          : SOURCE_LABEL.unknown
    return { source, model: null, latencyMs: null, label }
  }

  const base = SOURCE_LABEL[meta.source] ?? SOURCE_LABEL.unknown
  const label =
    meta.source === "offline"
      ? `${base}${meta.reason ? ` (${REASON_LABEL[meta.reason] ?? meta.reason})` : ""}`
      : `${base} · ${meta.model} · ${Math.round(meta.latencyMs)} ms`
  return { source: meta.source, model: meta.model, latencyMs: meta.latencyMs, label }
}

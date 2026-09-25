/**
 * OWNER: platform. Anonymous interaction history for improving the product (public demo only).
 * Fire-and-forget: never throws, never blocks the UI, no-ops when the Worker has no events store
 * (checked via `lib/demo.ts`'s `useDemo().telemetry`, itself sourced from one `/api/health` call).
 */
import { useDemo } from "@/lib/demo"
import { STORAGE_PREFIX } from "@/lib/site"

/** Runtime array (not just a type) so the Worker's zod schema can validate against the same list. */
export const TELEMETRY_EVENT_TYPES = [
  "result", // an answer was shown (plan + chart summary)
  "try_prompt", // a Try chip / palette prompt was used
  "pin", // pinned to the dashboard
  "chart_switch", // the user picked another chart type
  "slot_change", // the user changed an interpretation chip
  "did_you_mean", // the user picked a Did-you-mean alternative
  "feedback", // thumbs up / down on an answer
] as const

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number]

export interface TelemetryEvent {
  type: TelemetryEventType
  datasetId?: string
  question?: string
  /** small JSON payload: e.g. { chart: "hbar", rows: 10 } or { value: "up" } */
  data?: Record<string, unknown>
}

/** Shown in the footer (and Data page) whenever interaction history is being recorded. */
export const TELEMETRY_NOTICE =
  "Questions and interactions are recorded anonymously to improve auradash-bi. No personal data or IP addresses are stored."

const SESSION_KEY = `${STORAGE_PREFIX}:session`
let sessionId: string | undefined

/** One random id per browser, persisted in localStorage — not tied to any account or identity. */
function getSessionId(): string {
  if (sessionId) return sessionId
  try {
    const stored = localStorage.getItem(SESSION_KEY)
    if (stored) {
      sessionId = stored
      return stored
    }
  } catch {
    // localStorage unavailable (private mode, blocked storage) — fall through to an in-memory id.
  }
  const fresh = crypto.randomUUID()
  sessionId = fresh
  try {
    localStorage.setItem(SESSION_KEY, fresh)
  } catch {
    // Best-effort persistence only.
  }
  return fresh
}

/**
 * Fires an anonymous event at POST /api/events. Never throws and never awaits the network:
 * `sendBeacon` when available (survives navigation), a keepalive `fetch` otherwise. No-ops when
 * telemetry isn't enabled for this deploy.
 */
export function logEvent(event: TelemetryEvent): void {
  try {
    if (!useDemo.getState().telemetry) return
    const body = JSON.stringify({ ...event, session: getSessionId() })
    if (typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" })
      if (navigator.sendBeacon("/api/events", blob)) return
    }
    void fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {})
  } catch {
    // Telemetry must never break the app.
  }
}

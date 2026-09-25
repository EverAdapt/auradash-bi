/**
 * OWNER: lead (read-only for implementers). The interpretation chips ("slots") the UI shows and
 * lets people change — shared by interpret.ts and filters.ts. `applyChoice` (index.ts) maps a
 * SlotKey back onto the matching `PlanAnswers` field generically.
 */

/** A slot the UI can show and let the user change. Filters are `filter:<candidate id>`. */
export type SlotKey =
  | "answerKind"
  | "measure"
  | "measure2"
  | "groupBy"
  | "timeGrain"
  | "limit"
  | "rowTable"
  | "sortColumn"
  // v0.2 single-answer slots
  | "missing"
  | "per"
  | "timeCalc"
  // per-candidate slots: <prefix>:<candidate id>
  | `filter:${string}`
  | `role:${string}`
  | `threshold:${string}`
  | `text:${string}`
  | `combine:${string}`
  | `window:${string}`

export interface SlotOption {
  key: string
  display: string
  p: number
}

/** One interpretation chip: "Measure: Prizes won (0.97)". Only slots the compiled plan uses. */
export interface SlotView {
  slot: SlotKey
  label: string // "Measure", "Grouped by", "Over", "Filter", "Show"
  value: string // chosen option key
  display: string // "Prizes won"
  confidence: number
  /** top options (≤ 5, chosen first) so a chip can open a picker */
  options: SlotOption[]
}

/** Top options of a Choice (chosen first) for a chip's picker. */
export function topOptions(probabilities: Record<string, number>, textOf: (key: string) => string, n = 5): SlotOption[] {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, p]) => ({ key, display: textOf(key), p }))
}

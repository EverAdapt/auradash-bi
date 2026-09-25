/**
 * OWNER: ask-board. Calm-UI state machine for the ask panel's preview stage, adapted from shapeshift's
 * calm-UI state machine. A stream of `AskResult`s (one per
 * debounced keystroke, via `useAsk`) is folded into three states:
 *
 *   input      nothing confident enough to preview
 *   ghost      a faded live preview (confidence < 0.3; plan confidence is the MIN over used slots); Tab accepts it
 *   committed  a full preview; Enter (re-)runs the current text, Ctrl/Cmd+Enter (or the Pin
 *              button) pins it
 *
 * The identity of *what the user is asking* is the question's TEXT, not the compiled query: every
 * shown preview records the normalized text (`normalizeQuestion`) it was computed for as
 * `mem.shownText`. That's what tells apart two situations that used to be conflated:
 *
 *   - a result for the SAME text as what's shown (a re-fold — e.g. Jev's own retry variance): a
 *     differently-compiled challenger must win twice in a row, or be >= 0.85 confident, before it
 *     replaces a committed preview, so the stage doesn't flicker.
 *   - a result for a DIFFERENT text (the user edited the question): it always replaces the
 *     preview immediately once it clears the `inputBelow` floor — the user moved on, so there is
 *     nothing to defend. (A result for text that's no longer in the input at all — the user kept
 *     typing past it — never reaches `decide` in the first place: `useAsk` aborts/ignores it.)
 *
 * A preview the user forced (a Try chip, a Did-you-mean pick, an interpretation-chip choice, or
 * an explicit Enter run) stays exactly as long as the normalized text it was forced for is
 * unchanged; ANY edit releases it — not a Levenshtein-distance threshold, however small the edit
 * (appending " since 1980" or " vs 1986" is exactly the case this replaces).
 *
 * Shapeshift keys this machine by intent (which of several card types matched); auradash-bi has one
 * question compiling to one SQL statement, so the identity of "the same interpretation" (for the
 * same-text challenger rules, and for the ask panel's per-interpretation result cache) is the
 * compiled SQL's signature (`compiled.sql` + its bound params) instead.
 *
 * "Did you mean" chips are NOT part of this state machine: `PlanOutcome.alternatives` already
 * carries the planner's runner-ups (p >= 0.15 on the measure/groupBy slot), fresh on every outcome,
 * so the ask panel reads them directly alongside whatever `ui` this machine returns.
 *
 * Staleness (the live input text having moved on from `shownText`) is NOT this module's concern —
 * the ask panel compares the live `text` to `mem.shownText` itself to drive the calm
 * "Updating…" / "Press Enter to update" indicators, so a stale-but-still-relevant preview keeps
 * showing real data instead of blanking out.
 */
import type { PlanOutcome } from "@/lib/plan"

export type DecideKey = string

export type UiState =
  | { kind: "input" }
  | { kind: "ghost"; key: DecideKey }
  | { kind: "committed"; key: DecideKey; forced?: boolean }

export const THRESHOLDS = {
  /** below this, nothing previews at all ("keep typing"). */
  inputBelow: 0.12,
  /** below this (and >= inputBelow), the preview is a ghost. */
  commitAt: 0.3,
  /** a challenger this confident replaces a committed preview immediately. */
  challengerOverride: 0.85,
  /** otherwise a challenger needs this many consecutive wins to take over. */
  challengerWins: 2,
  /** a committed preview whose own probability falls below this (with no confident challenger) drops to input. */
  dropBelow: 0.1,
} as const

export interface DecideMemory {
  ui: UiState
  /** normalized text (see `normalizeQuestion`) the currently-shown `ui` preview was computed
   *  for; null while `ui.kind === "input"`. */
  shownText: string | null
  /** a different interpretation currently beating the committed one (same-text re-folds only). */
  challenger: { key: DecideKey; wins: number } | null
  /** normalized text the shown preview was forced for; null when it isn't forced. */
  forcedText: string | null
}

export const initialMemory: DecideMemory = {
  ui: { kind: "input" },
  shownText: null,
  challenger: null,
  forcedText: null,
}

/** Trim, lowercase, collapse whitespace, and drop a trailing `?`/`.`/`!` run — two questions that
 *  only differ by casing, spacing or a final "?" are the same question for stickiness purposes. */
export function normalizeQuestion(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/, "")
}

/** The compiled SQL is the identity of "the same interpretation" (the equivalent of shapeshift's intent). */
export function signatureOf(outcome: PlanOutcome): DecideKey | null {
  if (outcome.status !== "ok" || !outcome.compiled) return null
  return `${outcome.compiled.sql}\u0000${JSON.stringify(outcome.compiled.params)}`
}

function probabilityOf(outcome: PlanOutcome, key: DecideKey): number {
  return signatureOf(outcome) === key ? outcome.confidence : 0
}

/** Stateless mapping from one outcome to a UI state, ignoring hysteresis. */
export function rawState(outcome: PlanOutcome): UiState {
  const key = signatureOf(outcome)
  if (!key || outcome.confidence < THRESHOLDS.inputBelow) return { kind: "input" }
  if (outcome.confidence < THRESHOLDS.commitAt) return { kind: "ghost", key }
  return { kind: "committed", key }
}

/**
 * Fold a new outcome into the calm UI state. `text` is the text the outcome was computed for
 * (i.e. `askedText` — may lag the live input while a newer question is still debouncing/in
 * flight; that's fine, this function only ever sees outcomes for text that was actually asked).
 */
export function decide(
  mem: DecideMemory,
  outcome: PlanOutcome,
  text: string
): DecideMemory {
  const normalized = normalizeQuestion(text)
  if (!normalized) return initialMemory
  const prev = mem.ui

  // A forced preview sticks only while the normalized text it was forced for is unchanged.
  if (
    prev.kind === "committed" &&
    prev.forced &&
    mem.forcedText === normalized
  ) {
    return mem
  }

  const raw = rawState(outcome)
  const key = signatureOf(outcome)
  const sameText = mem.shownText === normalized

  // Hysteresis (challenger must win twice, or be very confident) only defends a committed
  // preview against re-folds of the SAME text — a different text always gets a fresh verdict.
  if (prev.kind === "committed" && !prev.forced && sameText) {
    const current = prev.key
    if (key === current) {
      return {
        ui: { kind: "committed", key },
        shownText: normalized,
        challenger: null,
        forcedText: null,
      }
    }

    const held: UiState = { kind: "committed", key: current }
    const currentP = probabilityOf(outcome, current)

    if (!key) {
      if (currentP < THRESHOLDS.dropBelow) return initialMemory
      return { ui: held, shownText: normalized, challenger: null, forcedText: null }
    }

    if (outcome.confidence >= THRESHOLDS.challengerOverride) {
      return { ui: raw, shownText: normalized, challenger: null, forcedText: null }
    }
    const wins = mem.challenger?.key === key ? mem.challenger.wins + 1 : 1
    if (
      wins >= THRESHOLDS.challengerWins &&
      outcome.confidence >= THRESHOLDS.inputBelow
    ) {
      return { ui: raw, shownText: normalized, challenger: null, forcedText: null }
    }
    if (
      currentP < THRESHOLDS.dropBelow &&
      outcome.confidence < THRESHOLDS.inputBelow
    ) {
      return initialMemory
    }
    return {
      ui: held,
      shownText: normalized,
      challenger: { key, wins },
      forcedText: null,
    }
  }

  // Different text than what's shown (or nothing shown yet, or a ghost, or a forced preview
  // whose text has moved on): a fresh outcome for this text takes over immediately, subject only
  // to the input/ghost/commit confidence thresholds. There is no "same interpretation" to defend.
  return {
    ui: raw,
    shownText: raw.kind === "input" ? null : normalized,
    challenger: null,
    forcedText: null,
  }
}

/** The user picked a preview explicitly (a Try chip, a Did-you-mean chip, an interpretation
 *  chip, or an explicit Enter run): commits immediately and sticks until the text changes. */
export function force(key: DecideKey, text: string): DecideMemory {
  const normalized = normalizeQuestion(text)
  return {
    ui: { kind: "committed", key, forced: true },
    shownText: normalized,
    challenger: null,
    forcedText: normalized,
  }
}

/** Tab on a ghost: promote without locking (not forced, so a same-text challenger can still win). */
export function promote(mem: DecideMemory): DecideMemory {
  if (mem.ui.kind !== "ghost") return mem
  return {
    ui: { kind: "committed", key: mem.ui.key },
    shownText: mem.shownText,
    challenger: null,
    forcedText: null,
  }
}

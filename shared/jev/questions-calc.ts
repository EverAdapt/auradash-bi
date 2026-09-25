/**
 * OWNER: implementer B (calculations). v0.2 Jev questions about HOW the amount is calculated,
 * asked only when a generic English cue gates them (PlanRequest.cues, found by code), so ordinary
 * questions cost no extra Jev questions:
 *   per        (cues.rate)   — is the measure divided by another measure? options: measures + "none"
 *   time_calc  (cues.change) — the amount / change vs previous period / % change / running total
 * Wording is dataset-agnostic (no dataset nouns); options are schema-derived or fixed.
 *
 * planQuestions (questions.ts) spreads `calcQuestions(req)` into the plan call and
 * normalizePlanAnswers spreads `normalizeCalcAnswers(raw, req)` into the answers.
 */
import { choice, type ChoiceResponse, type Questions } from "@typesafe-ai/sdk"
import type { PlanAnswers, PlanRequest, TimeCalc } from "../contract"
import { NONE, toAnswer, withEscape } from "./util"

/** `time_calc` only makes sense over a continuous time axis (year/decade/quarter/month/day), never
 *  a cyclical fold (weekday/month_of_year/hour) — there is no "previous period" to compare a
 *  Tuesday against. */
const ABSOLUTE_GRAINS = new Set(["year", "decade", "quarter", "month", "day"])

/**
 * Question ids (the contract between this file's two halves): `per`, `time_calc`.
 */
export function calcQuestions(req: PlanRequest): Questions {
  const questions: Questions = {}

  if (req.cues?.rate) {
    questions.per = choice(
      "Does `question` divide one amount by a SECOND, DIFFERENT amount to compute a NEW rate — 'X per Y', 'X for every Y', 'ratio of X to Y' — where Y is itself an amount (a count or a total), not a category? If the amount `question` asks for is ALREADY its own rate or average by construction (its own meaning already reads as 'amount per something', e.g. a per-person/per-unit figure or an average), that is not a further division. If so, which amount is the divisor?",
      withEscape(
        req.measures,
        NONE,
        "Nothing is divided: the amount asked for is already its own rate or average with no further division needed, 'per' names a category the results are already being broken down by — one result per group, so each group's own division would just be 1 (per group, per year, per type) — or no rate is asked",
      ),
    )
  }

  if (req.cues?.change && req.timeGrains.some((g) => ABSOLUTE_GRAINS.has(g))) {
    questions.time_calc = choice("What does `question` want computed over time — the amount itself, or something derived from how it moves from one period to the next?", {
      none: "The amount itself, with no change or cumulative calculation",
      change: "The difference from the previous period — how much it changed, up or down",
      pct_change: "The percentage change from the previous period — the growth rate",
      running_total: "The cumulative / running total so far, adding each period to the ones before it",
    } satisfies Record<TimeCalc, string>)
  }

  return questions
}

export function normalizeCalcAnswers(raw: Record<string, unknown>, req: PlanRequest): Pick<PlanAnswers, "per" | "timeCalc"> {
  const out: Pick<PlanAnswers, "per" | "timeCalc"> = {}
  if (req.cues?.rate && raw.per) out.per = toAnswer(raw.per as ChoiceResponse)
  if (req.cues?.change && raw.time_calc) out.timeCalc = toAnswer<TimeCalc>(raw.time_calc as ChoiceResponse)
  return out
}

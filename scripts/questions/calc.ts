/**
 * OWNER: implementer B (calculations). v0.2 feature questions for `bun scripts/plan-cli.ts --v02`.
 * At least 3 questions per feature, across at least two datasets, each with an `expect` regex
 * proving the feature fired. Also add 2+ plain questions with `reject` proving it stays off.
 *
 * Share questions are listed but not yet expected to fire: `plan.share` is built by implementer A
 * (filters.ts's `buildShare`, still a stub at the time this file was written) and only lands at
 * merge — see the final report's "Contract/lead-file issues" section. They stay here so the bar
 * covers share the moment A's piece lands, without anyone having to remember to add them.
 */
import type { V02Question } from "./types"

export const QUESTIONS: V02Question[] = [
  // ─────────────────────────────── per (NULLIF division) ───────────────────────────────
  { dataset: "nobel", q: "Number of prizes divided by number of categories", expect: [/NULLIF/] },
  { dataset: "nobel", q: "Number of laureates divided by number of birth countries", expect: [/NULLIF/] },
  { dataset: "afl", q: "Number of matches divided by number of venues", expect: [/NULLIF/] },

  // ─────────────────────────────── time_calc: change ───────────────────────────────
  { dataset: "nobel", q: "How has the average age at award changed over time?", expect: [/LAG\(/, /OVER \(/] },
  { dataset: "afl", q: "How has the grand final margin changed over time?", expect: [/LAG\(/, /OVER \(/] },

  // ─────────────────────────────── time_calc: pct_change ───────────────────────────────
  { dataset: "world", q: "How has world population grown year over year?", expect: [/LAG\(/, /100\.0 \*/] },
  { dataset: "world", q: "Year-over-year % change in CO2 emissions", expect: [/LAG\(/, /100\.0 \*/] },

  // ─────────────────────────────── time_calc: running_total ───────────────────────────────
  { dataset: "nobel", q: "Prizes awarded per decade, running total", expect: [/SUM\(.*\) OVER \(/, /ROWS UNBOUNDED PRECEDING/] },
  { dataset: "world", q: "Cumulative CO2 emissions since 1990", expect: [/SUM\(.*\) OVER \(/, /ROWS UNBOUNDED PRECEDING/] },

  // ─────────────────────────────── bands ───────────────────────────────
  // Worded as a ranking ("which ... has the most") rather than a bare "X by Y band": a band
  // grouping is visually a histogram, so a flatter phrasing competes with v0.1's own `distribution`
  // answer kind (also a histogram) for which one Jev picks — a ranking cue reliably tips it to the
  // `aggregate` (band groupBy) reading this feature is meant to demonstrate.
  { dataset: "nobel", q: "Which age band has the most laureates?", expect: [/CASE WHEN .* THEN/] },
  { dataset: "world", q: "Countries by life expectancy band", expect: [/CASE WHEN .* THEN/] },
  { dataset: "swift", q: "Which song length band has the most songs?", expect: [/CASE WHEN .* THEN/] },

  // ─────────────────────────────── cyclical grains: weekday ───────────────────────────────
  { dataset: "afl", q: "Which day of the week has the most matches?", expect: [/strftime\('%w'/] },
  { dataset: "nobel", q: "Laureates by day of the week they were born", expect: [/strftime\('%w'/] },

  // ─────────────────────────────── cyclical grains: month of year ───────────────────────────────
  { dataset: "afl", q: "Matches by month of the year", expect: [/strftime\('%m'/] },
  { dataset: "swift", q: "Songs released by month of year", expect: [/strftime\('%m'/] },

  // ─────────────────────────────── share (needs A's plan.share — see header note) ───────────────────────────────
  { dataset: "nobel", q: "What share of laureates are women?", expect: [/100\.0 \*/, /NULLIF/] },
  { dataset: "afl", q: "Share of matches won by the home team", expect: [/100\.0 \*/, /NULLIF/] },

  // ─────────────────────────────── plain questions: no window function, no NULLIF on a plain total ───────────────────────────────
  { dataset: "nobel", q: "How many Nobel prizes has France won?", reject: [/LAG\(/, /OVER \(/, /NULLIF/] },
  { dataset: "world", q: "Top 5 countries by population", reject: [/LAG\(/, /OVER \(/, /NULLIF/] },
  { dataset: "afl", q: "Which clubs have played in a grand final?", reject: [/LAG\(/, /OVER \(/, /NULLIF/] },
]

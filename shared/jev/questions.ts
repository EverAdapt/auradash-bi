/**
 * OWNER: planner. Every Jev question definition, wording and threshold in one place — for the
 * plan call (Worker, offline planner via the same shapes, and scripts/plan-cli.ts) and the chart
 * call. Jev never sees or writes SQL: every Choice's options are allow-listed parts of the query
 * that code derived from the schema, and every Choice has an escape option ("none" / "not_stated"
 * / "not_a_filter"). See docs/research/jev-nl2sql.md and docs/research/probes/probe2.mjs,
 * probe_chart.mjs — the wording below reuses probe2's exact phrasing, which scored 12/12 live.
 */
import { choice, noul, type ChoiceCriteria, type ChoiceResponse, type NoulQuestion, type NoulResponse, type Questions } from "@typesafe-ai/sdk"
import type { Answer, AnswerKind, ChartRequest, ChartType, PlanAnswers, PlanRequest, SortAnswer, TimeGrain } from "../contract"
import { calcQuestions, normalizeCalcAnswers } from "./questions-calc"
import { filterQuestions, normalizeFilterAnswers } from "./questions-filters"
import { NONE, toAnswer, withEscape } from "./util"

// ─────────────────────────────── thresholds (the only copy) ───────────────────────────────

/** in_scope.noul below this -> out_of_scope (semantic_find gate). */
export const IN_SCOPE_MIN = 0.3
/** answer_kind.probabilities.unanswerable at or above this -> out_of_scope too. */
export const UNANSWERABLE_MIN_P = 0.5
/** aggregate + measure "none" at or above this probability -> no_match (fall back to a count). */
export const NO_MEASURE_MATCH_MIN_P = 0.6
/** a runner-up option needs at least this probability to become a "Did you mean" alternative. */
export const ALTERNATIVE_MIN_P = 0.15
/** top-choice confidence below this shows the "Jev wasn't sure" badge (consistency cookbook). */
export const LOW_CONFIDENCE_FLOOR = 0.5
/** max "Did you mean" chips shown. */
export const MAX_ALTERNATIVES = 2
/** relationship.noul at or above this -> trust `relationship_x`/`relationship_y` over the plain
 *  `measure`/`measure2` choices (see "call 1: plan" below). */
export const RELATIONSHIP_MIN = 0.5

// ─────────────────────────────── call 1: plan ───────────────────────────────

const TIME_GRAIN_TEXT: Partial<Record<Exclude<TimeGrain, "none">, string>> = {
  year: "Per year, yearly, annual",
  decade: "Per decade",
  quarter: "Per quarter",
  month: "Per month, monthly",
  day: "Per day, daily",
  // v0.2 cyclical steps: request.ts only offers them for a real date column (hour only with times)
  weekday: "Per day of the week — a weekly pattern (Monday to Sunday), every week folded together",
  month_of_year: "Per month of the year — a seasonal pattern (January to December), every year folded together",
  hour: "Per hour of the day — a daily pattern (0 to 23), every day folded together",
}

function planState(req: PlanRequest) {
  return { question: req.question, dataset: { name: req.dataset.name, about: req.dataset.about, contains: req.dataset.contains } }
}

/** Builds every question for the plan call, from a request whose options code already derived. */
export function planQuestions(req: PlanRequest): Questions {
  const inScope: NoulQuestion = noul("Is `question` asking for information that is recorded in `dataset`?", {
    true: "It asks about people, places, amounts, events or trends described in `dataset`",
    false: "It asks about something `dataset` does not record, or it is not a question about data at all",
  })

  const timeGrainOptions: Record<string, string> = { none: "No breakdown over time" }
  for (const g of req.timeGrains) if (g !== "none" && TIME_GRAIN_TEXT[g]) timeGrainOptions[g] = TIME_GRAIN_TEXT[g]!

  const limitOptions: Record<string, string> = {
    one: "Only the single top or bottom item, e.g. which one sells the most",
    not_stated: "The question does not say how many",
  }
  for (const n of req.numbers) limitOptions[`n${n}`] = `The number ${n} as written in the question`

  const questions: Questions = {
    in_scope: inScope,
    answer_kind: choice("What does `question` want to see?", {
      aggregate:
        "A number computed per category, place or time: a total, count or average; a breakdown split into named categories, regions or groups; a ranking ('top N', 'the most', 'the least', 'the highest/lowest'); a comparison between two or more items or amounts ('X vs Y', 'do X have more Y than Z'); or 'where' (across many places) a measure is high, low or spread out — even when each item already has only one row to begin with",
      rows: "Asks by name to list, show or name specific individual records side by side with several fields each — e.g. 'list the ...', 'show me the ...', 'who are the ...', or 'where' each individual record itself is (its own location) — with no amount being ranked, compared or totalled across them",
      distribution: "How ONE amount's own individual values are spread across its full range, bucketed into equal-width bands (a histogram) — e.g. 'how old are items when something happens to them', 'the shape of an amount across every item, from lowest to highest' — NOT a breakdown split into named categories, regions or groups (that is `aggregate`)",
      unanswerable: "Something that cannot be answered from `dataset`",
    } satisfies Record<AnswerKind, string>),
    measure: choice(
      "Which amount does `question` ask to calculate, count or rank items by? Not the category being grouped by, filtered to, or named as the answer's own subject — e.g. 'which GROUPS have the most ITEMS' calculates items, grouped by group, not a count of groups.",
      withEscape(req.measures, NONE, "No amount is calculated"),
    ),
    measure2: choice(
      "Does `question` plot a SECOND, DIFFERENT KIND of amount against the first for the same items (a relationship) — e.g. one amount against another in 'does a higher X mean a higher Y'? If so, which one is the second amount? (Naming a few specific items to compare on the SAME one amount, like 'the amount for A vs B vs C', is NOT this — no second amount there, just a filter to those items.)",
      withEscape(req.measures, NONE, "No second, different amount is compared — including when the question just names a few specific items to compare on one amount"),
    ),
    // A dedicated, explicit x/y pair for relationship questions: a single flat "which is the
    // second amount" choice keeps missing indirect wording (a comparative like "richer" implying
    // one measure, "live longer" implying another, neither named directly), so a gate plus two
    // clearly-labelled amount picks replace it whenever `relationship` is confidently true (see
    // normalizePlanAnswers below).
    relationship: noul(
      "Does `question` ask whether two DIFFERENT KINDS of amount move together across many items — a relationship or correlation, such as 'does a bigger X mean a bigger Y', 'is there a link between X and Y', or plotting one amount against a different amount for the same items?",
      {
        true: "Yes — it wants to see how one amount relates to a different amount, across many items",
        false: "No — it wants one amount only: a total, ranking, trend or breakdown, or a comparison of a few NAMED items on that SAME one amount (like 'the amount for A vs B')",
      },
    ),
    relationship_x: choice(
      "If `question` asks whether two amounts move together (see `relationship`), which is the FIRST one — often the potential cause, or the amount described more indirectly rather than named outright, e.g. an amount implied by a word like 'bigger' or 'higher'?",
      withEscape(req.measures, NONE, "Not a relationship question"),
    ),
    relationship_y: choice(
      "If `question` asks whether two amounts move together (see `relationship`), which is the SECOND, DIFFERENT one — often the potential effect, e.g. the amount implied by a word like 'more' or 'longer' that the first amount is said to affect?",
      withEscape(req.measures, NONE, "Not a relationship question"),
    ),
    group_by: choice(
      "Does `question` ask for a separate result for each value of a category — by, per, each, which, top N, or a scope like 'around the world'/'place by place'/'worldwide' that implies one result per place rather than a single combined figure? If so, which category? A comparative word describing the amount itself (richer, bigger, faster) is not a category to group by — that just names which amount to measure.",
      withEscape(req.dimensions, NONE, "One combined result for everything; a value used only as a filter does not count as grouping"),
    ),
    time_grain: choice("Does `question` ask to break results down over time, and at what step?", timeGrainOptions),
    sort: choice("In what order should the results be shown?", {
      desc: "Largest or most first: top, most, highest, best, longest",
      asc: "Smallest or least first: bottom, least, lowest, shortest",
      chronological: "In time order",
      none: "No order is implied",
    } satisfies Record<SortAnswer, string>),
    limit: choice("How many results does `question` ask to show?", limitOptions),
    row_table: choice("If `question` wants individual records, which kind of record?", withEscape(req.rowTables, NONE, "It does not want individual records")),
    sort_column: choice("If `question` wants individual records, which field decides their order?", withEscape(req.sortColumns, NONE, "No sort field is implied")),
    named_chart: choice("Does `question` name a specific kind of chart to show the answer as?", {
      none: "No chart type is named",
      bar: "A bar or column chart",
      line: "A line chart or trend line",
      pie: "A pie or donut chart",
      scatter: "A scatter plot",
      map: "A map",
      table: "A table or list",
      histogram: "A histogram",
    }),
  }

  return { ...questions, ...filterQuestions(req), ...calcQuestions(req) }
}

/** The raw shape of `client.systemOne({ questions: planQuestions(req) })`'s `answers`. */
export type RawPlanAnswers = Record<string, ChoiceResponse | NoulResponse> & { in_scope: NoulResponse }

/**
 * Whether to trust `relationship_x`/`relationship_y` over the plain `measure`/`measure2` choices:
 * the gate is confidently true, both named a real (and different) measure. Falling short of any
 * of these leaves `measure`/`measure2` exactly as the non-relationship choices answered them, so a
 * low `relationship` score never costs a normal aggregate its measure.
 */
function pickRelationshipPair(raw: RawPlanAnswers): { x: ChoiceResponse; y: ChoiceResponse } | undefined {
  const gate = raw.relationship as NoulResponse | undefined
  const x = raw.relationship_x as ChoiceResponse | undefined
  const y = raw.relationship_y as ChoiceResponse | undefined
  if (!gate || (gate.noul ?? 0) < RELATIONSHIP_MIN) return undefined
  if (!x || !y || x.choice === NONE || y.choice === NONE || x.choice === y.choice) return undefined
  return { x, y }
}

/** Converts the raw systemOne answers of `planQuestions(req)` into the contract's `PlanAnswers`. */
export function normalizePlanAnswers(raw: RawPlanAnswers, req: PlanRequest): PlanAnswers {
  const c = <T extends string>(id: string) => toAnswer<T>(raw[id] as ChoiceResponse)
  const relationship = pickRelationshipPair(raw)
  return {
    inScope: raw.in_scope.noul,
    answerKind: c<AnswerKind>("answer_kind"),
    measure: relationship ? toAnswer(relationship.x) : c("measure"),
    measure2: relationship ? toAnswer(relationship.y) : c("measure2"),
    groupBy: c("group_by"),
    timeGrain: c("time_grain"),
    sort: c<SortAnswer>("sort"),
    limit: c("limit"),
    rowTable: c("row_table"),
    sortColumn: c("sort_column"),
    namedChart: c("named_chart"),
    ...normalizeFilterAnswers(raw, req),
    ...normalizeCalcAnswers(raw, req),
  }
}

// ─────────────────────────────── call 2: chart ───────────────────────────────

const CHART_TEXT: Record<ChartType, string> = {
  kpi: "One big number with a label",
  bar: "Vertical bars comparing one amount across a few categories or time buckets",
  hbar: "Horizontal bars ranking categories, good for many categories or long names",
  line: "A line showing how an amount changes over time",
  area: "A filled area showing a running or cumulative amount over time",
  multi_line: "One line per series over time, to compare trends",
  stacked_bar: "Bars split into stacked segments, showing composition per category or period",
  grouped_bar: "Bars for two or more series side by side within each category or period",
  donut: "A ring split into slices showing each category's share of a whole, for up to about 8 categories",
  scatter: "Dots placing each item by two different amounts, to show a relationship",
  bubble: "Dots placing each item by two amounts with a third amount as size, to show a relationship",
  histogram: "Bars counting how many items fall in each range of one amount",
  heatmap: "A grid of shaded cells showing an amount across two categories",
  choropleth: "A world map shaded by an amount per place",
  point_map: "A world map with one dot per record, placed by latitude and longitude",
  table: "A plain table of individual records with several fields",
}

/** Builds the single question for the chart call: rank the eligible chart types code computed. */
export function chartQuestions(req: ChartRequest): Questions {
  const criteria: ChoiceCriteria = {}
  for (const [type, why] of Object.entries(req.eligible)) criteria[type] = why || CHART_TEXT[type as ChartType]
  return { chart: choice("Which chart best answers `question` using `result`?", criteria) }
}

function chartState(req: ChartRequest) {
  return { question: req.question, result: req.result }
}

/** Converts the raw systemOne answer of `chartQuestions(req)` into the contract's `Answer<ChartType>`. */
export function normalizeChartAnswer(raw: { chart: ChoiceResponse }): Answer<ChartType> {
  return toAnswer<ChartType>(raw.chart)
}

// Exported for the Worker (assembles `{ state, questions }` for systemOne) and scripts/plan-cli.ts.
export { chartState, planState }

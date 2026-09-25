/**
 * OWNER: implementer A (filters). Every Jev question about something code FOUND in the question —
 * a stored value, a year / "now", and (v0.2) year ranges, relative periods, comparisons with a
 * number, text fragments, "or" pairs, rank windows and the missing-data cue — plus their
 * normalisers into `PlanAnswers`. Wording is dataset-agnostic: it may only use the candidate's own
 * fields (`display`, `field`, `matched`) and schema-derived option text, never a dataset's nouns.
 *
 * planQuestions (questions.ts) spreads `filterQuestions(req)` into the plan call and
 * normalizePlanAnswers spreads `normalizeFilterAnswers(raw, req)` into the answers.
 */
import { choice, type ChoiceCriteria, type ChoiceResponse, type Questions } from "@typesafe-ai/sdk"
import type { FilterCandidate, OrPair, PeriodUse, PlanAnswers, PlanRequest, RangeUse, RankWindowCandidate, TextCandidate, ThresholdCandidate, ValueFilterUse, YearFilterUse } from "../contract"
import { toAnswer } from "./util"

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s)

function filterQuestion(c: FilterCandidate) {
  const instructions = { value: c.display, field: c.field, question: "How does `question` use `value`?" }

  if (c.kind === "now") {
    // "value" here is the literal text found ("now", "today", "currently", "latest", ...) — the
    // options below spell out what it means (the most recent year the data has) so Jev judges the
    // SAME year uses (in_year/from/until/before/after/not_a_filter) as a real year candidate would.
    return choice(instructions, {
      in_year: `"${c.matched}" means right now / today / the latest data available — only rows for the most recent year in the data should be counted`,
      from: `"${c.matched}" means only rows from the most recent year in the data onwards should be counted, INCLUDING that year itself (e.g. "since now")`,
      until: `"${c.matched}" means only rows up to and including the most recent year in the data should be counted`,
      before: `"${c.matched}" means only rows strictly before the most recent year in the data should be counted, NOT including that year itself`,
      after: `"${c.matched}" means only rows strictly after the most recent year in the data should be counted, NOT including that year itself — a narrower reading than "since now"/"from now"`,
      not_a_filter: `"${c.matched}" is mentioned but should not restrict the rows by year`,
    } satisfies Partial<Record<YearFilterUse, string>>)
  }
  if (c.kind === "year") {
    return choice(instructions, {
      in_year: `Only rows for the year ${c.value} should be counted`,
      from: `Only rows from the year ${c.value} onwards should be counted, INCLUDING ${c.value} itself — this is what "since ${c.value}", "from ${c.value}", "${c.value} onwards" and "${c.value} or later" ordinarily mean`,
      until: `Only rows up to and including the year ${c.value} should be counted`,
      before: `Only rows strictly BEFORE the year ${c.value} should be counted, NOT including ${c.value} itself`,
      after: `Only rows strictly AFTER the year ${c.value} should be counted, NOT including ${c.value} itself — this is a narrower, stricter reading than "since"/"from", only for wording that explicitly excludes ${c.value} itself, e.g. "after ${c.value}", "later than ${c.value}", "following ${c.value}"`,
      not_a_filter: `${c.value} is mentioned but should not restrict the rows by year`,
    } satisfies Partial<Record<YearFilterUse, string>>)
  }
  if (c.kind === "range") {
    return choice(
      { span: c.display, field: c.field, question: "How does `question` use the span `span`?" },
      {
        between: `${c.display} is a continuous span — every value from ${c.value} to ${c.value2}, inclusive, should be counted`,
        separately: `Only the two endpoints ${c.value} and ${c.value2} themselves should be counted, compared side by side — not a continuous span between them`,
        not_a_filter: `${c.display} is mentioned but should not restrict the rows`,
      } satisfies Partial<Record<RangeUse, string>>,
    )
  }
  if (c.kind === "period") {
    return choice(
      { period: c.display, question: "Does `period` restrict which rows are counted?" },
      {
        within: `Only rows within the ${c.display} should be counted, ending at the most recent data available (not today's date)`,
        not_a_filter: `${c.display} is mentioned but should not restrict the rows`,
      } satisfies Partial<Record<PeriodUse, string>>,
    )
  }
  return choice(instructions, {
    include_only: `Only rows where the ${c.field} is ${c.display} should be counted — this is still true when the question names it alongside a few other specific items to compare on the SAME amount, e.g. "A vs B vs C" or "A and B" names each of them as an include`,
    exclude: `Rows where the ${c.field} is ${c.display} should be left out`,
    share: `The question asks what SHARE, PERCENTAGE, PROPORTION or FRACTION of the whole has the ${c.field} equal to ${c.display} — a part-of-the-whole calculation. The rows themselves are NOT restricted: every row is still counted, ${c.display} only defines which ones count as the "part" of the whole`,
    not_a_filter: `${c.display} is mentioned but should not restrict the rows — e.g. it means EVERYWHERE/globally/overall ('around the ${c.display}', 'across the board'), or it names the CATEGORY being grouped by or asked about in general, not one specific item to narrow down to`,
  } satisfies Partial<Record<ValueFilterUse, string>>)
}

/** The FK column's own catalog synonyms (`FilterCandidate.roles[].synonyms`, from the semantic
 *  layer via graph.ts's fkRoleGroupFor) as wording hints for the role — the data, not code, says
 *  which words mean "winner" or "home". No synonyms recorded: the role label alone. */
function roleWording(r: NonNullable<FilterCandidate["roles"]>[number]): string {
  if (r.synonyms?.length) return ` (wording like ${r.synonyms.map((s) => `'${s}'`).join(", ")} means this)`
  return ""
}

const lowerFirstRole = lowerFirst

/** Only asked for a candidate with `roles` (see `FilterCandidate.roles`): which of the several FK
 *  roles `value` plays in each row, or any of them — so "played in" resolves through every role
 *  column (home OR away OR ...) while "won"/"lost"/"home" resolve through the one specific FK
 *  column that role means. See filters.ts's buildFilters (sets `PlanFilter.via`) and where.ts's
 *  buildCondition (an OR of role-column membership subqueries, or a single one). */
function roleQuestion(c: FilterCandidate) {
  const instructions = { value: c.display, field: c.field, question: "Which part does `value` play in each row of `field`'s table?" }
  const criteria: ChoiceCriteria = {}
  for (const r of c.roles ?? []) {
    criteria[r.key] = `${c.display} is specifically the ${lowerFirstRole(r.label)}${roleWording(r)}`
  }
  criteria.any = "Took part in any of these roles, e.g. played, appeared, featured, was involved"
  return choice(instructions, criteria)
}

/** v0.2: `threshold:<id>` — what a comparison with a number is a condition ON: the calculated
 *  amount per group ("agg" -> HAVING), one specific record field ("agg" -> WHERE), or nothing. */
function thresholdQuestion(t: ThresholdCandidate, req: PlanRequest) {
  const instructions = { number: t.display, text: t.matched, question: "What does the comparison `text` (meaning `number`) put a condition ON?" }
  const criteria: ChoiceCriteria = { agg: "The calculated amount for each group or result overall — e.g. groups whose total, count or average passes this" }
  for (const [key, text] of Object.entries(req.sortColumns)) {
    const label = typeof text === "string" ? text : text.what
    criteria[key] = `Each individual record's own ${lowerFirst(label)} must pass this`
  }
  criteria.not_a_filter = "The number is not a condition on an amount at all — e.g. it is a count of how many results to show, a rank/position, or a year"
  return choice(instructions, criteria)
}

/** v0.2: `text:<id>` — which searchable field a text fragment is a condition on, or none. */
function textQuestion(x: TextCandidate, req: PlanRequest) {
  const instructions = { fragment: x.value, text: x.matched, question: "Which field is `fragment` searched for, in `text`?" }
  const criteria: ChoiceCriteria = {}
  for (const [key, text] of Object.entries(req.textColumns ?? {})) criteria[key] = text as ChoiceCriteria[string]
  criteria.not_a_filter = "The text is not something to search for in any field"
  return choice(instructions, criteria)
}

/** v0.2: `combine:<id>` — for two value candidates on different columns joined by "or": must BOTH
 *  hold on the same row, or is EITHER one enough (a union of two separate conditions)? */
function combineQuestion(pair: OrPair, req: PlanRequest) {
  const a = req.filters.find((f) => f.id === pair.a)
  const b = req.filters.find((f) => f.id === pair.b)
  const instructions = { first: a?.display ?? pair.a, second: b?.display ?? pair.b, question: "Must every row match BOTH `first` and `second` together, or is matching EITHER one alone enough?" }
  return choice(instructions, {
    both: "Both conditions must hold together, on the same row",
    either: "Matching either one alone is enough — rows for either are all counted (a union of the two)",
  } satisfies Record<"both" | "either", string>)
}

/** v0.2: `window:<id>` — is a "ranked N to M" / "the next N" mention really asking to show that
 *  slice of the ranking? */
function windowQuestion(w: RankWindowCandidate) {
  const instructions = { text: w.matched, from: w.from, to: w.to, question: "Does `text` ask to show only ranks `from` to `to` of the ranking?" }
  return choice(instructions, {
    window: "Yes — only that window of the ranking should be shown",
    not_a_filter: "No — it does not ask for a specific window of the ranking",
  })
}

/** v0.2: the single `missing` slot, asked only when `req.cues?.missing` is set and there is at
 *  least one nullable column to ask about. Capped well under the 254-option Choice limit. */
const MAX_MISSING_COLUMNS = 124 // 2 options per column + "none" stays <= 250

function missingQuestion(req: PlanRequest) {
  const instructions = { question: "Which field, if any, does `question` ask about having no value recorded (missing/unknown/not yet happened), or having one recorded?" }
  const criteria: ChoiceCriteria = {}
  let n = 0
  for (const [key, text] of Object.entries(req.nullableColumns ?? {})) {
    if (n >= MAX_MISSING_COLUMNS) break
    const label = typeof text === "string" ? text : text.what
    criteria[`${key}:missing`] = `${label} has no value recorded: missing, unknown, not happened yet, still ongoing`
    criteria[`${key}:present`] = `${label} has a value recorded`
    n++
  }
  criteria.none = "No field's missing-or-recorded status is being asked about"
  return choice(instructions, criteria)
}

/**
 * Question ids (the contract between this file's two halves):
 *   filter:<fid>  role:<fid>  threshold:<tid>  text:<xid>  combine:<oid>  window:<wid>  missing
 */
export function filterQuestions(req: PlanRequest): Questions {
  const questions: Questions = {}
  for (const c of req.filters) {
    questions[`filter:${c.id}`] = filterQuestion(c)
    if (c.roles?.length) questions[`role:${c.id}`] = roleQuestion(c)
  }
  for (const t of req.thresholds ?? []) questions[`threshold:${t.id}`] = thresholdQuestion(t, req)
  for (const x of req.texts ?? []) questions[`text:${x.id}`] = textQuestion(x, req)
  for (const pair of req.orPairs ?? []) questions[`combine:${pair.id}`] = combineQuestion(pair, req)
  for (const w of req.rankWindows ?? []) questions[`window:${w.id}`] = windowQuestion(w)
  if (req.cues?.missing && req.nullableColumns && Object.keys(req.nullableColumns).length) questions.missing = missingQuestion(req)
  return questions
}

type FilterAnswerPart = Pick<PlanAnswers, "filters" | "filterRoles" | "thresholds" | "texts" | "combine" | "rankWindows" | "missing">

export function normalizeFilterAnswers(raw: Record<string, unknown>, req: PlanRequest): FilterAnswerPart {
  const filters: PlanAnswers["filters"] = {}
  const filterRoles: NonNullable<PlanAnswers["filterRoles"]> = {}
  for (const f of req.filters) {
    const a = raw[`filter:${f.id}`]
    if (a) filters[f.id] = toAnswer(a as ChoiceResponse)
    if (f.roles?.length) {
      const r = raw[`role:${f.id}`]
      if (r) filterRoles[f.id] = toAnswer(r as ChoiceResponse)
    }
  }

  const thresholds: NonNullable<PlanAnswers["thresholds"]> = {}
  for (const t of req.thresholds ?? []) {
    const a = raw[`threshold:${t.id}`]
    if (a) thresholds[t.id] = toAnswer(a as ChoiceResponse)
  }
  const texts: NonNullable<PlanAnswers["texts"]> = {}
  for (const x of req.texts ?? []) {
    const a = raw[`text:${x.id}`]
    if (a) texts[x.id] = toAnswer(a as ChoiceResponse)
  }
  const combine: NonNullable<PlanAnswers["combine"]> = {}
  for (const pair of req.orPairs ?? []) {
    const a = raw[`combine:${pair.id}`]
    if (a) combine[pair.id] = toAnswer(a as ChoiceResponse)
  }
  const rankWindows: NonNullable<PlanAnswers["rankWindows"]> = {}
  for (const w of req.rankWindows ?? []) {
    const a = raw[`window:${w.id}`]
    if (a) rankWindows[w.id] = toAnswer(a as ChoiceResponse)
  }
  const missingRaw = raw.missing
  const missing = missingRaw ? toAnswer(missingRaw as ChoiceResponse) : undefined

  return {
    filters,
    filterRoles: Object.keys(filterRoles).length ? filterRoles : undefined,
    thresholds: Object.keys(thresholds).length ? thresholds : undefined,
    texts: Object.keys(texts).length ? texts : undefined,
    combine: Object.keys(combine).length ? combine : undefined,
    rankWindows: Object.keys(rankWindows).length ? rankWindows : undefined,
    missing,
  }
}

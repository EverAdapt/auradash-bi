/**
 * OWNER: planner. Offline planner: the same `PlanAnswers` shape as a Jev plan call, filled in by
 * keyword/synonym overlap scoring instead of a model call. Used when Jev is unavailable
 * (`src/lib/jev/client.ts` throws `JevUnavailable`) so everything downstream — interpret, compile,
 * the UI's "How Jev read this" panel — is identical either way.
 */
import type {
  Answer,
  AnswerKind,
  FilterCandidate,
  OptionText,
  PeriodUse,
  PlanAnswers,
  PlanRequest,
  RangeUse,
  SortAnswer,
  ThresholdUse,
  TimeGrain,
  ValueFilterUse,
  YearFilterUse,
} from "@shared/contract"
import { isStopword, tokenize } from "./normalize"

const DESC_WORDS = new Set(["top", "most", "highest", "best", "longest", "largest", "biggest", "richest", "more"])
const ASC_WORDS = new Set(["least", "lowest", "smallest", "shortest", "bottom", "fewest", "less"])
const CHRONO_WORDS = new Set(["over", "trend", "trends", "since", "across", "history", "change", "changed", "changing"])
const GROUP_WORDS = new Set(["by", "per", "each", "every", "split", "breakdown", "group", "grouped", "across"])
const ROWS_WORDS = new Set(["list", "show", "individual", "specific", "which", "longest", "shortest", "records", "rows"])
const DISTRIBUTION_WORDS = new Set(["distribution", "spread", "histogram", "how old"])
const COMPARE_WORDS = new Set(["vs", "versus", "compared", "compare", "relationship", "correlate", "correlation"])
const NEGATION_WORDS = new Set(["not", "excluding", "except", "without", "besides", "outside"])
// "before"/"after" are their own (strict) uses now — see YearFilterUse — so they're split out of
// the inclusive since/until sets below.
const SINCE_WORDS = new Set(["since", "from", "onwards", "onward"])
const UNTIL_WORDS = new Set(["until", "through", "up", "to", "by"])
const BEFORE_WORDS = new Set(["before"])
const AFTER_WORDS = new Set(["after"])
/** Generic English cue words for the v0.2 `missing` heuristic below — no dataset nouns. */
const MISSING_CUE_WORDS = ["missing", "unknown", "without", "never", "still", "alive", "ongoing", "unrecorded", "blank", "empty", "no longer", "not recorded", "incomplete", "pending", "recorded", "known"]
const NAMED_CHART_WORDS: Record<string, string> = {
  bar: "bar",
  column: "bar",
  pie: "pie",
  donut: "pie",
  line: "line",
  trend: "line",
  scatter: "scatter",
  map: "map",
  table: "table",
  histogram: "histogram",
}

function optionText(t: OptionText): { what: string; examples: string[] } {
  return typeof t === "string" ? { what: t, examples: [] } : { what: t.what, examples: t.examples ?? [] }
}

/** Token-overlap score between the question and one option's text + examples. */
function score(qTokens: Set<string>, key: string, text: OptionText): number {
  const { what, examples } = optionText(text)
  const pool = tokenize([key.replace(/[.:_]/g, " "), what, ...examples].join(" "))
  let s = 0
  for (const t of pool) if (!isStopword(t) && qTokens.has(t)) s++
  return s
}

function best(qTokens: Set<string>, options: Record<string, OptionText>): { key: string; score: number } | undefined {
  let top: { key: string; score: number } | undefined
  for (const [key, text] of Object.entries(options)) {
    const s = score(qTokens, key, text)
    if (s > 0 && (!top || s > top.score)) top = { key, score: s }
  }
  return top
}

/** A synthetic two-mass distribution: enough for interpret.ts's confidence/"did you mean" logic. */
function answerFor<T extends string>(value: T, escape: T, strength: number): Answer<T> {
  const p = value === escape ? 0.4 : Math.min(0.95, 0.45 + strength * 0.15)
  return { value, confidence: p, probabilities: { [value]: p, [escape]: value === escape ? p : 1 - p } as Record<string, number> }
}

function hasAny(qTokens: Set<string>, words: Set<string>): boolean {
  for (const w of words) if (qTokens.has(w)) return true
  return false
}

/** The role whose own words (its label, or the FK column's catalog synonyms carried on the
 *  candidate) appear in the question — the same data the Jev role question reads, matched as plain
 *  text for the offline fallback. Defaults to "any", the safe reading of a bare mention ("played",
 *  "appeared", "was involved"). */
function guessRole(q: string, roles: NonNullable<FilterCandidate["roles"]>): string {
  const escape = (w: string) => w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  for (const r of roles) {
    const words = [r.label, ...(r.synonyms ?? [])].map(escape).filter((w) => w.length > 2)
    if (words.length && new RegExp(`\\b(${words.join("|")})\\b`, "i").test(q)) return r.key
  }
  return "any"
}

export function offlineAnswers(req: PlanRequest): PlanAnswers {
  const q = req.question.toLowerCase()
  const qTokens = new Set(tokenize(req.question))

  const containsOverlap = req.dataset.contains.reduce((n, c) => n + (q.includes(c.toLowerCase()) ? 1 : 0), 0)
  const anyFilter = req.filters.length > 0
  const measureTop = best(qTokens, req.measures)
  const dimTop = best(qTokens, req.dimensions)
  const rowTop = best(qTokens, req.rowTables)

  const nonStopTokens = [...qTokens].filter((t) => !isStopword(t))
  const grounded = anyFilter || measureTop || dimTop || rowTop || containsOverlap > 0
  const inScope = grounded ? Math.min(0.95, 0.55 + 0.1 * (Number(anyFilter) + Number(!!measureTop) + Number(!!dimTop))) : Math.max(0.02, 0.2 - nonStopTokens.length * 0.01)

  const wantsRows = hasAny(qTokens, ROWS_WORDS) && !!rowTop
  const wantsDistribution = [...DISTRIBUTION_WORDS].some((w) => q.includes(w))
  let kind: AnswerKind
  if (!grounded) kind = "unanswerable"
  else if (wantsDistribution) kind = "distribution"
  else if (wantsRows) kind = "rows"
  else kind = "aggregate"
  const answerKind = answerFor<AnswerKind>(kind, "unanswerable", grounded ? 3 : 0)

  const measure = measureTop ? answerFor(measureTop.key, "none", measureTop.score) : answerFor("none", "none", 0)
  const wantsCompare = hasAny(qTokens, COMPARE_WORDS)
  let measure2Key = "none"
  if (wantsCompare && kind === "aggregate") {
    const secondOptions = Object.fromEntries(Object.entries(req.measures).filter(([k]) => k !== measure.value))
    const second = best(qTokens, secondOptions)
    if (second) measure2Key = second.key
  }
  const measure2 = answerFor(measure2Key, "none", wantsCompare ? 2 : 0)

  const groupHint = hasAny(qTokens, GROUP_WORDS)
  const groupBy = dimTop && (groupHint || kind === "aggregate") ? answerFor(dimTop.key, "none", dimTop.score) : answerFor("none", "none", 0)

  let timeGrain: TimeGrain = "none"
  if (req.timeGrains.includes("year") && (q.includes("year") || q.includes("annual") || hasAny(qTokens, CHRONO_WORDS))) timeGrain = "year"
  if (req.timeGrains.includes("decade") && q.includes("decade")) timeGrain = "decade"
  if (req.timeGrains.includes("month") && q.includes("month")) timeGrain = "month"
  const timeGrainAnswer = answerFor(timeGrain, "none", timeGrain !== "none" ? 3 : 0)

  let sortValue: SortAnswer = "none"
  if (hasAny(qTokens, DESC_WORDS)) sortValue = "desc"
  else if (hasAny(qTokens, ASC_WORDS)) sortValue = "asc"
  else if (timeGrain !== "none" || hasAny(qTokens, CHRONO_WORDS)) sortValue = "chronological"
  const sort = answerFor(sortValue, "none", sortValue !== "none" ? 3 : 0)

  let limitValue = "not_stated"
  if (req.numbers.length > 0) limitValue = `n${req.numbers[0]}`
  else if (/\b(the (top|highest|most|best|largest|biggest)|which \w+ (sells|wins|has))\b/.test(q)) limitValue = "one"
  const limit = answerFor(limitValue, "not_stated", limitValue !== "not_stated" ? 3 : 0)

  const rowTable = wantsRows && rowTop ? answerFor(rowTop.key, "none", rowTop.score) : answerFor("none", "none", 0)
  let sortColumnKey = "none"
  if (rowTable.value !== "none") {
    const forTable = Object.fromEntries(Object.entries(req.sortColumns).filter(([k]) => k.startsWith(`${rowTable.value}.`)))
    const s = best(qTokens, forTable) ?? (Object.keys(forTable).length ? { key: Object.keys(forTable)[0]!, score: 0 } : undefined)
    if (s) sortColumnKey = s.key
  }
  const sortColumn = answerFor(sortColumnKey, "none", sortColumnKey !== "none" ? 2 : 0)

  let namedChartValue = "none"
  for (const [word, chart] of Object.entries(NAMED_CHART_WORDS)) {
    if (q.includes(word)) {
      namedChartValue = chart
      break
    }
  }
  const namedChart = answerFor(namedChartValue, "none", namedChartValue !== "none" ? 3 : 0)

  const filters: PlanAnswers["filters"] = {}
  const filterRoles: NonNullable<PlanAnswers["filterRoles"]> = {}
  for (const f of req.filters) {
    if (f.roles?.length) {
      const roleKey = guessRole(q, f.roles)
      filterRoles[f.id] = answerFor(roleKey, "any", roleKey !== "any" ? 3 : 0)
    }
    // v0.2: a found range/period candidate is almost always meant as one — default to the filter
    // reading rather than "not_a_filter".
    if (f.kind === "range") {
      filters[f.id] = answerFor<RangeUse>("between", "not_a_filter", 3)
      continue
    }
    if (f.kind === "period") {
      filters[f.id] = answerFor<PeriodUse>("within", "not_a_filter", 3)
      continue
    }
    if (f.kind === "year" || f.kind === "now") {
      // `matched` is always the literal span found in the question ("1990", "now", "right now",
      // ...); `value` for a "now" candidate is the "latest" placeholder, which never appears
      // verbatim in the text.
      const idx = q.indexOf(f.matched.toLowerCase())
      const before = idx >= 0 ? q.slice(Math.max(0, idx - 12), idx) : ""
      let use: YearFilterUse = "in_year"
      if ([...BEFORE_WORDS].some((w) => before.includes(w))) use = "before"
      else if ([...AFTER_WORDS].some((w) => before.includes(w))) use = "after"
      else if ([...SINCE_WORDS].some((w) => before.includes(w))) use = "from"
      else if ([...UNTIL_WORDS].some((w) => before.includes(w))) use = "until"
      filters[f.id] = answerFor<YearFilterUse>(use, "not_a_filter", 3)
    } else {
      const idx = q.indexOf(f.matched.toLowerCase())
      const before = idx >= 0 ? q.slice(Math.max(0, idx - 15), idx) : ""
      const use: ValueFilterUse = [...NEGATION_WORDS].some((w) => before.includes(w)) ? "exclude" : "include_only"
      filters[f.id] = answerFor<ValueFilterUse>(use, "not_a_filter", 3)
    }
  }

  // v0.2: thresholds — "agg" (the calculated amount per group) when the question groups, else the
  // sortColumn whose label shares a token with the question, else fall back to "agg" weakly.
  const thresholds: NonNullable<PlanAnswers["thresholds"]> = {}
  const groupsForThreshold = hasAny(qTokens, GROUP_WORDS)
  for (const t of req.thresholds ?? []) {
    if (groupsForThreshold) {
      thresholds[t.id] = answerFor<ThresholdUse>("agg", "not_a_filter", 3)
      continue
    }
    const match = best(qTokens, req.sortColumns)
    thresholds[t.id] = match ? answerFor<ThresholdUse>(match.key, "not_a_filter", match.score) : answerFor<ThresholdUse>("agg", "not_a_filter", 1)
  }

  // v0.2: texts — the best token-overlap text column.
  const texts: NonNullable<PlanAnswers["texts"]> = {}
  for (const x of req.texts ?? []) {
    const match = best(qTokens, req.textColumns ?? {})
    texts[x.id] = match ? answerFor(match.key, "not_a_filter", match.score) : answerFor("not_a_filter", "not_a_filter", 0)
  }

  // v0.2: "or" between two different-column values -> either (a union), strongly.
  const combine: NonNullable<PlanAnswers["combine"]> = {}
  for (const pair of req.orPairs ?? []) {
    combine[pair.id] = answerFor<"both" | "either">("either", "both", 3)
  }

  // v0.2: a found rank window is almost always meant as one.
  const rankWindows: NonNullable<PlanAnswers["rankWindows"]> = {}
  for (const w of req.rankWindows ?? []) {
    rankWindows[w.id] = answerFor<"window" | "not_a_filter">("window", "not_a_filter", 3)
  }

  // v0.2: missing — "none" unless a strong cue word sits close to a nullable column's own label
  // word in the question text.
  let missing: Answer | undefined
  if (req.cues?.missing && req.nullableColumns && Object.keys(req.nullableColumns).length) {
    let bestMatch: { key: string; state: "missing" | "present"; score: number } | undefined
    for (const [key, text] of Object.entries(req.nullableColumns)) {
      const label = typeof text === "string" ? text : text.what
      const labelTokens = tokenize(label).filter((t) => !isStopword(t))
      for (const lt of labelTokens) {
        const idx = q.indexOf(lt)
        if (idx === -1) continue
        const window = q.slice(Math.max(0, idx - 25), idx + lt.length + 25)
        const cue = MISSING_CUE_WORDS.find((w) => window.includes(w))
        if (!cue) continue
        const state: "missing" | "present" = cue === "recorded" || cue === "known" ? "present" : "missing"
        const score = labelTokens.length
        if (!bestMatch || score > bestMatch.score) bestMatch = { key, state, score }
      }
    }
    missing = bestMatch ? answerFor(`${bestMatch.key}:${bestMatch.state}`, "none", 3) : answerFor("none", "none", 0)
  }

  return {
    inScope,
    answerKind,
    measure,
    measure2,
    groupBy,
    timeGrain: timeGrainAnswer,
    sort,
    limit,
    rowTable,
    sortColumn,
    namedChart,
    filters,
    filterRoles: Object.keys(filterRoles).length ? filterRoles : undefined,
    thresholds: Object.keys(thresholds).length ? thresholds : undefined,
    texts: Object.keys(texts).length ? texts : undefined,
    combine: Object.keys(combine).length ? combine : undefined,
    rankWindows: Object.keys(rankWindows).length ? rankWindows : undefined,
    missing,
  }
}

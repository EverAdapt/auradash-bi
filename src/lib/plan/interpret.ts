/**
 * OWNER: planner. Turns Jev's (or the offline planner's) typed `PlanAnswers` into the
 * Jev-independent `QueryPlan` IR, plus everything the UI needs to explain the read: a status, a
 * confidence (min over the slots the plan actually used — function_calling cookbook), the chips
 * ("slots") a picker can reopen, and up to two "Did you mean" alternatives built from runner-up
 * probabilities, with no extra Jev call.
 */
import { CYCLICAL_GRAINS, type Answer, type Catalog, type OptionText, type PlanAnswers, type PlanRequest, type QueryPlan, type TimeCalc, type TimeGrain } from "@shared/contract"
import { ALTERNATIVE_MIN_P, IN_SCOPE_MIN, MAX_ALTERNATIVES, NO_MEASURE_MATCH_MIN_P, UNANSWERABLE_MIN_P } from "@shared/jev/questions"
import { detectMeasureShape, groupByColumnKey, isBandKey, pickBandEdges } from "./calc"
import { nearestTimeColumn } from "./graph"
import { buildFilters, buildHavingFilters, buildShare, filterSlotViews, rankWindow } from "./filters"
import { nearestDateColumn } from "./request"
import { topOptions, type SlotKey, type SlotView } from "./slots"

export type { SlotKey, SlotOption, SlotView } from "./slots"

/** A "Did you mean" chip built from a runner-up (p ≥ 0.15). No extra Jev call. */
export interface Alternative {
  slot: SlotKey
  key: string
  p: number
  text: string // "Laureates by country instead of by category"
}

export interface Interpretation {
  status: "ok" | "out_of_scope" | "no_match"
  plan: QueryPlan | null
  confidence: number
  slots: SlotView[]
  alternatives: Alternative[]
  message?: string
}

const ANSWER_KIND_DISPLAY: Record<string, string> = {
  aggregate: "A calculated total",
  rows: "Individual records",
  distribution: "How values are spread out",
  unanswerable: "Not answerable here",
}
const TIME_GRAIN_DISPLAY: Record<string, string> = {
  none: "No time breakdown",
  year: "Year",
  decade: "Decade",
  quarter: "Quarter",
  month: "Month",
  day: "Day",
  // v0.2 cyclical grains
  weekday: "Day of week",
  month_of_year: "Month of year",
  hour: "Hour of day",
}
/** v0.2 `timeCalc` chip wording ("Showing" — see interpretAnswers' per/timeCalc block below). */
const TIME_CALC_DISPLAY: Record<Exclude<TimeCalc, "none">, string> = {
  change: "Change vs previous",
  pct_change: "% change vs previous",
  running_total: "Running total",
}

/**
 * What a chip shows for an option. The request's option text is written for Jev (label, table,
 * unit: "CO2 emissions (total) (Country by year), Mt CO2e"); people get the plain catalog label.
 */
function displayOf(text: OptionText | undefined, fallbackKey: string, catalog?: Catalog): string {
  const clean = catalog ? cleanDisplay(fallbackKey, catalog) : undefined
  if (clean) return clean
  if (!text) return humanizeKey(fallbackKey)
  return typeof text === "string" ? text : text.what
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s)

function cleanDisplay(key: string, catalog: Catalog): string | undefined {
  if (key.startsWith("m:")) return catalog.metrics.find((m) => m.key === key.slice(2))?.label
  if (key.startsWith("n:")) {
    const t = catalog.tables.find((x) => x.name === key.slice(2))
    return t ? `Number of ${lowerFirst(t.label)}` : undefined
  }
  if (key.startsWith("c:")) return catalogColumn(catalog, key.slice(2).split(":")[0]!)?.label
  if (isBandKey(key)) {
    const label = catalogColumn(catalog, groupByColumnKey(key))?.label
    return label ? `${label} (bands)` : undefined
  }
  if (key.includes(".")) {
    const col = catalogColumn(catalog, key)
    if (!col) return undefined
    // An ISO3 code stands for its country: show the table's display column label ("Country").
    if (col.role === "geo_code") {
      const target = col.fk ? catalog.tables.find((t) => t.name === col.fk!.split(".")[0]) : catalog.tables.find((t) => t.name === col.table)
      const display = target?.display ? target.columns.find((c) => c.name === target.display) : undefined
      return display?.label ?? col.label
    }
    return col.label
  }
  return catalog.tables.find((t) => t.name === key)?.label
}

/** The thing a column identifies: its FK target table, or its own table for codes/labels. */
function entityOf(key: string, catalog: Catalog): string {
  const col = catalogColumn(catalog, key)
  if (!col) return key
  if (col.fk) return col.fk.split(".")[0]!
  if (col.role === "geo_code" || col.role === "label") return col.table
  return key
}
function humanizeKey(key: string): string {
  const bare = key.replace(/^(m|c|n):/, "").split(":")[0]!
  const name = bare.includes(".") ? bare.split(".").pop()! : bare
  return name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
}

function runnerUp(a: Answer, exclude: string[]): { key: string; p: number } | undefined {
  const entries = Object.entries(a.probabilities)
    .filter(([k]) => !exclude.includes(k))
    .sort((x, y) => y[1] - x[1])
  return entries[0] ? { key: entries[0][0], p: entries[0][1] } : undefined
}

function catalogColumn(catalog: Catalog, key: string) {
  const table = key.split(".")[0]!
  return catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.key === key)
}

/** Whether `measureKey` can carry a share of `share`'s value: "splittable" (a count or a sum —
 *  compile.ts wraps it in CASE WHEN), "already_share" (a curated percentage metric whose own SQL
 *  reads the share's column, e.g. a "share of X that are V" metric), or "unsplittable". */
function shareFit(measureKey: string, share: NonNullable<QueryPlan["share"]>, catalog: Catalog): "splittable" | "already_share" | "unsplittable" {
  if (measureKey.startsWith("n:")) return "splittable"
  if (measureKey.startsWith("m:")) {
    const m = catalog.metrics.find((x) => x.key === measureKey.slice(2))
    if (!m) return "unsplittable"
    if (m.format === "percent" && m.sql.includes(share.column)) return "already_share"
    return detectMeasureShape(m.sql).kind === "other" ? "unsplittable" : "splittable"
  }
  const agg = measureKey.slice(measureKey.lastIndexOf(":") + 1)
  return agg === "sum" || agg === "count" || agg === "count_distinct" ? "splittable" : "unsplittable"
}

/** The count a share is naturally "of": the records of the table the share's value lives on (or,
 *  for a value matched through FK roles, the table holding those FK columns) — a curated count
 *  metric over that table when there is one, else its plain row count. */
function shareBaseMeasure(share: NonNullable<QueryPlan["share"]>, req: PlanRequest, catalog: Catalog): string {
  const table = (share.via?.[0] ?? share.column).split(".")[0]!
  const countMetric = catalog.metrics.find((m) => m.table === table && /^COUNT\(/i.test(m.sql.trim()) && `m:${m.key}` in req.measures)
  if (`n:${table}` in req.measures || !countMetric) return `n:${table}`
  return `m:${countMetric.key}`
}

/** A rank window replaces the limit and adds an offset ("ranked 11 to 20" -> LIMIT 10 OFFSET 10). */
function windowPart(window: { offset: number; limit: number } | undefined): Partial<QueryPlan> {
  return window ? { offset: window.offset, limit: window.limit } : {}
}

/** The v0.2 filter-derived parts of an aggregate plan (from filters.ts), omitted when empty. */
function extrasPart(having: NonNullable<QueryPlan["having"]>, share: QueryPlan["share"], window: { offset: number; limit: number } | undefined): Partial<QueryPlan> {
  return { ...(having.length ? { having } : {}), ...(share ? { share } : {}), ...windowPart(window) }
}

function resolveLimit(value: string, isRanking: boolean, kind: QueryPlan["kind"], mappable = false): number {
  if (value.startsWith("n")) {
    const n = Number(value.slice(1))
    if (Number.isFinite(n) && n > 0) return Math.min(n, 5000)
  }
  if (value === "one") return 1
  if (kind === "rows") return mappable ? 1000 : 50
  return isRanking ? 10 : 500
}

export function interpretAnswers(answers: PlanAnswers, req: PlanRequest, catalog: Catalog): Interpretation {
  const unanswerableP = answers.answerKind.probabilities.unanswerable ?? 0
  if (answers.inScope < IN_SCOPE_MIN || unanswerableP >= UNANSWERABLE_MIN_P || answers.answerKind.value === "unanswerable") {
    return {
      status: "out_of_scope",
      plan: null,
      confidence: Math.min(answers.inScope, 1 - unanswerableP),
      slots: [],
      alternatives: [],
      message: `That doesn't look like something in ${req.dataset.name}.`,
    }
  }

  const slots: SlotView[] = []
  const usedConfidences: number[] = [answers.answerKind.confidence]
  const alternatives: Alternative[] = []

  // "Which songs are the longest?", "biggest wins ever": a superlative over individual records (no
  // grouping, no time axis, a sort direction, and a measure that is the row table's own column Jev
  // also chose to sort by) reads best as those records ranked, not as one average.
  const measureColumnKey = /^c:([^:]+):/.exec(answers.measure.value)?.[1]
  const superlativeRecords =
    answers.answerKind.value === "aggregate" &&
    answers.groupBy.value === "none" &&
    answers.timeGrain.value === "none" &&
    answers.measure2.value === "none" &&
    (answers.sort.value === "desc" || answers.sort.value === "asc") &&
    !!measureColumnKey &&
    answers.rowTable.value !== "none" &&
    measureColumnKey.split(".")[0] === answers.rowTable.value &&
    answers.sortColumn.value === measureColumnKey
  const kind: QueryPlan["kind"] =
    answers.answerKind.value === "rows" || superlativeRecords ? "rows" : answers.answerKind.value === "distribution" ? "distribution" : "aggregate"

  slots.push({
    slot: "answerKind",
    label: "Show",
    value: answers.answerKind.value,
    display: ANSWER_KIND_DISPLAY[answers.answerKind.value] ?? answers.answerKind.value,
    confidence: answers.answerKind.confidence,
    options: topOptions(answers.answerKind.probabilities, (k) => ANSWER_KIND_DISPLAY[k] ?? k),
  })

  let filters = buildFilters(answers, req)
  {
    const f = filterSlotViews(answers, req)
    slots.push(...f.slots)
    usedConfidences.push(...f.confidences)
  }
  // v0.2 filter-derived plan parts that are not WHERE filters (A builds them in filters.ts):
  const having = buildHavingFilters(answers, req)
  let share = buildShare(answers, req)
  const window = rankWindow(answers, req)

  if (kind === "rows") {
    const rowTable = answers.rowTable.value !== "none" ? answers.rowTable.value : (catalog.defaultFact ?? Object.keys(req.rowTables)[0])
    if (!rowTable) {
      return { status: "no_match", plan: null, confidence: 0, slots, alternatives, message: "Couldn't tell which records to show." }
    }
    usedConfidences.push(answers.rowTable.value !== "none" ? answers.rowTable.confidence : 0.4)
    slots.push({
      slot: "rowTable",
      label: "Show",
      value: rowTable,
      display: displayOf(req.rowTables[rowTable], rowTable, catalog),
      confidence: answers.rowTable.confidence,
      options: topOptions(answers.rowTable.probabilities, (k) => displayOf(req.rowTables[k], k, catalog)),
    })
    const ru = runnerUp(answers.rowTable, [answers.rowTable.value, "none"])
    if (ru && ru.p >= ALTERNATIVE_MIN_P) {
      alternatives.push({ slot: "rowTable", key: ru.key, p: ru.p, text: `${displayOf(req.rowTables[ru.key], ru.key, catalog)} instead of ${displayOf(req.rowTables[rowTable], rowTable, catalog)}` })
    }

    let sortColumn = answers.sortColumn.value !== "none" ? answers.sortColumn.value : undefined
    if (sortColumn) {
      usedConfidences.push(answers.sortColumn.confidence)
      slots.push({
        slot: "sortColumn",
        label: "Sorted by",
        value: sortColumn,
        display: displayOf(req.sortColumns[sortColumn], sortColumn, catalog),
        confidence: answers.sortColumn.confidence,
        options: topOptions(answers.sortColumn.probabilities, (k) => displayOf(req.sortColumns[k], k, catalog)),
      })
    } else {
      sortColumn = Object.keys(req.sortColumns).find((k) => k.startsWith(`${rowTable}.`))
    }
    const dir = answers.sort.value === "asc" || answers.sort.value === "chronological" ? "asc" : "desc"
    // A record with its own coordinates can feed a point map — worth showing far more than the
    // usual row preview cap so the map isn't sparse (e.g. "Where were physics laureates born?").
    const rowTableObj = catalog.tables.find((t) => t.name === rowTable)
    const mappable = !!rowTableObj?.columns.some((c) => c.role === "latitude") && !!rowTableObj?.columns.some((c) => c.role === "longitude")
    const statedCount = /^n\d+$/.test(answers.limit.value) || answers.limit.value === "one"
    const limitValue = superlativeRecords && !statedCount ? 10 : resolveLimit(answers.limit.value, false, "rows", mappable)
    // The Top chip only when the question set a count; the preview cap is an implementation detail.
    if (/^n\d+$/.test(answers.limit.value) || answers.limit.value === "one")
      slots.push({ slot: "limit", label: "Top", value: answers.limit.value, display: String(limitValue), confidence: answers.limit.confidence, options: [] })

    const plan: QueryPlan = { datasetId: catalog.datasetId, kind: "rows", rowTable, filters, sort: { by: "column", column: sortColumn, dir }, limit: limitValue, ...windowPart(window) }
    return { status: "ok", plan, confidence: Math.min(...usedConfidences), slots, alternatives: alternatives.slice(0, MAX_ALTERNATIVES), message: undefined }
  }

  if (kind === "distribution") {
    // A distribution bins individual row VALUES, so it only makes sense for a plain column
    // measure ("c:table.col:agg"), never a pre-aggregated metric ("m:") or a row count ("n:") —
    // if Jev picked one of those, fall back to the best "c:" runner-up instead.
    let measure = answers.measure.value.startsWith("c:") ? answers.measure.value : undefined
    if (!measure) {
      const ranked = Object.entries(answers.measure.probabilities).sort((a, b) => b[1] - a[1])
      measure = ranked.find(([k]) => k.startsWith("c:"))?.[0]
    }
    usedConfidences.push(answers.measure.confidence)
    slots.push({
      slot: "measure",
      label: "Measure",
      value: measure ?? "none",
      display: displayOf(req.measures[measure ?? ""], measure ?? "none", catalog),
      confidence: answers.measure.confidence,
      options: topOptions(answers.measure.probabilities, (k) => displayOf(req.measures[k], k, catalog)),
    })
    if (!measure) return { status: "no_match", plan: null, confidence: 0, slots, alternatives, message: "Couldn't tell what to measure the spread of." }

    const col = measure.startsWith("c:") ? catalogColumn(catalog, measure.slice(2).split(":")[0]!) : undefined
    const binWidth = typeof col?.binnable === "object" ? undefined : col?.binWidth
    const plan: QueryPlan = { datasetId: catalog.datasetId, kind: "distribution", measure, filters, sort: { by: "x", dir: "asc" }, limit: 500, binWidth }
    return { status: "ok", plan, confidence: Math.min(...usedConfidences), slots, alternatives: alternatives.slice(0, MAX_ALTERNATIVES) }
  }

  // No measure picked, but Jev chose a numeric column to sort by ("Where do people still lack
  // electricity?" -> sorted by access to electricity): that column is what the question is about.
  let measureKey = answers.measure.value
  if (measureKey === "none" && answers.sortColumn.value !== "none") {
    const fromSort = Object.keys(req.measures).find((k) => k.startsWith(`c:${answers.sortColumn.value}:`))
    if (fromSort) measureKey = fromSort
  }

  // A change / % change / running total is always a change OF an amount: when Jev leaned "none"
  // on the measure but asked for one of those, take the most likely real measure instead of a count.
  if (measureKey === "none" && answers.timeCalc && answers.timeCalc.value !== "none") {
    const best = Object.entries(answers.measure.probabilities)
      .filter(([k]) => k !== "none" && k in req.measures)
      .sort((a, b) => b[1] - a[1])[0]
    if (best) measureKey = best[0]
  }

  // v0.2 share needs a measure that splits into a part of a whole (a count or a sum). A curated
  // percentage metric that already measures the share's own column answers it by itself (the share
  // is dropped); any other unsplittable pick (an average, a min/max, an unrelated percentage) or no
  // measure at all is re-based to counting the records the share is about.
  if (share) {
    const fit = measureKey === "none" ? "unsplittable" : shareFit(measureKey, share, catalog)
    if (fit === "already_share") share = undefined
    else if (fit === "unsplittable") measureKey = shareBaseMeasure(share, req, catalog)
  }

  // aggregate — a "none" measure (whatever its confidence) can never compile: `measure` would be
  // left undefined and crash the compiler downstream. Any "none" pick degrades to a default count
  // so the chart still renders; only a CONFIDENT "none" also downgrades the status to no_match.
  if (measureKey === "none") {
    const fallbackTable = answers.rowTable.value !== "none" ? answers.rowTable.value : (catalog.defaultFact ?? "")
    const fallbackMeasure = `n:${fallbackTable}` in req.measures ? `n:${fallbackTable}` : Object.keys(req.measures).find((k) => k.startsWith("n:"))
    const alts = Object.entries(answers.measure.probabilities)
      .filter(([k]) => k !== "none")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([key, p]) => ({ slot: "measure" as SlotKey, key, p, text: `${displayOf(req.measures[key], key, catalog)} instead of a count` }))
    if (!fallbackMeasure) {
      return { status: "no_match", plan: null, confidence: 0, slots, alternatives: alts, message: "Wasn't sure what to measure." }
    }
    const noneP = answers.measure.probabilities.none ?? 0
    const confident = noneP >= NO_MEASURE_MATCH_MIN_P
    const plan: QueryPlan = { datasetId: catalog.datasetId, kind: "aggregate", measure: fallbackMeasure, filters, sort: { by: "measure", dir: "desc" }, limit: 10, ...extrasPart(having, share, window) }
    return {
      status: confident ? "no_match" : "ok",
      plan,
      confidence: confident ? 0.3 : Math.min(...usedConfidences, answers.measure.confidence),
      slots,
      alternatives: alts,
      message: confident ? "Wasn't sure what to measure, so here's a count." : undefined,
    }
  }

  const measure = measureKey !== "none" ? measureKey : undefined
  usedConfidences.push(answers.measure.confidence)
  slots.push({
    slot: "measure",
    label: "Measure",
    value: measureKey,
    display: displayOf(req.measures[measureKey], measureKey, catalog),
    confidence: answers.measure.confidence,
    options: topOptions(answers.measure.probabilities, (k) => displayOf(req.measures[k], k, catalog)),
  })
  {
    const ru = runnerUp(answers.measure, [measureKey, "none"])
    if (ru && ru.p >= ALTERNATIVE_MIN_P) {
      alternatives.push({ slot: "measure", key: ru.key, p: ru.p, text: `${displayOf(req.measures[ru.key], ru.key, catalog)} instead of ${displayOf(req.measures[measureKey], measureKey, catalog)}` })
    }
  }

  // A "compared against" answer that names the SAME measure is never meaningful (e.g. a question
  // mentioning two years, not two amounts, can nudge Jev into picking measure2 === measure).
  const measure2 = answers.measure2.value !== "none" && answers.measure2.value !== measureKey ? answers.measure2.value : undefined
  if (measure2) {
    usedConfidences.push(answers.measure2.confidence)
    slots.push({
      slot: "measure2",
      label: "Compared with",
      value: measure2,
      display: displayOf(req.measures[measure2], measure2, catalog),
      confidence: answers.measure2.confidence,
      options: topOptions(answers.measure2.probabilities, (k) => displayOf(req.measures[k], k, catalog)),
    })
  }

  // v0.2 per: "X per Y" — a denominator amount, only when it differs from the main measure and Jev
  // is reasonably confident (its own confidence doubles as the "p >= 0.5" gate here, matching how
  // `toAnswer` reports the chosen option's own probability as `confidence`). compile.ts drops it
  // again (with a subtitle note) if the denominator can't be reached without fanning out the rows.
  let per: string | undefined
  if (answers.per && answers.per.value !== "none" && answers.per.value !== measureKey && answers.per.confidence >= 0.5) {
    per = answers.per.value
    usedConfidences.push(answers.per.confidence)
    slots.push({
      slot: "per",
      label: "Per",
      value: per,
      display: displayOf(req.measures[per], per, catalog),
      confidence: answers.per.confidence,
      options: topOptions(answers.per.probabilities, (k) => displayOf(req.measures[k], k, catalog)),
    })
  }

  // Drop group_by when it names the same column a filter already pins to one value — but not when
  // the question named TWO OR MORE values of that column ("women AND men laureates by decade"):
  // that's a comparison across the group's own values, not a restriction, however a per-value
  // filter Choice happened to answer, so those filters are dropped instead of the grouping.
  let groupBy = answers.groupBy.value !== "none" ? answers.groupBy.value : undefined
  if (groupBy) {
    const distinctValuesMentioned = new Set(req.filters.filter((f) => f.column === groupBy).map((f) => f.value))
    if (distinctValuesMentioned.size >= 2) filters = filters.filter((f) => f.column !== groupBy)
    else if (filters.some((f) => f.column === groupBy && f.op === "in" && f.values.length === 1)) groupBy = undefined
  }
  // Two or more named values of one dimension with no grouping chosen ("a home victory, an away
  // victory or a draw", "Brazil vs India") are a comparison: group by that column, keeping the
  // filter to exactly those values.
  if (!groupBy) {
    const compared = filters.find((f) => f.op === "in" && f.values.length >= 2 && f.column in req.dimensions)
    if (compared) groupBy = compared.column
  }
  if (groupBy) {
    usedConfidences.push(answers.groupBy.confidence)
    slots.push({
      slot: "groupBy",
      label: "Grouped by",
      value: groupBy,
      display: displayOf(req.dimensions[groupBy], groupBy, catalog),
      confidence: answers.groupBy.confidence,
      options: topOptions(answers.groupBy.probabilities, (k) => displayOf(req.dimensions[k], k, catalog)),
    })
    const ru = runnerUp(answers.groupBy, [answers.groupBy.value, "none"])
    // "Country code instead of Country" is the same grouping: only offer a genuinely different one.
    if (ru && ru.p >= ALTERNATIVE_MIN_P && entityOf(ru.key, catalog) !== entityOf(groupBy, catalog)) {
      const measureDisplay = displayOf(req.measures[measureKey], measureKey, catalog)
      alternatives.push({
        slot: "groupBy",
        key: ru.key,
        p: ru.p,
        text: `${measureDisplay} by ${displayOf(req.dimensions[ru.key], ru.key, catalog)} instead of ${displayOf(req.dimensions[groupBy], groupBy, catalog)}`,
      })
    }
  }

  // v0.2 bands: a "b:<table.col>" groupBy bins a measure column into ranges instead of grouping by
  // a category — plan.groupBy keeps the "b:" key (compile.ts strips it via calc.ts's
  // `groupByColumnKey`). Edges come from numbers in the question that fall inside the column's own
  // [min, max] (sorted, deduplicated); with none, code picks "nice" edges from the column's
  // `binWidth` or a nice width — see calc.ts's `pickBandEdges`.
  let bands: QueryPlan["bands"]
  if (groupBy && isBandKey(groupBy)) {
    const col = catalogColumn(catalog, groupByColumnKey(groupBy))
    if (col && col.min !== undefined && col.max !== undefined) {
      const numbers = req.numbers.map(Number).filter((n) => Number.isFinite(n))
      bands = { edges: pickBandEdges(col.min, col.max, col.binWidth, numbers) }
    } else {
      // No numeric range to bin (a self-contradictory / low-confidence pick) — drop the grouping
      // entirely rather than compile a bandless CASE.
      groupBy = undefined
      for (let i = slots.length - 1; i >= 0; i--) if (slots[i]!.slot === "groupBy") slots.splice(i, 1)
    }
  }

  let time: QueryPlan["time"]
  const timeGrain = answers.timeGrain.value as TimeGrain
  if (timeGrain !== "none") {
    // v0.2 cyclical grains (weekday / month of year / hour) bucket the nearest real DATE column —
    // even when the dataset's ordinary time axis is an integer year sitting right next to it (see
    // request.ts's `nearestDateColumn`, e.g. AFL's `matches.match_date` beside `matches.year`).
    const isCyclical = (CYCLICAL_GRAINS as readonly string[]).includes(timeGrain)
    const nearest = isCyclical ? nearestDateColumn(catalog, catalog.defaultFact ?? "") : nearestTimeColumn(catalog, catalog.defaultFact ?? "")
    if (nearest) {
      usedConfidences.push(answers.timeGrain.confidence)
      time = { column: nearest.key, grain: timeGrain }
      slots.push({
        slot: "timeGrain",
        label: "Over",
        value: timeGrain,
        display: TIME_GRAIN_DISPLAY[timeGrain] ?? timeGrain,
        confidence: answers.timeGrain.confidence,
        options: topOptions(answers.timeGrain.probabilities, (k) => TIME_GRAIN_DISPLAY[k] ?? k),
      })
    }
  }

  // Two or more explicit years selected together ("1990 vs 2020", "population now vs 1986") are a
  // time comparison even when `time_grain` stayed "none" — nothing in the question says "per
  // year", just which years — so render one row per year (sorted chronologically) instead of
  // summing/averaging them into one, exactly like an explicit time breakdown would.
  let yearComparison = false
  if (!time) {
    const nearest = nearestTimeColumn(catalog, catalog.defaultFact ?? "")
    const yearsFilter = nearest ? filters.find((f) => f.column === nearest.key && f.op === "in" && f.values.length > 1) : undefined
    if (nearest && yearsFilter) {
      time = { column: nearest.key, grain: "year" }
      yearComparison = true
      slots.push({ slot: "timeGrain", label: "Over", value: "year", display: "Year", confidence: 1, options: [] })
    }
  }

  // v0.2 timeCalc needs a time axis. When cues.change clearly wants one but Jev didn't pick a
  // grain, fall back to the "year" grain (when the dataset has one) so the calculation still has an
  // axis to compute LAG / a running total over.
  let timeCalc: Exclude<TimeCalc, "none"> | undefined
  if (answers.timeCalc && answers.timeCalc.value !== "none") {
    if (!time && req.timeGrains.includes("year")) {
      const nearest = nearestTimeColumn(catalog, catalog.defaultFact ?? "")
      if (nearest) {
        time = { column: nearest.key, grain: "year" }
        slots.push({ slot: "timeGrain", label: "Over", value: "year", display: "Year", confidence: answers.timeCalc.confidence, options: [] })
      }
    }
    if (time) {
      timeCalc = answers.timeCalc.value as Exclude<TimeCalc, "none">
      usedConfidences.push(answers.timeCalc.confidence)
      slots.push({
        slot: "timeCalc",
        label: "Showing",
        value: answers.timeCalc.value,
        display: TIME_CALC_DISPLAY[timeCalc] ?? answers.timeCalc.value,
        confidence: answers.timeCalc.confidence,
        options: topOptions(answers.timeCalc.probabilities, (k) => (k === "none" ? "Plain amount" : (TIME_CALC_DISPLAY[k as Exclude<TimeCalc, "none">] ?? k))),
      })
    }
  }

  // A grouping that is just a property of the time bucket (AFL's seasons.era: exactly one value per
  // year) adds nothing next to the time axis, so drop it together with its chip and alternatives.
  if (groupBy && time) {
    const g = catalogColumn(catalog, groupBy)
    const t = catalogColumn(catalog, time.column)
    const table = g ? catalog.tables.find((x) => x.name === g.table) : undefined
    if (g && t && g.table === t.table && table && t.distinctCount !== undefined && t.distinctCount === table.rowCount) {
      groupBy = undefined
      for (let i = slots.length - 1; i >= 0; i--) if (slots[i]!.slot === "groupBy") slots.splice(i, 1)
      for (let i = alternatives.length - 1; i >= 0; i--) if (alternatives[i]!.slot === "groupBy") alternatives.splice(i, 1)
    }
  }

  // A ranking cap only makes sense when the question actually asked for one (top/most/least —
  // sort desc/asc); "none" (e.g. "internet users around the world") must not silently cut rows.
  const isRanking = !!groupBy && !time && (answers.sort.value === "desc" || answers.sort.value === "asc")
  // A country/map grouping wants every place it can show — "around the world", "which countries
  // were the most laureates born in" — so only an explicit count ("top 10", "the one country
  // with the most") caps it; a bare ranking direction alone must not cost the map its rows.
  const isGeoGroup = groupBy ? catalogColumn(catalog, groupBy)?.role === "geo_code" : false
  const hasExplicitCount = /^n\d+$/.test(answers.limit.value) || answers.limit.value === "one"
  const cappable = isGeoGroup ? isRanking && hasExplicitCount : isRanking
  const limitValue = resolveLimit(answers.limit.value, cappable, "aggregate")
  // Show the Top chip only when the rows are actually cut to a ranking ("Top 10 …"), not for the
  // safety cap on an uncapped grouping.
  if ((groupBy || measure2) && (hasExplicitCount || (cappable && limitValue <= 50))) {
    slots.push({ slot: "limit", label: "Top", value: answers.limit.value, display: String(limitValue), confidence: answers.limit.confidence, options: [] })
  }

  const dir: "asc" | "desc" = answers.sort.value === "asc" ? "asc" : "desc"
  const sort: QueryPlan["sort"] =
    time && (yearComparison || answers.sort.value === "chronological" || answers.sort.value === "none") ? { by: "x", dir: "asc" } : { by: "measure", dir }

  const plan: QueryPlan = {
    datasetId: catalog.datasetId,
    kind: "aggregate",
    measure,
    measure2,
    groupBy,
    time,
    filters,
    sort,
    limit: limitValue,
    ...extrasPart(having, share, window),
    ...(per ? { per } : {}),
    ...(timeCalc ? { timeCalc } : {}),
    ...(bands ? { bands } : {}),
  }
  return { status: "ok", plan, confidence: Math.min(...usedConfidences), slots, alternatives: alternatives.slice(0, MAX_ALTERNATIVES) }
}

/**
 * auradash-bi: the ONE contract between workstreams (client, worker, bake scripts).
 *
 *   question ─► candidates (code) ─► /api/plan: Jev picks typed slots ─► QueryPlan (code)
 *            ─► compile: SQL + params (code, FK-graph joins, allow-listed identifiers)
 *            ─► run in in-browser SQLite ─► ResultProfile (code)
 *            ─► eligible charts (code) ─► /api/chart: Jev picks one ─► ChartSpec (code) ─► render
 *
 * "Jev decides, code computes": Jev never sees or writes SQL and never extracts values; it only
 * picks among options code derived from the schema, and every Choice has an escape option.
 *
 * Owned by the lead. Implementers must not change these types; if one is wrong, report it in
 * your StructuredOutput `contractIssues` and code the smallest local adapter instead.
 * This file must stay dependency-free (no zod, no DOM, no React) so the Worker, the browser and
 * bun scripts can all import it.
 */

// ─────────────────────────────── primitives ───────────────────────────────

export type Cell = string | number | null
export type DatasetId = string // 'nobel' | 'world' | `up_${string}` for uploads

/** A set of rows. Column names are unique within a result. */
export interface ResultSet {
  columns: string[]
  rows: Cell[][]
  /** true when the engine stopped at the row cap */
  truncated: boolean
  elapsedMs: number
}

/**
 * Runs read-only SQL against ONE dataset. The pure libraries (catalog, plan, viz) only ever
 * receive a QueryFn, never an engine, so they also run in bun scripts (bun:sqlite) for baking.
 */
export type QueryFn = (sql: string, params?: Cell[]) => Promise<ResultSet>

// ─────────────────────────────── datasets ───────────────────────────────

export interface DatasetInfo {
  id: DatasetId
  title: string
  tagline: string
  kind: "bundled" | "upload"
  /** Shown in the footer, explorer "About" and on pinned cards' source line. */
  attribution?: string
  license?: string
  sourceUrl?: string
  sizeBytes?: number
  tableCount?: number
  createdAt?: string
}

// ─────────────────────────────── catalog (semantic layer) ───────────────────────────────

export type ColumnRole =
  | "id" // primary key / surrogate id: never a measure, never a dimension
  | "fk" // foreign key column (see `fk`)
  | "dimension" // low-cardinality category to group or filter by
  | "label" // high-cardinality display name (person, university, country name)
  | "time" // integer year / decade etc. (see `grain`)
  | "date" // ISO date or datetime text
  | "measure" // numeric amount (see `agg`)
  | "geo_code" // ISO3 country code
  | "latitude"
  | "longitude"
  | "flag" // 0/1 boolean
  | "text" // long free text (motivation, description)
  | "url"
  | "order" // sort-only helper (rank, sort_order)
  | "hidden"

export type Agg = "sum" | "avg" | "min" | "max" | "count" | "count_distinct" | "weighted_avg"
/**
 * Absolute steps (year … day) are an ordered time axis. The cyclical ones (v0.2) fold every
 * period onto one cycle — "which weekday", "which month of the year", "which hour" — and render
 * as ordered categories, not a time axis.
 */
export type TimeGrain = "none" | "year" | "decade" | "quarter" | "month" | "day" | "weekday" | "month_of_year" | "hour"
export const CYCLICAL_GRAINS = ["weekday", "month_of_year", "hour"] as const satisfies readonly TimeGrain[]

export interface CatalogColumn {
  /** `${table}.${name}`; the only identifier form used across the app */
  key: string
  table: string
  name: string
  label: string
  description?: string
  sqlType: string // declared SQLite type, e.g. INTEGER, REAL, TEXT
  role: ColumnRole
  agg?: Agg // default aggregation for measures
  weight?: string // column key used by weighted_avg, e.g. "country_year.population"
  additive?: boolean // can be summed across groups
  unit?: string // "years", "USD", "%", "t CO2 per person"
  grain?: TimeGrain // for role time/date
  fk?: string // referenced column key when role === 'fk'
  synonyms: string[]
  distinctCount?: number
  nullCount?: number
  min?: number
  max?: number
  binnable?: boolean // sensible histogram subject
  binWidth?: number // preferred histogram bin width when binnable
  format?: "number" | "compact" | "currency" | "currency_compact" | "percent" | "years"
  scale?: "linear" | "log" // preferred axis scale (e.g. GDP per person → log)
  sortBy?: string // column name that orders this dimension's values (income group → rank)
  direction?: 1 | -1 | 0 // 1 higher is better, -1 lower is better
  /** latest time value with good coverage for this measure; the compiler's default "now" */
  latestYear?: number
  /** role "date" only: values carry a time of day ("2024-03-07 19:30"), so an hour grain is honest */
  hasTime?: boolean
}

export interface CatalogTable {
  name: string
  label: string
  description: string
  synonyms: string[]
  rowCount: number
  /** column name used as the row's display label (for rows answers / FK lookups) */
  display?: string
  /** preferred columns (names, FK columns resolve to their display) when listing records */
  listColumns?: string[]
  hidden?: boolean // tables starting with "_" and helper tables
  isView?: boolean
  columns: CatalogColumn[]
}

export interface CatalogJoin {
  from: string // column key on the many side, e.g. "awards.prize_id"
  to: string // column key on the one side, e.g. "prizes.prize_id"
  kind: "many-to-one" | "one-to-one"
}

/** A curated aggregate. `sql` is an aggregate expression over qualified columns. */
export interface CatalogMetric {
  key: string // e.g. "awards", "women_share"
  label: string // "Prizes won"
  description?: string
  sql: string // "COUNT(DISTINCT awards.laureate_id)"
  table: string // base (fact) table the expression is evaluated from
  synonyms: string[]
  unit?: string
  format?: "number" | "percent" | "currency" | "years"
}

/** One canonical value of a dimension/label column plus the words people use for it. */
export interface CatalogValue {
  column: string // column key
  value: string // canonical stored value, e.g. "female", "Physiology or Medicine", "USA"
  display?: string // human label if different (e.g. country name for an ISO3 code)
  aliases: string[] // "women", "woman" / "medicine" / "us", "america"
}

export interface TryPrompt {
  text: string
  /** chart the prompt is meant to showcase (documentation only; Jev still decides) */
  chart?: ChartType
}

export interface Catalog {
  datasetId: DatasetId
  title: string
  tagline: string
  /** One sentence Jev reads to judge in_scope, e.g. "Nobel Prizes 1901-2025: laureates, ..." */
  about: string
  /** Short topics Jev reads, e.g. ["prizes", "laureates", "universities", "countries of birth"] */
  contains: string[]
  tables: CatalogTable[]
  joins: CatalogJoin[]
  metrics: CatalogMetric[]
  /** Values of dimension/label/geo columns for filter matching (cap ~5,000 entries). */
  values: CatalogValue[]
  /** Human rules (shown in explorer "About"); compile-relevant ones are code in plan/datasets/* */
  rules: string[]
  tryPrompts: TryPrompt[]
  /** default fact table for counting, e.g. "awards" */
  defaultFact?: string
  /** stable hash of the schema, used in cache keys */
  schemaHash: string
  attribution?: string
  license?: string
  /**
   * v0.2: dataset-specific compile behaviour as DATA (from semantic.json), applied by one generic
   * engine (src/lib/plan/rules.ts). Replaces the per-dataset hook modules.
   */
  planRules?: PlanRule[]
  /** v0.2: how a relationship (measure vs measure2) chart is built: one dot per `entity`, sized/coloured */
  relationship?: { entity?: string; size?: string; color?: string }
  /** v0.2: a discriminator value -> the label a grouping narrowed by it should read as ("region" -> "Region") */
  groupLabels?: Record<string, string>
}

/** A filter written in the semantic layer (rules), bound like any other filter at compile time. */
export interface RuleFilter {
  column: string
  op: FilterOp
  values: (string | number)[]
  label: string
}

/**
 * Declarative compile rules (semantic.json `planRules`). Column/measure patterns are regex sources
 * matched against column keys ("laureates.gender") or measure option keys ("n:prizes").
 */
export type PlanRule =
  /** When the plan's measure/measure2/groupBy/rowTable matches `when`, add `filter` (unless a filter on that column exists). */
  | { kind: "require_filter"; when: string; filter: RuleFilter }
  /**
   * Group-level answers come from a precomputed rollup table instead of aggregating the fact:
   * `from` table columns are rerouted to the same-named columns of `to`. Triggered by grouping on
   * one of `groups[].table` (regrouped to `groups[].groupBy` plus its discriminator `filter`), by
   * any filter on a `filterTables` table, or — for `total` — a plain ungrouped total with no filter
   * on an `entityTables` table (reads the `total.filter` row, e.g. the World row).
   */
  | {
      kind: "rollup"
      from: string
      to: string
      groups: { table: string; groupBy: string; filter?: RuleFilter }[]
      filterTables: string[]
      total?: { filter: RuleFilter; entityTables: string[]; entityColumns?: string[] }
    }
  /** No time axis and no filter on the base table's year column -> filter to the measure's latestYear. */
  | { kind: "default_latest_year" }

// ─────────────────────────────── /api/plan ───────────────────────────────

/** An option's meaning as Jev reads it. Keys are sent too, so make them readable. */
export type OptionText = string | { what: string; examples?: string[] }

/** A value found in the question by code (value index / regex). Jev only decides how it is used. */
export interface FilterCandidate {
  id: string // "f0", "f1" ... (question id suffix)
  /**
   * "now"    = a relative "right now / latest / today / current" time mention (value "latest")
   * "range"  = v0.2: two years joined as a span ("between 1990 and 2010", "1990-2010"): value = start, value2 = end
   * "period" = v0.2: a relative window ("last 10 years", "past 30 days", "year to date"): value = N ("1" for ytd), unit
   */
  kind: "value" | "year" | "number" | "now" | "range" | "period"
  column: string // column key the value belongs to ("" for kind number)
  field: string // column label, e.g. "Category", "Country of birth"
  value: string // canonical value (as stored), e.g. "Physiology or Medicine", "1990"
  /** kind "range" only: the end year */
  value2?: string
  /** kind "period" only */
  unit?: PeriodUnit
  display: string // label for chips, e.g. "Medicine", "1990"
  matched: string // the text span in the question, e.g. "medicine"
  /**
   * When the value's table is linked to the fact through SEVERAL foreign keys (AFL matches ->
   * clubs as home, away, winner, loser), the roles it could play: one per FK column. Jev picks
   * one (or "any") so "played in" matches home OR away and "won" matches the winner only.
   */
  roles?: {
    key: string // FK column key, e.g. "matches.home_club_id"
    label: string // "Home club"
    /** v0.2: the FK column's own catalog synonyms ("won", "beat", "victor"), the role question's wording hints */
    synonyms?: string[]
  }[]
}

export interface PlanRequest {
  datasetId: DatasetId
  schemaHash: string
  question: string // trimmed, ≤ 300 chars
  dataset: { name: string; about: string; contains: string[] }
  /** measure option key → meaning; keys like "m:awards" (metric) or "c:awards.age_at_award:avg" */
  measures: Record<string, OptionText>
  /** group-by option key (column key) → meaning; time columns are NOT here (see timeGrains) */
  dimensions: Record<string, OptionText>
  /** time axis options available for this dataset, e.g. ["year", "decade"] */
  timeGrains: TimeGrain[]
  /** table name → meaning, for "list the rows" answers */
  rowTables: Record<string, OptionText>
  /** column key → meaning, sortable numeric/date columns for rows answers */
  sortColumns: Record<string, OptionText>
  /** numbers found in the question (limit candidates), as written: ["10", "5"] */
  numbers: string[]
  filters: FilterCandidate[]

  // ── v0.2 (all optional so a v0.1 request still validates; code always sends them) ──
  /** comparisons with a number ("over 100 million", "at least 5", "between 20 and 30") */
  thresholds?: ThresholdCandidate[]
  /** text fragments to search for ("containing 'love'", "starting with Mc", quoted text) */
  texts?: TextCandidate[]
  /** two value candidates on DIFFERENT columns joined by "or" in the question */
  orPairs?: OrPair[]
  /** a window of a ranking ("ranked 11 to 20", "the next 10") */
  rankWindows?: RankWindowCandidate[]
  /** generic English cues that gate the cue-only questions (so plain questions cost no extra Jev questions) */
  cues?: { missing: boolean; rate: boolean; change: boolean }
  /** column key -> meaning, columns with missing values (options for the `missing` question) */
  nullableColumns?: Record<string, OptionText>
  /** column key -> meaning, searchable text columns (options for `text:<id>` questions) */
  textColumns?: Record<string, OptionText>
}

export type PeriodUnit = "year" | "quarter" | "month" | "week" | "day" | "ytd"
export type ThresholdOp = "gt" | "gte" | "lt" | "lte" | "eq" | "between"

export interface ThresholdCandidate {
  id: string // "t0", "t1" ...
  op: ThresholdOp // from the comparator words, found by code
  values: number[] // magnitude words applied: "100 million" -> 100000000; two values for "between"
  matched: string // "over 100 million"
  display: string // "> 100M"
}

export interface TextCandidate {
  id: string // "x0" ...
  mode: "contains" | "starts" | "ends" | "exact"
  value: string // the fragment, unquoted
  matched: string // "containing 'love'"
}

export interface OrPair {
  id: string // "o0" ...
  a: string // FilterCandidate id
  b: string // FilterCandidate id
}

export interface RankWindowCandidate {
  id: string // "w0"
  from: number // 1-based first rank, e.g. 11
  to: number // last rank, e.g. 20
  matched: string
}

/** One Choice answer, normalized. */
export interface Answer<T extends string = string> {
  value: T
  confidence: number
  probabilities: Record<string, number>
}

export type AnswerKind = "aggregate" | "rows" | "distribution" | "unanswerable"
export type SortAnswer = "desc" | "asc" | "chronological" | "none"
/** v0.2 "share": the value defines the numerator of a percentage of the measure ("what share of X are V") */
export type ValueFilterUse = "include_only" | "exclude" | "share" | "not_a_filter"
/** v0.2 before/after: strict bounds (< / >) next to the inclusive from/until */
export type YearFilterUse = "in_year" | "from" | "until" | "before" | "after" | "not_a_filter"
/** v0.2, kind "range" candidates */
export type RangeUse = "between" | "separately" | "not_a_filter"
/** v0.2, kind "period" candidates */
export type PeriodUse = "within" | "not_a_filter"
/** v0.2, `threshold:<id>`: "agg" (the calculated amount per group -> HAVING) | a sortColumns key (each record's field -> WHERE) | "not_a_filter" */
export type ThresholdUse = string
/** v0.2 `time_calc` */
export type TimeCalc = "none" | "change" | "pct_change" | "running_total"

export interface PlanAnswers {
  /** Noul P(yes): the question asks about information recorded in this dataset */
  inScope: number
  answerKind: Answer<AnswerKind>
  /** measure option key | "none" */
  measure: Answer
  /** a second, different measure for "x vs y" / relationship questions | "none" */
  measure2: Answer
  /** dimension option key | "none" */
  groupBy: Answer
  /** "none" | one of PlanRequest.timeGrains */
  timeGrain: Answer
  sort: Answer<SortAnswer>
  /** `n${k}` for each PlanRequest.numbers entry | "one" | "not_stated" */
  limit: Answer
  /** table | "none" */
  rowTable: Answer
  /** column key | "none" */
  sortColumn: Answer
  /** a chart type the user named explicitly | "none" */
  namedChart: Answer
  /** keyed by FilterCandidate.id */
  filters: Record<string, Answer<ValueFilterUse | YearFilterUse | RangeUse | PeriodUse>>
  /** keyed by FilterCandidate.id, only for candidates with roles: an FK column key or "any" */
  filterRoles?: Record<string, Answer>

  // ── v0.2 (optional: absent = "none" / "not_a_filter", so v0.1 baked/cached answers still work) ──
  /** keyed by ThresholdCandidate.id: "agg" | a sortColumns key | "not_a_filter" */
  thresholds?: Record<string, Answer<ThresholdUse>>
  /** keyed by TextCandidate.id: a textColumns key | "not_a_filter" */
  texts?: Record<string, Answer>
  /** keyed by OrPair.id */
  combine?: Record<string, Answer<"both" | "either">>
  /** keyed by RankWindowCandidate.id */
  rankWindows?: Record<string, Answer<"window" | "not_a_filter">>
  /** a nullableColumns key + ":missing" / ":present" | "none" (asked only when cues.missing) */
  missing?: Answer
  /** denominator measure option key | "none" (asked only when cues.rate) */
  per?: Answer
  /** asked only when cues.change and the dataset has a time axis */
  timeCalc?: Answer<TimeCalc>
}

export interface JevMeta {
  source: "jev" | "offline" | "cache" | "baked"
  model: string // "jev-1.13.0" | "jev-offline"
  latencyMs: number
  questionCount: number
  /** why we are offline (no key, rate limited, timeout, error) when source === 'offline' */
  reason?: string
}

export interface PlanResponse {
  answers: PlanAnswers
  meta: JevMeta
}

// ─────────────────────────────── plan IR + compiled SQL ───────────────────────────────

/**
 * v0.2 adds: neq (<>), gt/lt (strict), between (values [lo, hi]), like (values [fragment], see
 * `pattern`), is_null / not_null (no values), within (a relative period, see `period`).
 */
export type FilterOp = "in" | "not_in" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "like" | "is_null" | "not_null" | "within"

export interface PlanFilter {
  column: string // column key
  op: FilterOp
  values: (string | number)[]
  label: string // "Category is Physics", "Year from 1990"
  candidateId?: string
  /**
   * FK columns the value is matched through when its table is linked several ways (from
   * FilterCandidate.roles): one = that role only (winner), several = any of them (home OR away).
   * Absent = the default join path.
   */
  via?: string[]
  /** v0.2: filters sharing a `group` are OR-ed together inside parentheses; everything else is AND-ed */
  group?: string
  /** v0.2, op "like": where the fragment must appear */
  pattern?: "contains" | "starts" | "ends" | "exact"
  /** v0.2, op "within": the last N units ending at the column's latest value in the data */
  period?: { n: number; unit: PeriodUnit }
}

/** v0.2: a condition on the aggregated measure (HAVING), e.g. "more than 10 wins" */
export interface HavingFilter {
  op: ThresholdOp
  values: number[]
  label: string // "Prizes won over 10"
  candidateId?: string
}

/** The typed, Jev-independent query plan. Stored on pins; re-compiled on load. */
export interface QueryPlan {
  datasetId: DatasetId
  kind: "aggregate" | "rows" | "distribution"
  /** measure option key (see PlanRequest.measures) */
  measure?: string
  measure2?: string
  /** dimension column key */
  groupBy?: string
  time?: { column: string; grain: TimeGrain }
  filters: PlanFilter[]
  sort: { by: "measure" | "x" | "column"; column?: string; dir: "asc" | "desc" }
  limit: number
  rowTable?: string
  /** histogram bin width for kind === 'distribution' (code picks a nice width) */
  binWidth?: number

  // ── v0.2 (all optional; a v0.1 pin's plan compiles exactly as before) ──
  /** conditions on the aggregated measure, emitted as HAVING (grouped aggregates only) */
  having?: HavingFilter[]
  /**
   * the measure becomes "share of the measure where `column` is one of `values`", in percent:
   * 100.0 * AGG(CASE WHEN cond THEN x END) / NULLIF(AGG(x), 0)
   */
  share?: { column: string; values: (string | number)[]; label: string; via?: string[]; candidateId?: string }
  /** denominator measure option key: measure / NULLIF(per, 0) */
  per?: string
  /** computed over the time axis with window functions (needs `time`) */
  timeCalc?: Exclude<TimeCalc, "none">
  /**
   * groupBy is a numeric column cut into bands (groupBy key "b:<table.col>"): explicit edges from
   * the question, or code-picked nice edges when absent. CASE WHEN x < ? THEN ... END.
   */
  bands?: { edges: number[] }
  /** rows to skip before `limit` (rank windows, table paging) */
  offset?: number
}

export type ColumnKind =
  | "time" // ordered time axis (year, decade, date bucket)
  | "category" // discrete label
  | "amount" // numeric measure
  | "geo_code" // ISO3
  | "latitude"
  | "longitude"
  | "text" // free text / long label
  | "id"

export interface ResultColumnMeta {
  name: string // column name in the result set (SQL alias)
  label: string
  kind: ColumnKind
  unit?: string
  format?: CatalogMetric["format"]
  /** catalog column key when the column maps 1:1 to a catalog column */
  source?: string
}

export interface CompiledQuery {
  /** parameterised SQL that is actually executed (values bound as ?) */
  sql: string
  params: Cell[]
  /**
   * The same query for people: literals inlined (strings single-quoted with '' escaping, numbers
   * as-is, NULL) and pretty-printed. Shown in the UI, copied, and opened in the SQL console, where
   * it must run unchanged.
   */
  displaySql?: string
  /** deterministic human title, e.g. "Prizes won by category", "Top 10 universities by prizes" */
  title: string
  subtitle?: string // "Physics · 1990 onwards"
  columns: ResultColumnMeta[]
}

// ─────────────────────────────── result profile + charts ───────────────────────────────

export const CHART_TYPES = [
  "kpi",
  "bar", // vertical columns, few categories / time buckets
  "hbar", // horizontal ranked bars
  "line",
  "area",
  "multi_line",
  "stacked_bar",
  "grouped_bar",
  "donut",
  "scatter",
  "bubble",
  "histogram",
  "heatmap",
  "choropleth",
  "point_map",
  "table",
] as const
export type ChartType = (typeof CHART_TYPES)[number]

export interface ProfiledColumn extends ResultColumnMeta {
  distinct: number
  nulls: number
  min?: number
  max?: number
}

export interface ResultProfile {
  rowCount: number
  truncated: boolean
  columns: ProfiledColumn[]
  firstRows: Cell[][] // ≤ 8
}

export interface ChartRequest {
  datasetId: DatasetId
  question: string
  result: {
    row_count: number
    columns: { name: string; kind: ColumnKind; distinct: number; unit?: string }[]
    first_rows: Cell[][]
  }
  /** eligible chart type → criterion text (from the chart registry); ≥ 1 entry */
  eligible: Partial<Record<ChartType, string>>
}

export interface ChartResponse {
  answer: Answer<ChartType>
  meta: JevMeta
}

/** How result columns map onto a chart. Pure data; renderers never re-query. */
export interface ChartSpec {
  type: ChartType
  x?: string // column name: category / time / amount (scatter)
  y?: string[] // amount column names (one per series when wide)
  series?: string // category column that splits series (long format)
  size?: string // bubble size column
  color?: string // category column for scatter/bubble colour
  geo?: string // ISO3 column for choropleth
  lat?: string
  lon?: string
  label?: string // point/row label column
  logX?: boolean
  logY?: boolean
  percent?: boolean // values are 0-100 shares
}

// ─────────────────────────────── dashboard ───────────────────────────────

export interface Pin {
  id: string
  datasetId: DatasetId
  question: string
  title: string
  subtitle?: string
  /** null when the pin came from hand-written SQL (explorer console / edited SQL) */
  plan: QueryPlan | null
  sql: string
  params: Cell[]
  columns: ResultColumnMeta[]
  chart: ChartSpec
  /** Jev's chart ranking at pin time, for the card's chart switcher */
  chartRanking?: { type: ChartType; p: number }[]
  createdAt: string
}

export interface PinLayout {
  x: number
  y: number
  w: number
  h: number
}

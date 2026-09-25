/**
 * OWNER: planner. Compiles a Jev-independent `QueryPlan` into parameterised SQL: resolves the base
 * table from the measure/row table, BFS-joins the FK graph (identifiers only from the catalog,
 * values only as bound `?` params), and builds a deterministic title/subtitle and column metadata
 * for every output column. Dataset rules (semantic.json `planRules`) run first as a plan rewrite —
 * see rules.ts. WHERE/HAVING live in where.ts, shared SQL helpers in sql.ts.
 *
 * v0.2 OWNER: implementer B (calculations) — assembly of SELECT / GROUP BY / window wrapping.
 */
import { format } from "sql-formatter"
import { CYCLICAL_GRAINS, type Catalog, type CatalogColumn, type CatalogTable, type Cell, type ColumnKind, type CompiledQuery, type PlanFilter, type QueryPlan, type ResultColumnMeta, type TimeGrain } from "@shared/contract"
import {
  buildBandColumn,
  buildShareNumerator,
  buildTimeCalcSql,
  cyclicalGrainWords,
  cyclicalTimeSelect,
  detectMeasureShape,
  groupByColumnKey,
  isBandKey,
  reachedWithoutFanOut,
} from "./calc"
import { shortestJoinPath } from "./graph"
import { capitalizeFirst, pluralize } from "./normalize"
import { catalogColumn, catalogTable, JoinPlanner, ParamList, q, qcol, sqlLiteral } from "./sql"
import { applyPlanRules, groupLabelFor, relationshipColorFk, relationshipEntity, relationshipSize } from "./rules"
import { buildCondition, buildHaving, buildWhere } from "./where"

/**
 * CONTRACT ISSUE (reported, not fixed here — contract.ts is read-only): `ResultColumnMeta.format`
 * is typed as `CatalogMetric["format"]` (4 variants), but a result column just as often mirrors a
 * `CatalogColumn`, whose `format` has two more variants ("compact", "currency_compact") used by
 * World's population/GDP columns. The value itself is fine at runtime; this narrows the TYPE only.
 */
function toResultFormat(format: CatalogColumn["format"]): ResultColumnMeta["format"] {
  return format as ResultColumnMeta["format"]
}

/** A dimension table small enough that a "top N series" cap would only ever drop real groups. */
const SERIES_CAP_SKIP_ROWS = 20
const SERIES_CAP = 6

// ─────────────────────────────── measures ───────────────────────────────

interface MeasureInfo {
  table: string
  expr: (jp: JoinPlanner) => string
  outputName: string
  label: string
  unit?: string
  format?: ResultColumnMeta["format"]
  /** the plain column this measure reads, for the "measure IS NOT NULL" rule (undefined for m:/n:) */
  nullableColumn?: CatalogColumn
}

function aggExpr(agg: NonNullable<CatalogColumn["agg"]>, col: CatalogColumn, catalog: Catalog, alias: string): string {
  const c = qcol(alias, col.name)
  switch (agg) {
    case "sum":
      return `SUM(${c})`
    case "avg":
      return `AVG(${c})`
    case "min":
      return `MIN(${c})`
    case "max":
      return `MAX(${c})`
    case "count":
      return `COUNT(${c})`
    case "count_distinct":
      return `COUNT(DISTINCT ${c})`
    case "weighted_avg": {
      const weightCol = col.weight ? catalogColumn(catalog, col.weight) : undefined
      if (!weightCol) return `AVG(${c})`
      const w = qcol(alias, weightCol.name)
      return `SUM(${c} * ${w}) / NULLIF(SUM(CASE WHEN ${c} IS NOT NULL THEN ${w} END), 0)`
    }
  }
}

function resolveMeasure(key: string, catalog: Catalog): MeasureInfo {
  if (key.startsWith("m:")) {
    const metricKey = key.slice(2)
    const metric = catalog.metrics.find((m) => m.key === metricKey)
    if (!metric) throw new Error(`compilePlan: unknown metric "${metricKey}"`)
    // metric.sql already qualifies columns as "table.column"; rewrite to the join alias at emit time.
    return {
      table: metric.table,
      expr: (jp) => rewriteQualifiedSql(metric.sql, catalog, jp),
      outputName: metric.key,
      label: metric.label,
      unit: metric.unit,
      format: metric.format,
    }
  }
  if (key.startsWith("n:")) {
    const table = key.slice(2)
    const t = catalogTable(catalog, table)
    return { table, expr: () => `COUNT(*)`, outputName: `${table}_count`, label: `Number of ${lc(t.label)}`, format: "number" }
  }
  // "c:<table.col>:<agg>"
  const rest = key.slice(2)
  const sep = rest.lastIndexOf(":")
  const colKey = rest.slice(0, sep)
  const agg = rest.slice(sep + 1) as NonNullable<CatalogColumn["agg"]>
  const col = catalogColumn(catalog, colKey)
  return {
    table: col.table,
    expr: (jp) => aggExpr(agg, col, catalog, jp.ensureTable(col.table)),
    outputName: col.name,
    label: col.label,
    unit: col.unit,
    format: toResultFormat(col.format),
    nullableColumn: col,
  }
}

/** Metric SQL is written as `SOME_AGG(table.column)`; swap each `table.column` for its join alias. */
function rewriteQualifiedSql(sql: string, catalog: Catalog, jp: JoinPlanner): string {
  return sql.replace(/\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\b/g, (m, table: string, col: string) => {
    const t = catalog.tables.find((x) => x.name === table)
    if (!t || !t.columns.some((c) => c.name === col)) return m
    return qcol(jp.ensureTable(table), col)
  })
}

/** Lowercase a label for mid-sentence use, keeping acronyms and codes (CO2, GDP, SEK) intact. */
const lc = (s: string) => s.replace(/\S+/g, (w) => (/\d|[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()))

// ─────────────────────────────── dimensions ───────────────────────────────

interface DimSelect {
  columns: { expr: string; outputName: string; kind: ColumnKind; source: string; label: string; format?: ResultColumnMeta["format"] }[]
  groupByExprs: string[]
}

function outputName(label: string, used: Set<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!base) base = "col"
  let name = base
  let i = 2
  while (used.has(name)) name = `${base}_${i++}`
  used.add(name)
  return name
}

function kindOf(col: CatalogColumn): ColumnKind {
  switch (col.role) {
    case "time":
      return "time"
    case "geo_code":
      return "geo_code"
    case "latitude":
      return "latitude"
    case "longitude":
      return "longitude"
    case "measure":
      return "amount"
    case "id":
      return "id"
    case "text":
    case "url":
      return "text"
    default:
      return "category"
  }
}

/** v0.2: code-constant label for a NULL-valued group ("(none)"), never a value the question named. */
const NULL_GROUP_LABEL = "(none)"

/** A dimension/label group column with real NULL values reads as a blank/missing group in the
 *  chart otherwise — COALESCE it to a code-constant "(none)" label, identically in SELECT and
 *  GROUP BY (the caller pushes this same expression string to both). geo_code columns keep their
 *  raw code (never missing by construction); only their paired display name can be null-checked. */
function coalesceNullGroup(expr: string, col: CatalogColumn): string {
  const isLabelish = col.role === "dimension" || col.role === "label"
  return isLabelish && (col.nullCount ?? 0) > 0 ? `COALESCE(${expr}, ${sqlLiteral(NULL_GROUP_LABEL)})` : expr
}

function buildDimensionSelect(catalog: Catalog, jp: JoinPlanner, groupByKey: string, used: Set<string>): DimSelect {
  const col = catalogColumn(catalog, groupByKey)
  const alias = jp.ensureTable(col.table)
  const columns: DimSelect["columns"] = []
  const groupByExprs: string[] = []

  const mainExpr = coalesceNullGroup(qcol(alias, col.name), col)
  columns.push({ expr: mainExpr, outputName: outputName(col.label, used), kind: kindOf(col), source: col.key, label: col.label })
  groupByExprs.push(mainExpr)

  if (col.role === "geo_code" && col.fk) {
    // A geo_code column that POINTS AT another table (e.g. country_year.country_code ->
    // countries) — fetch that table's display name alongside the code via the FK join.
    const { alias: dispAlias, table: dispTable } = jp.ensureFkJoin(col.key, { left: false })
    const dt = catalogTable(catalog, dispTable)
    const dispCol = dt.columns.find((c) => c.name === dt.display) ?? dt.columns.find((c) => c.role === "dimension" || c.role === "label")
    if (dispCol) {
      const dExpr = coalesceNullGroup(qcol(dispAlias, dispCol.name), dispCol)
      columns.push({ expr: dExpr, outputName: outputName(dispCol.label, used), kind: "category", source: dispCol.key, label: dispCol.label })
      groupByExprs.push(dExpr)
    }
  } else if (col.role === "geo_code") {
    // A geo_code column that IS the identity (e.g. countries.country_code itself, no .fk) —
    // its own table already carries the display name; no extra join needed.
    const ownTable = catalogTable(catalog, col.table)
    const dispCol = ownTable.columns.find((c) => c.name === ownTable.display && c.name !== col.name)
    if (dispCol) {
      const dExpr = coalesceNullGroup(qcol(alias, dispCol.name), dispCol)
      columns.push({ expr: dExpr, outputName: outputName(dispCol.label, used), kind: "category", source: dispCol.key, label: dispCol.label })
      groupByExprs.push(dExpr)
    }
  }
  return { columns, groupByExprs }
}

// ─────────────────────────────── title/subtitle ───────────────────────────────

/** "Category is Physics or Gender is female · Year from 1990 · Prizes won over 200": filters in an
 *  OR group read as one "or" phrase (they are one `(a OR b)` clause in the SQL), the rest are
 *  AND-ed and joined with " · ", then any HAVING conditions. */
function filterSubtitle(plan: QueryPlan): string | undefined {
  // Ordered entries: a plain filter is one label; an OR group collects its labels at the position
  // of its first member.
  const entries: string[][] = []
  const byGroup = new Map<string, string[]>()
  for (const f of plan.filters) {
    if (!f.group) {
      entries.push([f.label])
      continue
    }
    const existing = byGroup.get(f.group)
    if (existing) existing.push(f.label)
    else {
      const fresh = [f.label]
      byGroup.set(f.group, fresh)
      entries.push(fresh)
    }
  }
  const parts = entries.map((labels) => labels.join(" or "))
  for (const h of plan.having ?? []) parts.push(h.label)
  return parts.length ? parts.join(" · ") : undefined
}

/** The actual [min, max] a time-series title should claim, narrowed by any explicit from/until
 *  filter on that same column (catalog stats give the full extent; a filter narrows it) and by
 *  the measure's own `latestYear` when the column's raw max runs past where that measure actually
 *  has data (e.g. `country_year.year` reaches 2025, but life_expectancy's own coverage ends 2024). */
function timeRangeFor(catalog: Catalog, plan: QueryPlan, measureCol?: CatalogColumn): { start: number; end: number } | undefined {
  if (!plan.time) return undefined
  // A discrete list of specific years ("2000 vs 2020") isn't a continuous span — claiming its
  // catalog-wide min–max would be misleading (the chart only ever shows those exact years).
  if (plan.filters.some((f) => f.column === plan.time!.column && f.op === "in" && f.values.length > 1)) return undefined
  const col = catalogColumn(catalog, plan.time.column)
  let start = col.min
  let end = measureCol?.latestYear !== undefined && col.max !== undefined ? Math.min(col.max, measureCol.latestYear) : col.max
  for (const f of plan.filters) {
    if (f.column !== plan.time.column) continue
    if (f.op === "gte") start = Math.max(start ?? -Infinity, Number(f.values[0]))
    if (f.op === "lte") end = Math.min(end ?? Infinity, Number(f.values[0]))
  }
  return start !== undefined && end !== undefined ? { start: Math.round(start), end: Math.round(end) } : undefined
}

/** The specific years of a discrete year comparison ("1990 vs 2020", "population now vs 1986" —
 *  see interpret.ts's `yearComparison`), sorted chronologically, or undefined for a continuous
 *  time series. Mirrors the exclusion in `timeRangeFor` above: an "in" filter with 2+ values on
 *  the time axis column IS this comparison, by construction. */
function yearComparisonFor(plan: QueryPlan): number[] | undefined {
  if (!plan.time || plan.time.grain !== "year") return undefined
  const f = plan.filters.find((flt) => flt.column === plan.time!.column && flt.op === "in" && flt.values.length > 1)
  if (!f) return undefined
  return f.values.map(Number).sort((a, b) => a - b)
}

/** A single year silently defaulted in by a dataset hook (no time axis, no user-stated year) —
 *  such a filter has no `candidateId` (nothing in the question produced it), unlike any filter
 *  built from what the user actually said. Surfacing it in the title keeps the chart honest about
 *  which year its numbers are for. */
function defaultYearFor(catalog: Catalog, plan: QueryPlan): number | undefined {
  if (plan.time) return undefined
  for (const f of plan.filters) {
    if (f.candidateId || f.op !== "eq" || f.values.length !== 1) continue
    const col = catalogColumn(catalog, f.column)
    if (col.role === "time" && col.grain === "year") return Number(f.values[0])
  }
  return undefined
}

/** Whether a "Top N" prefix is honest: only when N would actually cut the dimension down, per the
 *  catalog's own distinct-value count (falls back to the old fixed heuristic when stats are
 *  missing, e.g. an uploaded dataset built without full profiling). A dimension narrowed by
 *  another filter on the SAME table (e.g. World's shared `aggregates.name` restricted to
 *  `aggregates.kind = income`, leaving only 4 of its 12 rows) can't trust that whole-table count —
 *  skip the claim rather than risk an honest-sounding "Top 10" over a mere 4. */
function ranks(catalog: Catalog, plan: QueryPlan, limit: number): boolean {
  if (!plan.groupBy) return false
  const table = catalogColumn(catalog, plan.groupBy).table
  // Only a co-filter on another DIMENSION column of that same table narrows its cardinality
  // (aggregates.kind discriminates which subset of aggregates.name rows exist); a time/measure
  // co-filter (e.g. a default year on country_year) doesn't change how many countries exist.
  const coFiltered = plan.filters.some((f) => f.column !== plan.groupBy && catalogColumn(catalog, f.column).table === table && catalogColumn(catalog, f.column).role === "dimension")
  if (coFiltered) return false
  const distinct = catalogColumn(catalog, plan.groupBy).distinctCount
  return distinct === undefined ? limit <= 20 : limit < distinct
}

function buildTitle(
  catalog: Catalog,
  plan: QueryPlan,
  measureLabel: string,
  groupLabelRaw: string | undefined,
  kind: QueryPlan["kind"],
  measureCol?: CatalogColumn,
): string {
  if (kind === "distribution") return `Distribution of ${lc(measureLabel)}`
  if (kind === "rows") return measureLabel

  // v0.2: bands and cyclical grains get their own fixed phrasing — words come from the band/grain,
  // never a dataset noun — bypassing the ranks/range heuristics below, which assume an ordinary
  // dimension or a continuous time axis.
  if (plan.groupBy && isBandKey(plan.groupBy)) {
    const col = catalogColumn(catalog, groupByColumnKey(plan.groupBy))
    return `${measureLabel} by ${lc(col.label)} band`
  }
  if (plan.time && (CYCLICAL_GRAINS as readonly string[]).includes(plan.time.grain)) {
    return `${measureLabel} by ${cyclicalGrainWords(plan.time.grain as "weekday" | "month_of_year" | "hour")}`
  }

  const groupLabel = groupLabelFor(catalog, plan, groupLabelRaw)
  const grain: TimeGrain | undefined = plan.time?.grain
  if (groupLabel && grain === "decade") return `${measureLabel} by decade and ${lc(groupLabel)}`

  const years = yearComparisonFor(plan)
  if (years) {
    const ys = years.join(" vs ")
    return groupLabel ? `${measureLabel} by ${lc(groupLabel)}, ${ys}` : `${measureLabel}, ${ys}`
  }

  const range = timeRangeFor(catalog, plan, measureCol)
  if (groupLabel && grain && range) return `${measureLabel} by ${lc(groupLabel)}, ${range.start}–${range.end}`

  let base: string
  const offset = Math.floor(plan.offset ?? 0)
  if (groupLabel && offset > 0)
    base = `${capitalizeFirst(lc(pluralize(groupLabel)))} ranked ${offset + 1}–${offset + plan.limit} by ${lc(measureLabel)}`
  else if (groupLabel && ranks(catalog, plan, plan.limit))
    base = plan.limit === 1 ? `Top ${lc(groupLabel)} by ${lc(measureLabel)}` : `Top ${plan.limit} ${lc(pluralize(groupLabel))} by ${lc(measureLabel)}`
  else if (groupLabel) base = `${measureLabel} by ${lc(groupLabel)}`
  else if (grain) base = `${measureLabel} over time`
  else base = measureLabel

  const defaultYear = defaultYearFor(catalog, plan)
  return defaultYear !== undefined ? `${base}, ${defaultYear}` : base
}

// ─────────────────────────────── "now" placeholder resolution ───────────────────────────────

/** The `CatalogColumn` a "c:<table.col>:<agg>" measure key reads, or undefined for "m:"/"n:" keys. */
function measureColumnFor(key: string | undefined, catalog: Catalog): CatalogColumn | undefined {
  if (!key?.startsWith("c:")) return undefined
  const rest = key.slice(2)
  const colKey = rest.slice(0, rest.lastIndexOf(":"))
  return catalog.tables.find((t) => t.name === colKey.split(".")[0])?.columns.find((c) => c.key === colKey)
}

/**
 * Resolves the "latest" placeholder a `kind: "now"` filter candidate leaves in `PlanFilter.values`
 * (see candidates.ts, interpret.ts's buildFilters) to a real year: the plan's own measure's
 * `CatalogColumn.latestYear` (the min across measure + measure2 for a relationship chart, matching
 * World's own default-year rule in datasets/world.ts), or — no measure, or no known latestYear
 * (Nobel sets none) — the filtered time column's own catalog `max`. Runs once, centrally, after
 * any dataset-hook plan rewrite, so every plan kind and every dataset hook sees only real years.
 */
function resolveNowPlaceholders(plan: QueryPlan, catalog: Catalog): QueryPlan {
  if (!plan.filters.some((f) => f.values.includes("latest"))) return plan
  const m1 = measureColumnFor(plan.measure, catalog)?.latestYear
  const m2 = measureColumnFor(plan.measure2, catalog)?.latestYear
  const measureLatest = m1 !== undefined && m2 !== undefined ? Math.min(m1, m2) : (m1 ?? m2)
  return {
    ...plan,
    filters: plan.filters.map((f) => {
      if (!f.values.includes("latest")) return f
      const col = catalogColumn(catalog, f.column)
      const year = measureLatest ?? col.max ?? col.latestYear
      // The chip/subtitle says the real year once it is known ("Year is 2025"), not the placeholder.
      const label = year !== undefined ? f.label.replace("the latest year", String(year)) : f.label
      return { ...f, label, values: f.values.map((v) => (v === "latest" ? (year ?? v) : v)) }
    }),
  }
}

// ─────────────────────────────── displaySql ───────────────────────────────

/** Inlines `?` placeholders as SQL literals, in order — skipping any `?` that happens to sit
 *  inside a string/identifier literal already present in `sql` (none exist today; every value the
 *  compiler emits is bound, never inlined — this is just defensive). */
function inlineParams(sql: string, params: Cell[]): string {
  let out = ""
  let paramIndex = 0
  let quote: '"' | "'" | undefined
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i]
          continue
        }
        quote = undefined
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === "?") {
      out += sqlLiteral(params[paramIndex++] ?? null)
      continue
    }
    out += ch
  }
  return out
}

/** `CompiledQuery.displaySql`: the executed SQL with bound params inlined as literals, pretty-
 *  printed for people — shown in the UI, copied, and pasted into the explorer's SQL console, where
 *  it must run unchanged (it needs no `?` params). Falls back to the inlined-but-unformatted SQL if
 *  sql-formatter ever throws on a shape it doesn't expect, so a formatting bug never breaks a query. */
function buildDisplaySql(sql: string, params: Cell[]): string {
  const inlined = inlineParams(sql, params)
  try {
    return format(inlined, { language: "sqlite", keywordCase: "upper", tabWidth: 2 })
  } catch {
    return inlined
  }
}

// ─────────────────────────────── main entry ───────────────────────────────

/**
 * Standalone tables (no joins) now offer their dimensions to Jev, so a plan can pair a measure
 * with a grouping from a table it cannot reach (Swift: song counts "by ceremony"). Rather than
 * failing, answer without that grouping.
 */
function dropUnreachableGrouping(plan: QueryPlan, catalog: Catalog): QueryPlan {
  if (plan.kind !== "aggregate" || !plan.groupBy || !plan.measure) return plan
  const base = resolveMeasure(plan.measure, catalog).table
  const groupTable = groupByColumnKey(plan.groupBy).split(".")[0]!
  if (groupTable === base || shortestJoinPath(catalog, base, groupTable)) return plan
  return { ...plan, groupBy: undefined, bands: undefined }
}

export function compilePlan(rawPlan: QueryPlan, catalog: Catalog): CompiledQuery {
  const rewritten = applyPlanRules(rawPlan, catalog)
  const plan = dropUnreachableGrouping(resolveNowPlaceholders(rewritten, catalog), catalog)

  const compiled = plan.kind === "rows" ? compileRows(plan, catalog) : plan.kind === "distribution" ? compileDistribution(plan, catalog) : compileAggregate(plan, catalog)
  return { ...compiled, displaySql: buildDisplaySql(compiled.sql, compiled.params) }
}

/** " OFFSET n" for a rank window / table page, else "". An integer from code (never a bound
 *  value), clamped here. */
function offsetSql(plan: QueryPlan): string {
  const n = Math.floor(plan.offset ?? 0)
  return n > 0 ? ` OFFSET ${Math.min(n, 1_000_000)}` : ""
}

/** Grain label for the time axis's result column (compileAggregate names its output after this). */
const TIME_GRAIN_LABEL: Record<string, string> = {
  year: "Year",
  decade: "Decade",
  month: "Month",
  quarter: "Quarter",
  day: "Date",
  // v0.2 cyclical grains
  weekday: "Day of week",
  month_of_year: "Month of year",
  hour: "Hour of day",
}

/** Buckets a 'date'-role column (a real DATE/DATETIME/TIMESTAMP value, or TEXT that looks like
 *  one — see buildAutoCatalog) with SQLite's strftime/date functions; a 'time'-role column (an
 *  integer year, or Nobel/World's own `decade` column) uses plain arithmetic instead. `orderExpr`
 *  is only set when it differs from `expr` (v0.2 cyclical grains, whose label isn't itself
 *  sortable); `kind` is only set to override the caller's default "time" (v0.2 cyclical grains are
 *  a "category" — every period folds onto one cycle, not an ordered axis). */
function timeSelectExpr(catalog: Catalog, jp: JoinPlanner, time: NonNullable<QueryPlan["time"]>): { expr: string; outputName: string; orderExpr?: string; kind?: ColumnKind } {
  const timeCol = catalogColumn(catalog, time.column)
  const alias = jp.ensureTable(timeCol.table)
  const colExpr = qcol(alias, timeCol.name)

  // v0.2 cyclical grains: fold every period onto one cycle (a weekday, a month of year, an hour).
  if (time.grain === "weekday" || time.grain === "month_of_year" || time.grain === "hour") {
    const cyc = cyclicalTimeSelect(time.grain, colExpr)
    return { expr: cyc.expr, outputName: time.grain, orderExpr: cyc.orderExpr, kind: "category" }
  }

  if (timeCol.role === "date") {
    switch (time.grain) {
      case "day":
        return { expr: `date(${colExpr})`, outputName: "day" }
      case "month":
        return { expr: `strftime('%Y-%m', ${colExpr})`, outputName: "month" }
      case "quarter":
        return { expr: `(strftime('%Y', ${colExpr}) || '-Q' || ((CAST(strftime('%m', ${colExpr}) AS INTEGER) + 2) / 3))`, outputName: "quarter" }
      default:
        return { expr: `strftime('%Y', ${colExpr})`, outputName: "year" }
    }
  }

  if (time.grain === "decade") {
    const table = catalogTable(catalog, timeCol.table)
    const decadeCol = table.columns.find((c) => c.role === "time" && c.grain === "decade")
    if (decadeCol) return { expr: qcol(alias, decadeCol.name), outputName: "decade" }
    return { expr: `(${colExpr} / 10) * 10`, outputName: "decade" }
  }
  return { expr: colExpr, outputName: "year" }
}

/**
 * v0.2 parameter ordering: SQLite binds `?` placeholders in the order they appear in the FINAL SQL
 * TEXT, not the order code happens to build them in. A share's CASE WHEN (SELECT position) now
 * sits textually before the WHERE clause, and the series-cap subquery repeats the WHERE text
 * verbatim (so it needs the SAME values bound again, right after). Rather than one shared
 * `ParamList` (the old series-cap hack duplicated EVERY param bound so far, wrongly including any
 * SELECT-side ones), each clause gets its own list, concatenated in text order at the very end:
 * SELECT (bands, share) → WHERE (plan filters, nullable-measure guard, band/share-fallback extras,
 * the series-cap subquery's repeat) → HAVING.
 */
function compileAggregate(plan: QueryPlan, catalog: Catalog): CompiledQuery {
  if (!plan.measure) throw new Error("compilePlan: aggregate plan has no measure")
  const measure = resolveMeasure(plan.measure, catalog)
  const jp = new JoinPlanner(catalog, measure.table)
  const selectParams = new ParamList()
  const whereParams = new ParamList()
  const havingParams = new ParamList()
  const used = new Set<string>()

  const selectCols: string[] = []
  const resultCols: ResultColumnMeta[] = []
  const groupByExprs: string[] = []
  const notes: string[] = []

  let timeName: string | undefined
  let timeOrderExpr: string | undefined
  if (plan.time) {
    const t = timeSelectExpr(catalog, jp, plan.time)
    timeName = outputName(t.outputName, used)
    selectCols.push(`${t.expr} AS ${q(timeName)}`)
    groupByExprs.push(t.expr)
    timeOrderExpr = t.orderExpr ?? q(timeName)
    resultCols.push({ name: timeName, label: TIME_GRAIN_LABEL[t.outputName] ?? "Year", kind: t.kind ?? "time" })
  }

  // measure2 relationship: one row per entity, m1 + m2 (+ size/color when the dataset hook supplies
  // them) — share/per/bands/timeCalc are all plain-aggregate-only features, so nothing below this
  // point is relevant to a relationship chart.
  if (plan.measure2) {
    return compileRelationship(plan, catalog, measure, jp, new ParamList(), used)
  }

  let groupLabel: string | undefined
  let bandOrderExpr: string | undefined
  const groupByRaw = plan.groupBy
  const groupByReal = groupByRaw ? groupByColumnKey(groupByRaw) : undefined
  // A groupBy that can't structurally reach the measure's table (a self-contradictory answer,
  // usually from the offline planner) degrades to a plain aggregate rather than crashing.
  const groupByReachable = groupByReal ? jp.tryEnsureTable(catalogColumn(catalog, groupByReal).table) !== undefined : false

  if (groupByRaw && groupByReachable && isBandKey(groupByRaw) && plan.bands?.edges.length) {
    const col = catalogColumn(catalog, groupByReal!)
    const alias = jp.ensureTable(col.table)
    const colExpr = qcol(alias, col.name)
    // "<label> band", never bare `col.label` — GROUP BY below references this alias by NAME (the
    // SQLite-supported alias trick, same as `band.orderExpr` does for ORDER BY), and a bare label
    // slugifies to the same string as the raw column name for most measure columns (e.g. "Age at
    // award" -> "age_at_award", identical to `col.name`) — SQLite then resolves that identifier to
    // the real column in scope instead of the SELECT alias, silently grouping by the raw value.
    const bandName = outputName(`${col.label} band`, used)
    const band = buildBandColumn(col.format, colExpr, plan.bands.edges, bandName, selectParams)
    selectCols.push(`${band.caseExpr} AS ${q(bandName)}`)
    resultCols.push({ name: bandName, label: col.label, kind: "category", source: col.key })
    // Group by the SELECT alias, not a second copy of the CASE expression: SQLite accepts an
    // output-column alias in GROUP BY (same trick `band.orderExpr` uses for ORDER BY), and reusing
    // `band.caseExpr` verbatim here would duplicate its "?" placeholders in the SQL text without a
    // second set of bound values.
    groupByExprs.push(q(bandName))
    bandOrderExpr = band.orderExpr
    groupLabel = col.label
  } else if (groupByRaw && groupByReachable) {
    const dim = buildDimensionSelect(catalog, jp, groupByRaw, used)
    for (const c of dim.columns) {
      selectCols.push(`${c.expr} AS ${q(c.outputName)}`)
      resultCols.push({ name: c.outputName, label: c.label, kind: c.kind, source: c.source })
    }
    groupByExprs.push(...dim.groupByExprs)
    // Prefer the paired display column's label for the title ("Country") over a geo_code
    // column's own, more technical one ("Country code") — buildDimensionSelect adds that
    // display column right alongside the code for exactly this readability.
    groupLabel = dim.columns.find((c) => c.kind === "category")?.label ?? catalogColumn(catalog, groupByRaw).label
  }

  // v0.2 share: the measure becomes "share of the measure where <column> is one of <values>", in
  // percent — recognised by the already-built measure expression's own SQL SHAPE (COUNT(*), SUM(x),
  // COUNT(DISTINCT x)), so a curated "m:" metric gets the same treatment as a plain "c:" column
  // measure. Anything else (AVG/MIN/MAX/weighted_avg, or an unrecognised metric shape) can't be
  // wrapped this way — falls back to a plain include filter instead, noted in the subtitle.
  const rawMeasureExpr = measure.expr(jp)
  let measureExpr = rawMeasureExpr
  let measureFormat = measure.format
  let measureLabelOut = measure.label
  let measureUnit = measure.unit
  // Bound BEFORE `buildWhere` runs below, so its params land first in `whereParams` — kept as the
  // FIRST where clause (see `whereClauses` assembly) to match that text order.
  let shareFallbackCond: string | undefined
  if (plan.share) {
    const shareFilter: PlanFilter = { column: plan.share.column, op: "in", values: plan.share.values, label: "", via: plan.share.via }
    const shape = detectMeasureShape(rawMeasureExpr)
    if (shape.kind === "other") {
      const cond = buildCondition(catalog, jp, shareFilter, whereParams)
      if (cond) {
        shareFallbackCond = cond
        notes.push(`"${lc(measure.label)}" can't be split into a share here, so this is filtered to that group instead.`)
      }
    } else {
      const cond = buildCondition(catalog, jp, shareFilter, selectParams)
      if (cond) {
        measureExpr = `100.0 * ${buildShareNumerator(shape, cond)} / NULLIF(${rawMeasureExpr}, 0)`
        measureFormat = "percent"
        // "Share of laureates: Gender is female" — the counted noun, then the part it is split by.
        measureLabelOut = `Share of ${lc(measure.label.replace(/^Number of /i, ""))}: ${plan.share.label}`
        measureUnit = undefined
      }
    }
  }

  // v0.2 per: "measure per <denominator>" — only when the denominator is reachable from the
  // measure's own table without fanning out its rows (same table, or reached by climbing many-to-
  // one edges only); otherwise dropped, noted in the subtitle. Wraps whatever `measureExpr`
  // currently is (post-share), so "share ... per ..." composes if both happen to be asked.
  if (plan.per) {
    const perMeasure = resolveMeasure(plan.per, catalog)
    if (reachedWithoutFanOut(catalog, measure.table, perMeasure.table)) {
      let perExpr = perMeasure.expr(jp)
      // An "n:<table>" measure (or an "m:" metric shaped the same way) always renders as a bare
      // `COUNT(*)`, which only counts the right thing when its declared table IS the query's own
      // base (t0) — used as a DIFFERENT table's denominator, a bare COUNT(*) counts THIS query's
      // joined rows instead, not that table's own rows. Scope it explicitly in that case.
      if (perMeasure.table !== measure.table && detectMeasureShape(perExpr).kind === "count_star") {
        const pk = catalogTable(catalog, perMeasure.table).columns.find((c) => c.role === "id")?.name ?? catalogTable(catalog, perMeasure.table).columns[0]!.name
        perExpr = `COUNT(DISTINCT ${qcol(jp.ensureTable(perMeasure.table), pk)})`
      }
      measureExpr = `1.0 * (${measureExpr}) / NULLIF((${perExpr}), 0)`
      measureLabelOut = `${measureLabelOut} per ${lc(perMeasure.label)}`
      measureFormat = undefined
      measureUnit = undefined
    } else {
      notes.push(`Couldn't safely divide by "${lc(perMeasure.label)}" here, so it was left out.`)
    }
  }

  const measureName = outputName(measure.outputName, used)
  selectCols.push(`${measureExpr} AS ${q(measureName)}`)
  resultCols.push({ name: measureName, label: measureLabelOut, kind: "amount", unit: measureUnit, format: measureFormat, source: measure.nullableColumn?.key })

  // `shareFallbackCond` first: its params were bound into `whereParams` before `buildWhere` ran.
  const whereClauses: string[] = shareFallbackCond ? [shareFallbackCond] : []
  whereClauses.push(...buildWhere(catalog, jp, plan.filters, whereParams))
  if (measure.nullableColumn) whereClauses.push(`${qcol(jp.ensureTable(measure.nullableColumn.table), measure.nullableColumn.name)} IS NOT NULL`)
  if (groupByRaw && groupByReachable && isBandKey(groupByRaw) && bandOrderExpr) {
    const col = catalogColumn(catalog, groupByReal!)
    whereClauses.push(`${qcol(jp.aliasOf(col.table) ?? jp.ensureTable(col.table), col.name)} IS NOT NULL`)
  }

  // top-N series cap when grouping AND breaking down over time on a high-cardinality dimension.
  // The dimension's own distinct-value count is what matters (e.g. 2 genders on a 1000-row
  // laureates table shouldn't cap), not the row count of the table it happens to live on. Bands are
  // inherently low-cardinality (at most 8), so they never need this.
  if (groupByRaw && groupByReachable && !isBandKey(groupByRaw) && plan.time) {
    const dimColForCap = catalogColumn(catalog, groupByRaw)
    const dimCardinality = dimColForCap.distinctCount ?? catalogTable(catalog, dimColForCap.table).rowCount
    if (dimCardinality > SERIES_CAP_SKIP_ROWS) {
      const dim = buildDimensionSelect(catalog, jp, groupByRaw, new Set())
      const rankExpr = dim.groupByExprs[0]!
      const subMeasure = measure.expr(jp)
      const subWhere = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : ""
      const rankSql = `${rankExpr} IN (SELECT ${rankExpr} FROM ${q(jp.baseTable)} t0 ${jp.clauses.join(" ")} ${subWhere} GROUP BY ${rankExpr} ORDER BY ${subMeasure} DESC LIMIT ${SERIES_CAP})`
      whereClauses.push(rankSql)
      // the subquery re-embeds the same "?" placeholders `whereClauses` already has — bind their
      // values again, right after (text order: this subquery sits after those clauses).
      whereParams.params.push(...whereParams.params)
    }
  }

  let sql = `SELECT ${selectCols.join(", ")} FROM ${q(jp.baseTable)} t0 ${jp.clauses.join(" ")}`
  if (whereClauses.length) sql += ` WHERE ${whereClauses.join(" AND ")}`

  const timeCalc = plan.timeCalc && plan.time ? plan.timeCalc : undefined
  // No GROUP BY (no group-by dimension, no time axis) means the aggregate functions already
  // collapse everything to exactly one row — an ORDER BY/LIMIT on that single row is pointless
  // (e.g. a plain "what's the world population right now" total). A timeCalc wrap always implies a
  // time axis (interpret.ts guarantees it), so it always reaches this branch.
  if (groupByExprs.length) {
    sql += ` GROUP BY ${groupByExprs.join(", ")}`
    // HAVING binds after every WHERE param (and after the series-cap subquery's re-bound copy).
    const havingClauses = buildHaving(plan.having, measureExpr, havingParams)
    if (havingClauses.length) sql += ` HAVING ${havingClauses.join(" AND ")}`
    if (!timeCalc) {
      // Bands always read low-to-high, like a histogram — their natural index order overrides
      // whichever ranking direction the plan otherwise defaulted to.
      const orderByExpr = bandOrderExpr ?? (plan.sort.by === "x" ? (timeOrderExpr ?? q(measureName)) : q(measureName))
      const orderByDir = bandOrderExpr ? "ASC" : plan.sort.dir.toUpperCase()
      sql += ` ORDER BY ${orderByExpr} ${orderByDir}`
      sql += ` LIMIT ${plan.limit}${offsetSql(plan)}`
    }
  }

  const params = [...selectParams.params, ...whereParams.params, ...havingParams.params]
  let title = buildTitle(catalog, plan, measureLabelOut, groupLabel, "aggregate", measure.nullableColumn)
  let finalResultCols = resultCols

  if (timeCalc && timeName) {
    // Wrap the aggregate (built above WITHOUT its own ORDER BY/LIMIT) as a CTE, adding the window-
    // function column; LIMIT/OFFSET apply outside, after the wrap.
    const seriesNames = resultCols.filter((c) => c.kind === "category" || c.kind === "geo_code").map((c) => c.name)
    const calcName = outputName(`${measureName}_${timeCalc}`, used)
    const wrapped = buildTimeCalcSql(sql, timeCalc, timeName, seriesNames, measureName, calcName)
    // A cut series keeps its MOST RECENT periods ("the % change last year" = the latest row, never
    // the first period, whose LAG is always empty), then reads oldest to newest again.
    sql = `SELECT * FROM (${wrapped.sql} DESC LIMIT ${plan.limit}${offsetSql(plan)}) ORDER BY ${q(timeName)}`
    const timeMeta = resultCols.find((c) => c.name === timeName)!
    const seriesMeta = resultCols.filter((c) => seriesNames.includes(c.name))
    const calcLabel = timeCalc === "change" ? "Change" : timeCalc === "pct_change" ? "% change" : "Running total"
    finalResultCols = [timeMeta, ...seriesMeta, { name: calcName, label: `${measureLabelOut} (${lc(calcLabel)})`, kind: "amount", format: wrapped.format ?? measureFormat, unit: wrapped.format ? undefined : measure.unit }]
    const period = plan.time!.grain === "decade" ? "decade" : plan.time!.grain === "month" ? "month" : plan.time!.grain === "quarter" ? "quarter" : plan.time!.grain === "day" ? "day" : "year"
    const calcTitle = timeCalc === "change" ? `Change in ${lc(measureLabelOut)} by ${period}` : timeCalc === "pct_change" ? `% change in ${lc(measureLabelOut)} by ${period}` : `Running total of ${lc(measureLabelOut)} by ${period}`
    title = groupLabel ? `${calcTitle}, split by ${lc(groupLabel)}` : calcTitle
  }

  const subtitle = [filterSubtitle(plan), ...notes].filter(Boolean).join(" · ") || undefined
  return { sql, params, title, subtitle, columns: finalResultCols }
}

function compileRelationship(
  plan: QueryPlan,
  catalog: Catalog,
  measure: MeasureInfo,
  jp: JoinPlanner,
  params: ParamList,
  used: Set<string>,
): CompiledQuery {
  // A relationship chart is naturally one dot per entity (country, laureate) — prefer the
  // dataset's default entity over an incidental group_by answer (e.g. "richer" nudging Jev
  // toward income_groups, which would collapse 200 countries into 4 points).
  const entityKey = relationshipEntity(catalog, measure.table) ?? plan.groupBy
  const selectCols: string[] = []
  const resultCols: ResultColumnMeta[] = []
  const groupByExprs: string[] = []

  if (entityKey) {
    const dim = buildDimensionSelect(catalog, jp, entityKey, used)
    for (const c of dim.columns) {
      selectCols.push(`${c.expr} AS ${q(c.outputName)}`)
      resultCols.push({ name: c.outputName, label: c.label, kind: c.kind, source: c.source })
    }
    groupByExprs.push(...dim.groupByExprs)
  }

  const m1Expr = measure.expr(jp)
  const m1Name = outputName(measure.outputName, used)
  selectCols.push(`${m1Expr} AS ${q(m1Name)}`)
  resultCols.push({ name: m1Name, label: measure.label, kind: "amount", unit: measure.unit, format: measure.format })

  const measure2 = resolveMeasure(plan.measure2!, catalog)
  const m2Expr = measure2.expr(jp)
  const m2Name = outputName(measure2.outputName, used)
  selectCols.push(`${m2Expr} AS ${q(m2Name)}`)
  resultCols.push({ name: m2Name, label: measure2.label, kind: "amount", unit: measure2.unit, format: measure2.format })

  // size = population, color = region, when the entity's table or the measure's own fact table carries them.
  const entityTable = entityKey ? catalogColumn(catalog, entityKey).table : measure.table
  const sizeCol = relationshipSize(catalog, entityTable, measure.table)
  if (sizeCol) {
    const n = outputName(sizeCol.label, used)
    selectCols.push(`${qcol(jp.ensureTable(sizeCol.table), sizeCol.name)} AS ${q(n)}`)
    resultCols.push({ name: n, label: sizeCol.label, kind: "amount", unit: sizeCol.unit, source: sizeCol.key })
  }
  const colorDim = findColorDimension(catalog, jp, entityTable)
  if (colorDim) {
    const n = outputName(colorDim.label, used)
    selectCols.push(`${colorDim.expr} AS ${q(n)}`)
    resultCols.push({ name: n, label: colorDim.label, kind: "category", source: colorDim.key })
  }

  const params2 = new ParamList()
  const whereClauses = buildWhere(catalog, jp, plan.filters, params2)
  params.params.push(...params2.params)
  if (measure.nullableColumn) whereClauses.push(`${qcol(jp.ensureTable(measure.nullableColumn.table), measure.nullableColumn.name)} IS NOT NULL`)
  if (measure2.nullableColumn) whereClauses.push(`${qcol(jp.ensureTable(measure2.nullableColumn.table), measure2.nullableColumn.name)} IS NOT NULL`)

  let sql = `SELECT ${selectCols.join(", ")} FROM ${q(jp.baseTable)} t0 ${jp.clauses.join(" ")}`
  if (whereClauses.length) sql += ` WHERE ${whereClauses.join(" AND ")}`
  if (groupByExprs.length) sql += ` GROUP BY ${groupByExprs.join(", ")}`
  sql += ` LIMIT ${plan.limit}`

  const subtitle = filterSubtitle(plan)
  return { sql, params: params.params, title: `${measure.label} vs ${measure2.label}`, subtitle, columns: resultCols }
}

/** The colour dimension for a relationship chart: the display name behind the FK column
 *  rules.ts names for the entity's table (see `relationshipColorFk`). */
function findColorDimension(catalog: Catalog, jp: JoinPlanner, entityTable: string): { expr: string; label: string; key: string } | undefined {
  const fk = relationshipColorFk(catalog, entityTable)
  if (!fk || !fk.fk) return undefined
  const refTable = catalogTable(catalog, fk.fk.split(".")[0]!)
  const disp = refTable.columns.find((c) => c.name === refTable.display)
  if (!disp) return undefined
  const { alias } = jp.ensureFkJoin(fk.key, { left: true })
  return { expr: qcol(alias, disp.name), label: disp.label, key: disp.key }
}

function compileDistribution(plan: QueryPlan, catalog: Catalog): CompiledQuery {
  if (!plan.measure) throw new Error("compilePlan: distribution plan has no measure")
  const measure = resolveMeasure(plan.measure, catalog)
  const jp = new JoinPlanner(catalog, measure.table)
  const params = new ParamList()
  const used = new Set<string>()

  const col = measure.nullableColumn
  const width = plan.binWidth ?? col?.binWidth ?? niceBinWidth(col?.min, col?.max)
  const alias = jp.ensureTable(measure.table)
  const colExpr = col ? qcol(alias, col.name) : measure.expr(jp)
  const isIntWidth = Number.isInteger(width)
  const binExpr = isIntWidth ? `(CAST(${colExpr} AS INTEGER) / ${width}) * ${width}` : `CAST(${colExpr} / ${width} AS INTEGER) * ${width}`
  const binName = outputName(`${measure.outputName}_bin`, used)
  const countName = outputName("count", used)

  const whereClauses = buildWhere(catalog, jp, plan.filters, params)
  if (col) whereClauses.push(`${colExpr} IS NOT NULL`)

  let sql = `SELECT ${binExpr} AS ${q(binName)}, COUNT(*) AS ${q(countName)} FROM ${q(jp.baseTable)} t0 ${jp.clauses.join(" ")}`
  if (whereClauses.length) sql += ` WHERE ${whereClauses.join(" AND ")}`
  sql += ` GROUP BY ${q(binName)} ORDER BY ${q(binName)}`
  sql += ` LIMIT ${plan.limit}`

  const resultCols: ResultColumnMeta[] = [
    { name: binName, label: measure.label, kind: "amount", unit: measure.unit, source: col?.key },
    { name: countName, label: "Count", kind: "amount", format: "number" },
  ]
  const subtitle = filterSubtitle(plan)
  return { sql, params: params.params, title: buildTitle(catalog, plan, measure.label, undefined, "distribution"), subtitle, columns: resultCols }
}

function niceBinWidth(min?: number, max?: number): number {
  if (min === undefined || max === undefined || max <= min) return 1
  const range = max - min
  const raw = range / 12
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  return nice * mag
}

function compileRows(plan: QueryPlan, catalog: Catalog): CompiledQuery {
  if (!plan.rowTable) throw new Error("compilePlan: rows plan has no rowTable")
  const table = catalogTable(catalog, plan.rowTable)
  const jp = new JoinPlanner(catalog, table.name)
  const params = new ParamList()
  const used = new Set<string>()

  const selectCols: string[] = []
  const resultCols: ResultColumnMeta[] = []
  const pick = pickRowColumns(table)
  for (const col of pick) {
    if (col.role === "fk" && col.fk) {
      const { alias: dispAlias, table: dispTable } = jp.ensureFkJoin(col.key, { left: true })
      const dt = catalogTable(catalog, dispTable)
      const dispCol = dt.columns.find((c) => c.name === dt.display) ?? dt.columns.find((c) => c.role === "dimension" || c.role === "label")
      if (dispCol) {
        const n = outputName(col.label, used)
        selectCols.push(`${qcol(dispAlias, dispCol.name)} AS ${q(n)}`)
        resultCols.push({ name: n, label: col.label, kind: "category", source: dispCol.key })
        continue
      }
    }
    if (col.role === "geo_code" && col.fk) {
      const alias = jp.ensureTable(col.table)
      const n = outputName(col.label, used)
      selectCols.push(`${qcol(alias, col.name)} AS ${q(n)}`)
      resultCols.push({ name: n, label: col.label, kind: "geo_code", source: col.key })
      const { alias: dispAlias, table: dispTable } = jp.ensureFkJoin(col.key, { left: true })
      const dt = catalogTable(catalog, dispTable)
      const dispCol = dt.columns.find((c) => c.name === dt.display)
      if (dispCol) {
        const dn = outputName(dispCol.label, used)
        selectCols.push(`${qcol(dispAlias, dispCol.name)} AS ${q(dn)}`)
        resultCols.push({ name: dn, label: dispCol.label, kind: "category", source: dispCol.key })
      }
      continue
    }
    const alias = jp.ensureTable(col.table)
    const n = outputName(col.label, used)
    selectCols.push(`${qcol(alias, col.name)} AS ${q(n)}`)
    resultCols.push({ name: n, label: col.label, kind: kindOf(col), unit: col.unit, format: toResultFormat(col.format), source: col.key })
  }

  const whereClauses = buildWhere(catalog, jp, plan.filters, params)

  let orderByExpr = `${jp.aliasOf(table.name)}.${q(table.columns[0]!.name)}`
  if (plan.sort.column) {
    const sortCol = catalogColumn(catalog, plan.sort.column)
    orderByExpr = qcol(jp.ensureTable(sortCol.table), sortCol.name)
  }

  let sql = `SELECT ${selectCols.join(", ")} FROM ${q(jp.baseTable)} t0 ${jp.clauses.join(" ")}`
  if (whereClauses.length) sql += ` WHERE ${whereClauses.join(" AND ")}`
  sql += ` ORDER BY ${orderByExpr} ${plan.sort.dir.toUpperCase()}`
  sql += ` LIMIT ${plan.limit}${offsetSql(plan)}`

  const subtitle = filterSubtitle(plan)
  return { sql, params: params.params, title: table.label, subtitle, columns: resultCols }
}

/**
 * Columns picked for a `rows` answer when the table has no curated `CatalogTable.listColumns`:
 * the display label, every FK column (each resolves below to its referenced table's display
 * name — home/away club, venue...), exactly one time-ish column (a real date beats a year column
 * beats a decade — never both a year AND its own decade), up to 3 key measures, then geo/lat/lon
 * (so a table with coordinates keeps them within the cap and can still become a point map), then
 * any other dimension/label column — skipping a `<x>_number` column when a `<x>_name` sibling is
 * also being shown (e.g. AFL's `round_number` next to `round_name`). Never an id, a hidden/text/url
 * column, or a flag.
 */
function heuristicListColumns(table: { columns: CatalogColumn[]; display?: string }): CatalogColumn[] {
  const usable = table.columns.filter((c) => c.role !== "id" && c.role !== "hidden" && c.role !== "text" && c.role !== "url" && c.role !== "flag")
  const out: CatalogColumn[] = []
  const used = new Set<string>()
  const add = (c: CatalogColumn | undefined) => {
    if (c && !used.has(c.key)) {
      out.push(c)
      used.add(c.key)
    }
  }

  add(usable.find((c) => c.name === table.display))
  for (const c of usable) if (c.role === "fk") add(c)

  const dateCol = usable.find((c) => c.role === "date")
  const yearCol = usable.find((c) => c.role === "time" && c.grain !== "decade")
  const decadeCol = usable.find((c) => c.role === "time" && c.grain === "decade")
  add(dateCol ?? yearCol ?? decadeCol)

  let measureCount = 0
  for (const c of usable) {
    if (c.role !== "measure" || measureCount >= 3) continue
    add(c)
    measureCount++
  }

  for (const c of usable) if (c.role === "geo_code" || c.role === "latitude" || c.role === "longitude") add(c)

  const remaining = usable.filter((c) => !used.has(c.key) && (c.role === "dimension" || c.role === "label"))
  const suffixSkip = new Set<string>()
  for (const c of remaining) {
    const m = /^(.*)_number$/.exec(c.name)
    if (m && remaining.some((o) => o.name === `${m[1]}_name`)) suffixSkip.add(c.key)
  }
  for (const c of remaining) if (!suffixSkip.has(c.key)) add(c)

  return out.slice(0, 8)
}

/** `CatalogTable.listColumns` (curated column NAMES, in order) when the semantic layer set one for
 *  this table, else the heuristic above. A name that doesn't match any column (a stale/typo'd
 *  curated list) is silently dropped rather than crashing; an empty result after that falls back
 *  to the heuristic too, so a bad curated list never empties a rows answer. */
function pickRowColumns(table: CatalogTable): CatalogColumn[] {
  if (table.listColumns?.length) {
    const byName = new Map(table.columns.map((c) => [c.name, c]))
    const picked = table.listColumns.map((n) => byName.get(n)).filter((c): c is CatalogColumn => !!c)
    // Coordinates always ride along (outside the curated cap): they are what lets a list of
    // records become a points map ("Where were physics laureates born?").
    const coords = table.columns.filter((c) => (c.role === "latitude" || c.role === "longitude") && !picked.includes(c))
    if (picked.length) return [...picked.slice(0, 8), ...coords]
  }
  return heuristicListColumns(table)
}

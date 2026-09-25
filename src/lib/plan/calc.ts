/**
 * OWNER: implementer B (calculations). Pure SQL-fragment builders for the v0.2 calculation
 * features: share (conditional aggregation), the fan-out safety check `per` needs, bands (CASE
 * WHEN over bound edges) and cyclical time grains (strftime), plus the window-function wrapping for
 * time calculations (LAG / running total) and the "b:" band-key helpers every groupBy reader must
 * handle. compile.ts decides WHICH clause each fragment lands in (and therefore which `ParamList`
 * its bound values belong to — see compile.ts's header comment on parameter ordering); this file
 * only ever emits SQL text and, where a fragment needs one, binds through the `ParamList` its
 * caller hands it. Code constants (band labels, weekday/month names) are inlined with `sqlLiteral`,
 * never bound — only values that came from the question are.
 */
import type { Catalog, CatalogColumn, TimeCalc, TimeGrain } from "@shared/contract"
import { buildJoinGraph } from "./graph"
import { type ParamList, q, sqlLiteral } from "./sql"

// ─────────────────────────────── "b:" band groupBy keys ───────────────────────────────

const BAND_PREFIX = "b:"

/** A dimension option key request.ts minted for a binnable measure column ("b:table.col"). */
export function isBandKey(key: string): boolean {
  return key.startsWith(BAND_PREFIX)
}

/** The real catalog column key behind a groupBy key, stripping the "b:" band prefix when present.
 *  Every place that reads `plan.groupBy` / `answers.groupBy.value` as a plain column key must go
 *  through this first — a band key is not itself a column in the catalog. */
export function groupByColumnKey(key: string): string {
  return isBandKey(key) ? key.slice(BAND_PREFIX.length) : key
}

// ─────────────────────────────── share: measure shape ───────────────────────────────

export type MeasureShape = { kind: "count_star" } | { kind: "sum"; inner: string } | { kind: "count_distinct"; inner: string } | { kind: "other" }

/** Recognises the SQL SHAPE of an already-built measure expression — a plain `COUNT(*)`, `SUM(x)`
 *  or `COUNT(DISTINCT x)` — regardless of whether it came from a "c:" column measure or a curated
 *  "m:" metric's own SQL (both render to the same three shapes when that's what they are). Anything
 *  else (AVG, MIN, MAX, weighted_avg, or a metric with a more complex expression) is "other" — the
 *  caller falls the share back to a plain include filter for those.
 */
export function detectMeasureShape(expr: string): MeasureShape {
  const t = expr.trim()
  if (/^COUNT\(\s*\*\s*\)$/i.test(t)) return { kind: "count_star" }
  const sum = /^SUM\((.+)\)$/i.exec(t)
  if (sum) return { kind: "sum", inner: sum[1]! }
  const cd = /^COUNT\(\s*DISTINCT\s+(.+)\)$/i.exec(t)
  if (cd) return { kind: "count_distinct", inner: cd[1]! }
  return { kind: "other" }
}

/** The numerator of a share percentage for a recognised measure shape: the same aggregate function,
 *  applied only to rows matching `cond` (already a bound SQL condition — see where.ts's
 *  `buildCondition`). Never called with shape "other" (the caller falls that case back to a filter
 *  before reaching here). */
export function buildShareNumerator(shape: Exclude<MeasureShape, { kind: "other" }>, cond: string): string {
  if (shape.kind === "count_star") return `COUNT(CASE WHEN ${cond} THEN 1 END)`
  if (shape.kind === "sum") return `SUM(CASE WHEN ${cond} THEN ${shape.inner} END)`
  return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${shape.inner} END)`
}

// ─────────────────────────────── per: fan-out safety ───────────────────────────────

/** Whether every row of `fromTable` maps to at most one row of `toTable` — the same table, or
 *  reached by climbing ONLY many-to-one edges (never fanning out through a one-to-many hop). Gates
 *  `per`'s denominator: a denominator reached any other way would multiply the numerator's rows
 *  (double-counting) and silently corrupt the ratio, so `per` is dropped instead. */
export function reachedWithoutFanOut(catalog: Catalog, fromTable: string, toTable: string): boolean {
  if (fromTable === toTable) return true
  const graph = buildJoinGraph(catalog)
  const seen = new Set([fromTable])
  const queue = [fromTable]
  let head = 0
  while (head < queue.length) {
    const t = queue[head++]!
    for (const edge of graph.get(t) ?? []) {
      if (!edge.ascending) continue
      if (edge.toTable === toTable) return true
      if (!seen.has(edge.toTable)) {
        seen.add(edge.toTable)
        queue.push(edge.toTable)
      }
    }
  }
  return false
}

// ─────────────────────────────── bands ───────────────────────────────

/** Nice band width for a [min, max] range: at most 8 bands, from a "1/2/5 × 10^n" step. */
function niceBandWidth(min: number, max: number): number {
  if (max <= min) return 1
  const raw = (max - min) / 8
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  return nice * mag
}

/**
 * Numeric band edges: numbers found in the question that fall strictly inside (min, max), sorted
 * and deduplicated, when there are any — otherwise code-picked "nice" edges (at most 8 bands, so at
 * most 7 edges) from the column's own `binWidth`, or a nice width derived from its range.
 */
export function pickBandEdges(min: number, max: number, binWidth: number | undefined, questionNumbers: number[]): number[] {
  const inRange = [...new Set(questionNumbers.filter((n) => Number.isFinite(n) && n > min && n < max))].sort((a, b) => a - b)
  if (inRange.length) return inRange
  // A curated histogram width can be far too fine for bands (5-year steps over 80 years would pile
  // most rows into the last "N+" band): widen to a nice width whenever it would need more than 8.
  let width = binWidth && binWidth > 0 ? binWidth : niceBandWidth(min, max)
  if ((max - min) / width > 8) width = niceBandWidth(min, max)
  const edges: number[] = []
  let v = Math.ceil(min / width) * width
  if (v <= min) v += width
  while (v < max && edges.length < 7) {
    edges.push(Math.round(v * 1e6) / 1e6)
    v += width
  }
  return edges
}

const formatBandNumber = (n: number, format: CatalogColumn["format"] | undefined): string => {
  const rounded = Number.isInteger(n) ? n : Math.round(n * 100) / 100
  const base = rounded.toLocaleString("en-US")
  if (format === "percent") return `${base}%`
  if (format === "currency" || format === "currency_compact") return `$${base}`
  return base
}

/** "< 30", "30–49", "50+" style band labels — integer-stepped data gets an exclusive upper bound
 *  (edge - 1) in the middle bands so consecutive bands read as a clean partition. */
function bandLabel(edges: number[], idx: number, format: CatalogColumn["format"] | undefined): string {
  const allInt = edges.every(Number.isInteger)
  const fmt = (n: number) => formatBandNumber(n, format)
  if (idx === 0) return `< ${fmt(edges[0]!)}`
  if (idx === edges.length) return `${fmt(edges[edges.length - 1]!)}+`
  const lo = edges[idx - 1]!
  const hiRaw = edges[idx]!
  return `${fmt(lo)}–${fmt(allInt ? hiRaw - 1 : hiRaw)}`
}

export interface BandColumn {
  /** the band CASE WHEN, aliased as `outputName` by the caller */
  caseExpr: string
  /** ORDER BY expression that sorts bands by their index, not alphabetically — compares the
   *  SELECT alias against the (code-constant, unbound) label literals, so it needs no fresh params
   *  and can be reused verbatim after GROUP BY collapses the rows. */
  orderExpr: string
  labels: string[]
}

/** The band CASE WHEN (edges bound as `?` params — they came from the question or a nice-width
 *  calculation, never a literal) and its labels (code constants, inlined via `sqlLiteral`, never
 *  bound). `colExpr` is the already-aliased column reference (`t0."age"`); `outputName` is the
 *  SELECT alias the caller will give this column (needed to build `orderExpr`). */
export function buildBandColumn(format: CatalogColumn["format"] | undefined, colExpr: string, edges: number[], outputName: string, params: ParamList): BandColumn {
  const labels = Array.from({ length: edges.length + 1 }, (_, i) => bandLabel(edges, i, format))
  const whens = edges.map((e, i) => `WHEN ${colExpr} < ${params.bind(e)} THEN ${sqlLiteral(labels[i]!)}`).join(" ")
  const caseExpr = `(CASE ${whens} ELSE ${sqlLiteral(labels[labels.length - 1]!)} END)`
  const orderWhens = labels
    .slice(0, -1)
    .map((l, i) => `WHEN ${sqlLiteral(l)} THEN ${i}`)
    .join(" ")
  const orderExpr = `(CASE ${q(outputName)} ${orderWhens} ELSE ${labels.length - 1} END)`
  return { caseExpr, orderExpr, labels }
}

// ─────────────────────────────── cyclical time grains ───────────────────────────────

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export interface CyclicalSelect {
  expr: string
  /** natural (not alphabetical) order: the raw strftime part — '0'..'6' / '01'..'12' already sort
   *  correctly as text, and it carries no bound params, so it's safe to repeat verbatim. */
  orderExpr: string
}

/** A cyclical time grain (weekday / month_of_year / hour): folds every period onto one cycle —
 *  `compile.ts` gives the result column kind "category", not "time". Grain wording (weekday/month
 *  names, "%w"/"%m"/"%H") is fixed vocabulary, never a dataset noun. */
export function cyclicalTimeSelect(grain: Extract<TimeGrain, "weekday" | "month_of_year" | "hour">, colExpr: string): CyclicalSelect {
  if (grain === "weekday") {
    const part = `strftime('%w', ${colExpr})`
    const whens = WEEKDAY_LABELS.map((l, i) => `WHEN ${sqlLiteral(String(i))} THEN ${sqlLiteral(l)}`).join(" ")
    return { expr: `(CASE ${part} ${whens} END)`, orderExpr: part }
  }
  if (grain === "month_of_year") {
    const part = `strftime('%m', ${colExpr})`
    const whens = MONTH_LABELS.map((l, i) => `WHEN ${sqlLiteral(String(i + 1).padStart(2, "0"))} THEN ${sqlLiteral(l)}`).join(" ")
    return { expr: `(CASE ${part} ${whens} END)`, orderExpr: part }
  }
  const part = `strftime('%H', ${colExpr})`
  return { expr: part, orderExpr: part }
}

/** "day of week" / "month of year" / "hour of day" — fixed wording for cyclical-grain titles,
 *  never a dataset noun. */
export function cyclicalGrainWords(grain: Extract<TimeGrain, "weekday" | "month_of_year" | "hour">): string {
  return grain === "weekday" ? "day of week" : grain === "month_of_year" ? "month of year" : "hour of day"
}

// ─────────────────────────────── time calculations (window functions) ───────────────────────────────

export interface TimeCalcWrap {
  sql: string
  format?: "percent"
}

/**
 * Wraps a grouped aggregate (`innerSql`, built WITHOUT its own ORDER BY/LIMIT) as `WITH base AS
 * (...)`, adding the window-function column for change / % change / running total, partitioned by
 * the series columns (0+ groupBy dimension columns selected alongside the time axis) and ordered by
 * the time column. Output columns: time, series (if any), then only the calc'd column — never the
 * raw total too, so a chart stays one amount (line/area). The caller applies LIMIT/OFFSET outside
 * (after this wrapping), and already bound every WHERE/HAVING param inside `innerSql` in text order
 * — this wrapper introduces no new bound params (window frames and NULLIF take no values).
 */
export function buildTimeCalcSql(innerSql: string, calc: Exclude<TimeCalc, "none">, timeCol: string, seriesCols: string[], measureCol: string, outName: string): TimeCalcWrap {
  const partition = seriesCols.length ? `PARTITION BY ${seriesCols.map((c) => q(c)).join(", ")} ` : ""
  const w = `(${partition}ORDER BY ${q(timeCol)})`
  const v = q(measureCol)
  let expr: string
  let format: "percent" | undefined
  if (calc === "change") {
    expr = `${v} - LAG(${v}) OVER ${w}`
  } else if (calc === "pct_change") {
    expr = `100.0 * (${v} - LAG(${v}) OVER ${w}) / NULLIF(LAG(${v}) OVER ${w}, 0)`
    format = "percent"
  } else {
    expr = `SUM(${v}) OVER (${partition}ORDER BY ${q(timeCol)} ROWS UNBOUNDED PRECEDING)`
  }
  const cols = [q(timeCol), ...seriesCols.map((c) => q(c)), `${expr} AS ${q(outName)}`].join(", ")
  const sql = `WITH base AS (${innerSql}) SELECT ${cols} FROM base ORDER BY ${q(timeCol)}`
  return { sql, format }
}

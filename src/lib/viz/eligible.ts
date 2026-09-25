/**
 * OWNER: charts. Hard rules: which chart types can honestly show a given result. `table` is
 * always eligible. This is the gate offline.ts ranks within and decideChart sends to Jev — Jev
 * only ever picks among what this function returns.
 */
import type { ChartType, ResultProfile } from "@shared/contract"
import { ALL_TYPES, gridSize, groupColumns, isNonNegative, pickChannels } from "./helpers"

const MAX_HEATMAP_SIDE = 40

export function eligibleCharts(profile: ResultProfile): ChartType[] {
  const g = groupColumns(profile)
  const { x, series, amounts } = pickChannels(profile)
  const rows = profile.rowCount
  const out = new Set<ChartType>(["table"])

  // kpi: one row, 1-2 amounts (a time column may ride along for "as of <year>" context) — or
  // exactly two rows across a single time column with one amount, e.g. "population in 1986 vs
  // 2025": a latest-vs-earlier comparison is still honestly a KPI, just with two numbers to pick
  // the endpoints from instead of one.
  // A single RECORD (several named fields, e.g. a season with premiers and runner-up) is a table,
  // not a number: only offer kpi when at most one category column rides along.
  if (rows === 1 && amounts.length >= 1 && amounts.length <= 2 && g.category.length <= 1) out.add("kpi")
  if (rows === 2 && g.dims.length === 1 && g.time.length === 1 && amounts.length === 1) out.add("kpi")

  // bar: a single category-or-time axis, capped so labels stay legible; exactly one amount.
  if (g.dims.length === 1 && amounts.length === 1 && (x?.distinct ?? 0) <= 24) out.add("bar")

  // hbar: ranked categories, more headroom for row count and long names.
  if (g.dims.length === 1 && g.category.length === 1 && amounts.length === 1 && rows <= 50) out.add("hbar")

  // line / area: an ordered time axis with enough points to show a trend, one amount.
  if (g.dims.length === 1 && g.time.length === 1 && amounts.length === 1 && (x?.distinct ?? 0) >= 3) {
    out.add("line")
    out.add("area")
  }

  // multi_line: time x plus a category series with a sane number of lines (2-12).
  if (
    g.time.length === 1 &&
    g.category.length === 1 &&
    g.dims.length === 2 &&
    amounts.length === 1 &&
    series &&
    series.distinct >= 2 &&
    series.distinct <= 12
  ) {
    out.add("multi_line")
  }

  // stacked_bar / grouped_bar: two dims (x + series), series folds past 8, additive for stacking.
  if (
    g.dims.length === 2 &&
    amounts.length === 1 &&
    (x?.distinct ?? 0) <= 24 &&
    series &&
    series.distinct <= 8
  ) {
    out.add("grouped_bar")
    if (isNonNegative(amounts[0])) out.add("stacked_bar")
  }

  // donut: a small part-of-a-whole, non-negative so slices sum honestly.
  if (g.category.length === 1 && g.time.length === 0 && amounts.length === 1 && rows <= 8 && isNonNegative(amounts[0])) {
    out.add("donut")
  }

  // scatter / bubble: two or three amounts, enough points for a relationship to show.
  if (amounts.length >= 2 && rows >= 5) out.add("scatter")
  if (amounts.length >= 3 && rows >= 5) out.add("bubble")

  // histogram: either already binned (a label/bin dim + counts) or one raw amount to bin client-side.
  const looksBinned = g.dims.length <= 1 && amounts.length >= 1 && amounts.length <= 2 && rows >= 4
  const looksRaw = amounts.length === 1 && g.dims.length === 0 && rows > 20
  if (looksBinned || looksRaw) out.add("histogram")

  // heatmap: two dims crossed, one amount, grid small enough to read.
  const grid = gridSize(profile)
  if (g.dims.length === 2 && amounts.length === 1 && grid.rows <= MAX_HEATMAP_SIDE && grid.cols <= MAX_HEATMAP_SIDE) {
    out.add("heatmap")
  }

  // choropleth: an ISO3 column plus something to shade it by, one row per country (a list of
  // records that merely carry a country code, e.g. laureates, is a points map or a table).
  const geoCol = g.geo[0]
  if (g.geo.length === 1 && amounts.length >= 1 && geoCol && geoCol.distinct >= rows * 0.9) out.add("choropleth")

  // point_map: paired coordinates.
  if (g.lat.length === 1 && g.lon.length === 1) out.add("point_map")

  return ALL_TYPES.filter((t) => out.has(t))
}

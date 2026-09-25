/**
 * OWNER: charts. Shared, internal helpers over a ResultProfile: grouping columns by kind and
 * picking the x / series / amount channels the same way in eligibleCharts and encodeChart, so the
 * two never disagree about what a result "looks like".
 */
import type { ChartType, ProfiledColumn, ResultProfile } from "@shared/contract"

export interface ColumnGroups {
  time: ProfiledColumn[]
  category: ProfiledColumn[]
  amount: ProfiledColumn[]
  geo: ProfiledColumn[]
  lat: ProfiledColumn[]
  lon: ProfiledColumn[]
  text: ProfiledColumn[]
  id: ProfiledColumn[]
  /** time + category, in that order: the columns that can serve as a discrete/ordered axis */
  dims: ProfiledColumn[]
}

export function groupColumns(profile: ResultProfile): ColumnGroups {
  const time = profile.columns.filter((c) => c.kind === "time")
  const category = profile.columns.filter((c) => c.kind === "category")
  const amount = profile.columns.filter((c) => c.kind === "amount")
  const geo = profile.columns.filter((c) => c.kind === "geo_code")
  const lat = profile.columns.filter((c) => c.kind === "latitude")
  const lon = profile.columns.filter((c) => c.kind === "longitude")
  const text = profile.columns.filter((c) => c.kind === "text")
  const id = profile.columns.filter((c) => c.kind === "id")
  return { time, category, amount, geo, lat, lon, text, id, dims: [...time, ...category] }
}

/** True when every non-null value of an amount column is >= 0 (donut/stacked additivity). */
export function isNonNegative(col: ProfiledColumn | undefined): boolean {
  if (!col) return false
  return col.min === undefined || col.min >= 0
}

export interface Channels {
  /** primary "dims axis" column (time outranks category) — bar/hbar/line/area/donut/histogram */
  x?: ProfiledColumn
  /** secondary dims-axis column — multi_line/stacked_bar/grouped_bar/heatmap */
  series?: ProfiledColumn
  /** the lone category column, standalone (never consumed as an axis) — scatter/bubble hue */
  color?: ProfiledColumn
  amounts: ProfiledColumn[]
  geo?: ProfiledColumn
  lat?: ProfiledColumn
  lon?: ProfiledColumn
  /** best column to name a point/row by — a text column, else a spare category */
  label?: ProfiledColumn
}

/**
 * Deterministic channel assignment shared by every chart type: time outranks category as the x
 * axis (it has a natural order); a second dim becomes the series. `color` is the first category
 * column on its own — used by scatter/bubble, which take x/y from `amounts` instead of the dims
 * axis, so their category never gets "consumed" as x the way it would for bar/line/heatmap.
 */
export function pickChannels(profile: ResultProfile): Channels {
  const g = groupColumns(profile)
  const x = g.time[0] ?? g.category[0]
  const series = g.time.length ? g.category[0] : g.category[1]
  const color = g.category[0]
  const label = g.text[0] ?? g.category.find((c) => c !== x && c !== series)
  return {
    x,
    series,
    color,
    amounts: g.amount,
    geo: g.geo[0],
    lat: g.lat[0],
    lon: g.lon[0],
    label,
  }
}

/** Grid size for a two-dim x-amount encoding (heatmap's <= 40x40 cap). */
export function gridSize(profile: ResultProfile): { rows: number; cols: number } {
  const g = groupColumns(profile)
  const [a, b] = g.dims
  return { rows: a?.distinct ?? 0, cols: b?.distinct ?? 0 }
}

/** Chart types this module can encode; used to keep eligibleCharts and encodeChart in lockstep. */
export const ALL_TYPES: readonly ChartType[] = [
  "kpi",
  "bar",
  "hbar",
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
]

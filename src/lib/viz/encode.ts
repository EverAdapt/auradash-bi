/**
 * OWNER: charts. Deterministic channel mapping: given a chart type and a profile, decide which
 * result columns ride which visual channel (x / y / series / size / color / geo / lat / lon /
 * label). Pure data — renderers never re-query, they just read the ChartSpec this produces.
 */
import type { ChartSpec, ChartType, ProfiledColumn, ResultProfile } from "@shared/contract"
import { pickChannels } from "./helpers"

/** x spans > 2 orders of magnitude and stays positive — the log-scale trigger. */
function wantsLog(col: ProfiledColumn | undefined): boolean {
  if (!col || col.min === undefined || col.max === undefined || col.min <= 0) return false
  return col.max / col.min > 100
}

function isPercent(...cols: (ProfiledColumn | undefined)[]): boolean {
  return cols.some((c) => c?.unit === "%")
}

export function encodeChart(type: ChartType, profile: ResultProfile): ChartSpec {
  const { x, series, color, amounts, geo, lat, lon, label } = pickChannels(profile)

  switch (type) {
    case "kpi":
      // A time column (when present) rides along unused as `x`, purely for "as of <year>" context.
      return { type, x: x?.name, y: amounts.slice(0, 2).map((c) => c.name), percent: isPercent(amounts[0]) }

    case "bar":
    case "hbar":
      return { type, x: x?.name, y: amounts[0] ? [amounts[0].name] : [], percent: isPercent(amounts[0]) }

    case "line":
    case "area":
      return { type, x: x?.name, y: amounts[0] ? [amounts[0].name] : [], percent: isPercent(amounts[0]) }

    case "multi_line":
    case "stacked_bar":
    case "grouped_bar":
      return {
        type,
        x: x?.name,
        series: series?.name,
        y: amounts[0] ? [amounts[0].name] : [],
        percent: isPercent(amounts[0]),
      }

    case "donut":
      return { type, x: x?.name, y: amounts[0] ? [amounts[0].name] : [], percent: isPercent(amounts[0]) }

    case "scatter": {
      // Two-or-more amounts plot amount-vs-amount; a single amount falls back to the dims axis
      // (usually time) as x — a "how has this changed per item" strip plot.
      const usesAmountX = amounts.length >= 2
      const xCol = usesAmountX ? amounts[0] : (x ?? amounts[0])
      const yCol = usesAmountX ? amounts[1] : amounts[0]
      return {
        type,
        x: xCol?.name,
        y: yCol ? [yCol.name] : [],
        color: color?.name,
        label: label?.name,
        logX: usesAmountX ? wantsLog(xCol) : false,
      }
    }

    case "bubble": {
      const usesAmountX = amounts.length >= 2
      const xCol = usesAmountX ? amounts[0] : (x ?? amounts[0])
      const yCol = usesAmountX ? amounts[1] : amounts[0]
      const sizeCol = amounts.length >= 3 ? amounts[2] : undefined
      return {
        type,
        x: xCol?.name,
        y: yCol ? [yCol.name] : [],
        size: sizeCol?.name,
        color: color?.name,
        label: label?.name,
        logX: usesAmountX ? wantsLog(xCol) : false,
      }
    }

    case "histogram": {
      // Pre-binned data has a label/bin dim plus a count amount; a raw single amount is binned by
      // the renderer itself, so both `x` and `y` may point at amount columns.
      const binCol = x ?? amounts[0]
      const countCol = amounts.find((c) => c !== binCol) ?? amounts[0]
      return { type, x: binCol?.name, y: countCol ? [countCol.name] : [] }
    }

    case "heatmap":
      return { type, x: x?.name, series: series?.name, y: amounts[0] ? [amounts[0].name] : [] }

    case "choropleth":
      return { type, geo: geo?.name, y: amounts[0] ? [amounts[0].name] : [], label: label?.name, percent: isPercent(amounts[0]) }

    case "point_map":
      return { type, lat: lat?.name, lon: lon?.name, size: amounts[0]?.name, label: label?.name }

    case "table":
      return { type }
  }
}

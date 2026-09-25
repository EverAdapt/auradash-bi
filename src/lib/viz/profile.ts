/**
 * OWNER: charts. Turns a raw ResultSet into a ResultProfile: one ColumnKind per column plus
 * distinct/null/min/max, so eligibleCharts and encodeChart never touch raw cells again.
 *
 * `columns` (from a CompiledQuery, i.e. catalog-derived) always wins when given. Inference is the
 * fallback used when there is no catalog behind a result — e.g. the chart gallery, which profiles
 * fixtures with no metadata on purpose, to prove the inference rules hold on real data.
 */
import type { Cell, ColumnKind, ProfiledColumn, ResultColumnMeta, ResultProfile, ResultSet } from "@shared/contract"
import { humanizeLabel } from "./format"

const YEAR_MIN = 1800
const YEAR_MAX = 2100
const GEO_CODE_RE = /^[A-Z]{3}$/
const ID_NAME_RE = /(^id$|_id$)/i
const LAT_NAME_RE = /^lat(itude)?$/i
const LON_NAME_RE = /^lon(gitude)?$|^lng$/i

function isNumber(v: Cell): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/** Column-level stats used both by inference and by the returned ProfiledColumn. */
interface ColumnStats {
  values: Cell[]
  nonNull: Cell[]
  distinct: number
  nulls: number
  min?: number
  max?: number
  allNumeric: boolean
  allInteger: boolean
}

function statsFor(values: Cell[]): ColumnStats {
  const nonNull = values.filter((v) => v !== null)
  const distinctSet = new Set(values)
  const numbers = nonNull.filter(isNumber)
  const allNumeric = nonNull.length > 0 && numbers.length === nonNull.length
  const allInteger = allNumeric && numbers.every((n) => Number.isInteger(n))
  return {
    values,
    nonNull,
    distinct: distinctSet.size,
    nulls: values.length - nonNull.length,
    min: numbers.length ? Math.min(...numbers) : undefined,
    max: numbers.length ? Math.max(...numbers) : undefined,
    allNumeric,
    allInteger,
  }
}

/** Infer a ColumnKind purely from the column's name and its values (no catalog available). */
function inferKind(name: string, stats: ColumnStats): ColumnKind {
  const lower = name.toLowerCase()

  // time: named year/decade, or an integer column that plausibly holds calendar years.
  if (stats.allInteger) {
    if (lower === "year" || lower === "decade") return "time"
    if (
      stats.min !== undefined &&
      stats.max !== undefined &&
      stats.min >= YEAR_MIN &&
      stats.max <= YEAR_MAX &&
      stats.distinct >= 3
    ) {
      return "time"
    }
  }

  // latitude / longitude: named lat(itude)/lon(gitude)/lng and numeric in range.
  if (stats.allNumeric && stats.min !== undefined && stats.max !== undefined) {
    if (LAT_NAME_RE.test(lower) && stats.min >= -90 && stats.max <= 90) return "latitude"
    if (LON_NAME_RE.test(lower) && stats.min >= -180 && stats.max <= 180) return "longitude"
  }

  // geo_code: text where most non-null values look like an ISO3 code.
  if (!stats.allNumeric && stats.nonNull.length > 0) {
    const hits = stats.nonNull.filter((v) => typeof v === "string" && GEO_CODE_RE.test(v)).length
    if (hits / stats.nonNull.length >= 0.8) return "geo_code"
  }

  // id: surrogate/primary keys never become a measure, whatever their storage type.
  if (ID_NAME_RE.test(lower)) return "id"

  // amount: whatever numeric is left.
  if (stats.allNumeric) return "amount"

  // category vs text: cardinality decides.
  if (stats.distinct <= 60) return "category"
  return "text"
}

/** Profile a result; `columns` (from CompiledQuery) wins over inference when given. */
export function profileResult(result: ResultSet, columns?: ResultColumnMeta[]): ResultProfile {
  const profiled: ProfiledColumn[] = result.columns.map((name, i) => {
    const values = result.rows.map((r) => r[i])
    const stats = statsFor(values)
    const meta = columns?.[i]
    const kind: ColumnKind = meta?.kind ?? inferKind(name, stats)
    return {
      name,
      label: meta?.label ?? humanizeLabel(name),
      kind,
      unit: meta?.unit,
      format: meta?.format,
      source: meta?.source,
      distinct: stats.distinct,
      nulls: stats.nulls,
      min: stats.min,
      max: stats.max,
    }
  })

  return {
    rowCount: result.rows.length,
    truncated: result.truncated,
    columns: profiled,
    firstRows: result.rows.slice(0, 8),
  }
}

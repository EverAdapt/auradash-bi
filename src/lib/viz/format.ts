/**
 * OWNER: charts. Shared number/date formatters used by renderers, tooltips, axis ticks and the
 * dashboard board. Pure functions, no DOM.
 */
import type { Cell } from "@shared/contract"

/** The four `format` values the contract carries on a column (ResultColumnMeta / CatalogMetric). */
export type FormatKind = "number" | "percent" | "currency" | "years"

const numberFmt = new Intl.NumberFormat("en-US")
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const averageFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Plain thousands-comma'd integer/decimal, e.g. 12,345 or 12,345.6 */
export function formatNumber(value: number): string {
  return numberFmt.format(value)
}

/** Auto-compact for large numbers: 1,284 stays, 12,900 -> 12.9K, 4,200,000 -> 4.2M */
export function formatCompact(value: number): string {
  if (Math.abs(value) < 10_000) return numberFmt.format(value)
  return compactFmt.format(value)
}

/** One decimal place, for averages/ages/means. */
export function formatAverage(value: number): string {
  return averageFmt.format(value)
}

/** Years render without a thousands separator: 1,984 -> 1984. */
export function formatYear(value: number): string {
  return String(Math.round(value))
}

/** Values are already 0-100 shares (ChartSpec.percent contract). */
export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`
}

const currencyCache = new Map<string, Intl.NumberFormat>()
function currencyFormatter(unit: string, compact: boolean): Intl.NumberFormat | undefined {
  const key = `${unit}:${compact}`
  let fmt = currencyCache.get(key)
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: unit,
        notation: compact ? "compact" : "standard",
        maximumFractionDigits: compact ? 1 : 0,
      })
    } catch {
      fmt = undefined
    }
    if (fmt) currencyCache.set(key, fmt)
  }
  return fmt
}

/**
 * Currency from a catalog `unit` (e.g. "USD", "SEK", "US$"). A unit that isn't an ISO currency
 * ("money", "cents": an uploaded column we only know is monetary) formats as a plain number,
 * never with the unit word glued on.
 */
export function formatCurrency(value: number, unit = "USD", compact = Math.abs(value) >= 10_000): string {
  const iso = unit === "US$" || unit === "$" ? "USD" : unit
  const fmt = /^[A-Z]{3}$/.test(iso) ? currencyFormatter(iso, compact) : undefined
  if (fmt) return fmt.format(value)
  return compact ? formatCompact(value) : formatNumber(Number(value.toFixed(2)))
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * A time-axis value: a year (1990 / "1990"), a month bucket ("2025-03" -> "Mar 2025"), a quarter
 * bucket ("2025-Q1" -> "Q1 2025") or an ISO date. Uploads bucket DATE columns with strftime, so
 * time values are not always numbers.
 */
export function formatTimeLabel(value: number | string): string {
  if (typeof value === "number") return formatYear(value)
  const s = String(value)
  if (/^-?\d+(\.\d+)?$/.test(s)) return formatYear(Number(s))
  const month = /^(\d{4})-(\d{2})$/.exec(s)
  if (month) return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]}`
  const quarter = /^(\d{4})-Q([1-4])$/.exec(s)
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return formatDate(s)
  return s
}

/** ISO date or datetime text -> a short human date, e.g. "May 1, 2021". Falls through on bad input. */
export function formatDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

/** Dispatches on the contract's `format` (+ optional `unit`); handles null and non-numeric cells. */
export function formatValue(value: Cell, kind?: FormatKind, unit?: string): string {
  if (value === null || value === undefined) return "—" // em dash
  if (typeof value !== "number") return kind === "years" ? value : String(value)
  switch (kind) {
    case "years":
      return formatYear(value)
    case "percent":
      return formatPercent(value)
    case "currency":
      return formatCurrency(value, unit)
    case "number":
      return formatNumber(value)
    default:
      return Number.isInteger(value) ? formatCompact(value) : formatAverage(value)
  }
}

/** Axis ticks: clean, compact, comma'd. */
export function formatAxisTick(value: number, kind?: FormatKind, unit?: string): string {
  if (kind === "years") return formatYear(value)
  if (kind === "percent") return `${formatCompact(value)}%`
  if (kind === "currency") return formatCurrency(value, unit, true)
  return formatCompact(value)
}

/** Tooltip values favour precision over brevity, but still compact past a million. */
export function formatTooltipValue(value: Cell, kind?: FormatKind, unit?: string): string {
  if (value === null || value === undefined) return "—"
  if (typeof value !== "number") return String(value)
  if (kind === "years") return formatYear(value)
  if (kind === "percent") return formatPercent(value)
  if (kind === "currency") return formatCurrency(value, unit, Math.abs(value) >= 1_000_000)
  if (Math.abs(value) >= 1_000_000) return formatCompact(value)
  return Number.isInteger(value) ? formatNumber(value) : formatNumber(Number(value.toFixed(2)))
}

/** Humanizes a raw SQL column name into a label when no catalog label is available. */
export function humanizeLabel(name: string): string {
  const acronyms = new Set(["id", "gdp", "co2", "url", "iso", "usa", "uk", "sek", "usd", "un"])
  return name
    .replace(/^_+|_+$/g, "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (acronyms.has(lower)) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(" ")
}

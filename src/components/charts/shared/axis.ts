/**
 * OWNER: charts. Shared Recharts axis/grid presentation: hairline recessive grid and axes, muted
 * 11px ticks. One place so every cartesian renderer looks the same.
 */
import type { ProfiledColumn } from "@shared/contract"
import { formatAxisTick, formatTimeLabel } from "@/lib/viz"

export const tickStyle = { fill: "var(--chart-muted)", fontSize: 11 }
export const axisLine = { stroke: "var(--chart-axis)" }
export const gridColor = "var(--chart-grid)"

/**
 * Column-aware axis tick formatter. Recharts hands back whatever the underlying field holds, so a
 * category/geo axis gets its raw string passed straight through (formatting it as a number would
 * turn "Physics" into "NaN"); only true numeric columns (amount/time) get formatted as numbers.
 */
export function axisFormatter(col?: ProfiledColumn) {
  return (value: number | string) => {
    if (col?.kind === "time") return formatTimeLabel(value)
    if (typeof value === "string") return value
    return formatAxisTick(value, col?.format, col?.unit)
  }
}

export function columnLabel(col: ProfiledColumn | undefined, fallback: string): string {
  return col?.label ?? fallback
}

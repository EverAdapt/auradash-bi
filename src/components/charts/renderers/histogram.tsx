/**
 * OWNER: charts. Bars counting how many items fall in each range of one amount. encodeChart
 * hands us either an already-binned pair (a label/bin column + a count) or, when both channels
 * point at the same raw amount column, one un-binned value per row — this renderer bins that
 * case itself.
 */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartColumnBig } from "lucide-react"
import { formatAxisTick, formatCompact } from "@/lib/viz"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { axisLine, gridColor, tickStyle } from "../shared/axis"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

interface Bin {
  label: string
  count: number
}

function binValues(values: number[], bins: number): Bin[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ label: formatCompact(min), count: values.length }]
  const width = (max - min) / bins
  const counts = new Array(bins).fill(0)
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)))
    counts[idx]++
  }
  return counts.map((count, i) => {
    const x0 = min + i * width
    const x1 = x0 + width
    return { label: `${formatCompact(x0)}–${formatCompact(x1)}`, count }
  })
}

export function HistogramRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={ChartColumnBig} title="No distribution" description="Needs a number to bucket." />
  }

  const raw = xCol.name === yCol.name
  const data: Bin[] = raw
    ? binValues(
        rows.map((r) => r[xCol.name]).filter((v): v is number => typeof v === "number"),
        Math.min(16, Math.max(6, Math.round(Math.sqrt(rows.length))))
      )
    : rows.map((r) => {
        const value = r[yCol.name]
        return { label: String(r[xCol.name] ?? ""), count: typeof value === "number" ? value : 0 }
      })

  if (data.length === 0) {
    return <ChartEmptyState icon={ChartColumnBig} title="No distribution" description="Needs a number to bucket." />
  }

  const config: ChartConfig = { count: { label: raw ? "Count" : yCol.label, color: "var(--series-1)" } }

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -4, bottom: 0 }} barCategoryGap="6%">
        <CartesianGrid stroke={gridColor} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={axisLine}
          tick={tickStyle}
          interval="preserveStartEnd"
          minTickGap={compact ? 8 : 16}
        />
        {!compact && <YAxis tickLine={false} axisLine={false} tick={tickStyle} tickFormatter={(v: number) => formatAxisTick(v)} width={36} />}
        <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--series-1)" radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={animate} />
      </BarChart>
    </ChartContainer>
  )
}

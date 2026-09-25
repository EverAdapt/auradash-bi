/** OWNER: charts. Vertical bars: one category-or-time axis, one amount. */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartColumn } from "lucide-react"
import { formatTimeLabel } from "@/lib/viz"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { axisFormatter, axisLine, gridColor, tickStyle } from "../shared/axis"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

export function BarRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={ChartColumn} title="Nothing to compare" description="Needs a category and an amount." />
  }

  const config: ChartConfig = { [yCol.name]: { label: yCol.label, color: "var(--series-1)" } }
  const labelFmt = axisFormatter(xCol)

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -4, bottom: 0 }} barCategoryGap={compact ? "18%" : "28%"}>
        <CartesianGrid stroke={gridColor} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey={xCol.name}
          tickLine={false}
          axisLine={axisLine}
          tick={tickStyle}
          tickFormatter={labelFmt}
          interval="preserveStartEnd"
          minTickGap={compact ? 8 : 16}
        />
        {!compact && (
          <YAxis tickLine={false} axisLine={false} tick={tickStyle} tickFormatter={axisFormatter(yCol)} width={44} />
        )}
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={<ChartTooltipContent labelFormatter={(v) => (xCol.kind === "time" ? formatTimeLabel(v as string | number) : String(v))} />}
        />
        <Bar dataKey={yCol.name} fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={animate} />
      </BarChart>
    </ChartContainer>
  )
}

/** OWNER: charts. Bars split into segments by series; a 2px surface-color seam separates them. */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartBarStacked } from "lucide-react"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { axisFormatter, axisLine, gridColor, tickStyle } from "../shared/axis"
import { OTHER_KEY, planSeries } from "../shared/colors"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { foldOthers, pivotLong } from "../shared/pivot"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

export function StackedBarRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const seriesCol = findColumn(profile, spec.series)
  const yCol = findColumn(profile, spec.y?.[0])

  if (!xCol || !seriesCol || !yCol) {
    return <ChartEmptyState icon={ChartBarStacked} title="No breakdown" description="Needs an axis, a series and an amount." />
  }

  const pivoted = pivotLong(toRows(result), xCol.name, seriesCol.name, yCol.name)
  if (pivoted.data.length === 0) {
    return <ChartEmptyState icon={ChartBarStacked} title="No breakdown" description="Needs an axis, a series and an amount." />
  }

  const plan = planSeries(pivoted.seriesKeys)
  const { data } = foldOthers(pivoted, plan.folded)
  const config: ChartConfig = Object.fromEntries(
    plan.keys.map((k) => [k, { label: k === OTHER_KEY ? "Other" : k, color: plan.colorOf(k) }])
  )

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -4, bottom: 0 }} barCategoryGap={compact ? "18%" : "28%"}>
        <CartesianGrid stroke={gridColor} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey={xCol.name}
          tickLine={false}
          axisLine={axisLine}
          tick={tickStyle}
          tickFormatter={axisFormatter(xCol)}
          minTickGap={compact ? 8 : 16}
        />
        {!compact && <YAxis tickLine={false} axisLine={false} tick={tickStyle} tickFormatter={axisFormatter(yCol)} width={44} />}
        <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent />} />
        {plan.keys.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            name={key === OTHER_KEY ? "Other" : key}
            stackId="stack"
            fill={plan.colorOf(key)}
            stroke="var(--chart-surface)"
            strokeWidth={2}
            radius={i === plan.keys.length - 1 ? [4, 4, 0, 0] : 0}
            maxBarSize={32}
            isAnimationActive={animate}
          />
        ))}
        {!compact && <ChartLegend content={<ChartLegendContent />} />}
      </BarChart>
    </ChartContainer>
  )
}

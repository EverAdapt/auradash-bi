/** OWNER: charts. One line per series over time; a legend (never color-only) once >=2 lines exist. */
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartSpline } from "lucide-react"
import { formatTimeLabel } from "@/lib/viz"
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

export function MultiLineRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const seriesCol = findColumn(profile, spec.series)
  const yCol = findColumn(profile, spec.y?.[0])

  if (!xCol || !seriesCol || !yCol) {
    return <ChartEmptyState icon={ChartSpline} title="No series" description="Needs a time axis, a series and an amount." />
  }

  const pivoted = pivotLong(toRows(result), xCol.name, seriesCol.name, yCol.name)
  if (pivoted.data.length === 0) {
    return <ChartEmptyState icon={ChartSpline} title="No series" description="Needs a time axis, a series and an amount." />
  }

  const plan = planSeries(pivoted.seriesKeys)
  const { data } = foldOthers(pivoted, plan.folded)
  const config: ChartConfig = Object.fromEntries(
    plan.keys.map((k) => [k, { label: k === OTHER_KEY ? "Other" : k, color: plan.colorOf(k) }])
  )

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -4, bottom: 0 }}>
        <CartesianGrid stroke={gridColor} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey={xCol.name}
          tickLine={false}
          axisLine={axisLine}
          tick={tickStyle}
          tickFormatter={axisFormatter(xCol)}
          minTickGap={compact ? 16 : 28}
        />
        {!compact && <YAxis tickLine={false} axisLine={false} tick={tickStyle} tickFormatter={axisFormatter(yCol)} width={44} />}
        <ChartTooltip
          cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
          content={<ChartTooltipContent labelFormatter={(v) => (xCol.kind === "time" ? formatTimeLabel(v as string | number) : String(v))} />}
        />
        {plan.keys.map((key) => (
          <Line
            key={key}
            dataKey={key}
            name={key === OTHER_KEY ? "Other" : key}
            type="monotone"
            stroke={plan.colorOf(key)}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: plan.colorOf(key), stroke: "var(--chart-surface)", strokeWidth: 2 }}
            isAnimationActive={animate}
            connectNulls
          />
        ))}
        {!compact && <ChartLegend content={<ChartLegendContent />} />}
      </LineChart>
    </ChartContainer>
  )
}

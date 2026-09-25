/** OWNER: charts. Two amounts (or time x one amount) as dots; a generous hit target per point. */
import * as React from "react"
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartScatter } from "lucide-react"
import { formatYear } from "@/lib/viz"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { axisFormatter, axisLine, gridColor, tickStyle } from "../shared/axis"
import { planSeries } from "../shared/colors"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

const SINGLE_KEY = "value"

/** A visible >=8px dot with a surface ring, inside a >=24px transparent hit target. */
function ScatterPoint(color: string) {
  return function Point(props: { cx?: number; cy?: number }) {
    const { cx, cy } = props
    if (cx == null || cy == null) return null
    return (
      <g>
        <circle cx={cx} cy={cy} r={14} fill="transparent" />
        <circle cx={cx} cy={cy} r={4} fill={color} stroke="var(--chart-surface)" strokeWidth={2} />
      </g>
    )
  }
}

export function ScatterRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const colorCol = findColumn(profile, spec.color)
  const rows = toRows(result)

  // Every hook runs before the empty-state early return below.
  const groups = React.useMemo(() => {
    const map = new Map<string, typeof rows>()
    for (const r of rows) {
      const key = colorCol ? String(r[colorCol.name] ?? "—") : SINGLE_KEY
      const bucket = map.get(key)
      if (bucket) bucket.push(r)
      else map.set(key, [r])
    }
    return map
  }, [rows, colorCol])

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={ChartScatter} title="No relationship" description="Needs two amounts to plot." />
  }

  const keys = [...groups.keys()]
  const plan = planSeries(keys)
  const config: ChartConfig = Object.fromEntries(keys.map((k) => [k, { label: k, color: plan.colorOf(k) }]))
  const xIsTime = xCol.kind === "time"

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <ScatterChart margin={{ top: 8, right: 12, left: -4, bottom: 0 }}>
        <CartesianGrid stroke={gridColor} strokeDasharray="0" vertical={false} />
        <XAxis
          type="number"
          dataKey={xCol.name}
          name={xCol.label}
          tickLine={false}
          axisLine={axisLine}
          tick={tickStyle}
          tickFormatter={xIsTime ? (v: number) => formatYear(v) : axisFormatter(xCol)}
          domain={["dataMin", "dataMax"]}
          {...(spec.logX ? { scale: "log" as const } : {})}
        />
        <YAxis
          type="number"
          dataKey={yCol.name}
          name={yCol.label}
          hide={compact}
          tickLine={false}
          axisLine={false}
          tick={tickStyle}
          tickFormatter={axisFormatter(yCol)}
          width={compact ? 0 : 44}
        />
        <ChartTooltip cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }} content={<ChartTooltipContent />} />
        {keys.map((k) => (
          <Scatter key={k} name={k === SINGLE_KEY ? yCol.label : k} data={groups.get(k)} fill={plan.colorOf(k)} shape={ScatterPoint(plan.colorOf(k))} isAnimationActive={animate} />
        ))}
        {keys.length > 1 && !compact && <ChartLegend content={<ChartLegendContent />} />}
      </ScatterChart>
    </ChartContainer>
  )
}

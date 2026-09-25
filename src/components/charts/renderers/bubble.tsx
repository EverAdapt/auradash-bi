/** OWNER: charts. Two amounts placed as dots, sized by a third — the classic bubble scatter. */
import * as React from "react"
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { Bubbles } from "lucide-react"
import type { Cell } from "@shared/contract"
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
const MIN_R = 4
const MAX_R = 22

/** Radius comes from the size column ourselves (sqrt scale so area, not radius, tracks value). */
function bubbleShape(color: string, sizeKey: string | undefined, min: number, max: number) {
  return function Point(props: { cx?: number; cy?: number; payload?: Record<string, Cell> }) {
    const { cx, cy, payload } = props
    if (cx == null || cy == null) return null
    const raw = sizeKey && payload ? payload[sizeKey] : undefined
    const v = typeof raw === "number" ? raw : min
    const t = max > min ? (v - min) / (max - min) : 0.5
    const r = MIN_R + Math.sqrt(Math.max(0, t)) * (MAX_R - MIN_R)
    return (
      <g>
        <circle cx={cx} cy={cy} r={r + 8} fill="transparent" />
        <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity={0.7} stroke="var(--chart-surface)" strokeWidth={2} />
      </g>
    )
  }
}

export function BubbleRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const sizeCol = findColumn(profile, spec.size)
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
    return <ChartEmptyState icon={Bubbles} title="No comparison" description="Needs two amounts (and ideally a third for size)." />
  }

  const keys = [...groups.keys()]
  const plan = planSeries(keys)
  const config: ChartConfig = Object.fromEntries(keys.map((k) => [k, { label: k, color: plan.colorOf(k) }]))
  const sizeMin = sizeCol?.min ?? 0
  const sizeMax = sizeCol?.max ?? 1

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
          tickFormatter={axisFormatter(xCol)}
          domain={spec.logX ? ["auto", "auto"] : ["dataMin", "dataMax"]}
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
          <Scatter
            key={k}
            name={k === SINGLE_KEY ? yCol.label : k}
            data={groups.get(k)}
            fill={plan.colorOf(k)}
            shape={bubbleShape(plan.colorOf(k), sizeCol?.name, sizeMin, sizeMax)}
            isAnimationActive={animate}
          />
        ))}
        {keys.length > 1 && !compact && <ChartLegend content={<ChartLegendContent />} />}
      </ScatterChart>
    </ChartContainer>
  )
}

/** OWNER: charts. A single running/cumulative series: 2px line over a ~10% wash fill. */
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartArea } from "lucide-react"
import { formatTimeLabel } from "@/lib/viz"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { axisFormatter, axisLine, gridColor, tickStyle } from "../shared/axis"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

interface DotRenderProps {
  cx?: number
  cy?: number
  index?: number
}

function endDot(color: string, total: number) {
  return (props: DotRenderProps) => {
    const { cx, cy, index } = props
    if (index !== total - 1 || cx == null || cy == null) return <g key={`dot-${index}`} />
    return <circle key={`dot-${index}`} cx={cx} cy={cy} r={4} fill={color} stroke="var(--chart-surface)" strokeWidth={2} />
  }
}

export function AreaRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={ChartArea} title="No trend" description="Needs a time axis and an amount." />
  }

  const config: ChartConfig = { [yCol.name]: { label: yCol.label, color: "var(--series-1)" } }
  const gradientId = `area-fill-${yCol.name.replace(/[^a-zA-Z0-9]/g, "")}`

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <AreaChart data={rows} margin={{ top: 8, right: 12, left: -4, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={gridColor} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey={xCol.name}
          tickLine={false}
          axisLine={axisLine}
          tick={tickStyle}
          tickFormatter={axisFormatter(xCol)}
          minTickGap={compact ? 16 : 28}
        />
        {!compact && (
          <YAxis tickLine={false} axisLine={false} tick={tickStyle} tickFormatter={axisFormatter(yCol)} width={44} />
        )}
        <ChartTooltip
          cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
          content={<ChartTooltipContent labelFormatter={(v) => (xCol.kind === "time" ? formatTimeLabel(v as string | number) : String(v))} />}
        />
        <Area
          dataKey={yCol.name}
          type="monotone"
          stroke="var(--series-1)"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={endDot("var(--series-1)", rows.length)}
          activeDot={{ r: 4, fill: "var(--series-1)", stroke: "var(--chart-surface)", strokeWidth: 2 }}
          isAnimationActive={animate}
        />
      </AreaChart>
    </ChartContainer>
  )
}

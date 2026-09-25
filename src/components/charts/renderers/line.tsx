/** OWNER: charts. A single time series: 2px line, one >=8px dot marking the endpoint. */
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { ChartLine } from "lucide-react"
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

/** Only the last point gets a marker — the value at the end, per the anatomy spec. */
function endDot(color: string, total: number) {
  return (props: DotRenderProps) => {
    const { cx, cy, index } = props
    if (index !== total - 1 || cx == null || cy == null) return <g key={`dot-${index}`} />
    return <circle key={`dot-${index}`} cx={cx} cy={cy} r={4} fill={color} stroke="var(--chart-surface)" strokeWidth={2} />
  }
}

export function LineRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={ChartLine} title="No trend" description="Needs a time axis and an amount." />
  }

  const config: ChartConfig = { [yCol.name]: { label: yCol.label, color: "var(--series-1)" } }

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: -4, bottom: 0 }}>
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
        <Line
          dataKey={yCol.name}
          type="monotone"
          stroke="var(--series-1)"
          strokeWidth={2}
          dot={endDot("var(--series-1)", rows.length)}
          activeDot={{ r: 4, fill: "var(--series-1)", stroke: "var(--chart-surface)", strokeWidth: 2 }}
          isAnimationActive={animate}
        />
      </LineChart>
    </ChartContainer>
  )
}

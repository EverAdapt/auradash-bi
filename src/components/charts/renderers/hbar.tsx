/** OWNER: charts. Ranked horizontal bars: many categories or long names, one amount. */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { cn } from "cn"
import { BarChartHorizontal } from "lucide-react"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { axisFormatter, axisLine, gridColor, tickStyle } from "../shared/axis"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

const LABEL_WIDTH_COMPACT = 72
const LABEL_WIDTH = 128
/** Average glyph width at the 11px tick font, used to fit a label into `width` on one line. */
const CHARS_PER_PX = 1 / 6.2

/** A single-line, truncated category label (never Recharts' default multi-line word wrap, which
 * reads back to assistive tech as one run-on word). The full name is always on the `<title>`. */
function CategoryTick({
  x,
  y,
  width,
  payload,
}: {
  x?: number
  y?: number
  width: number
  payload?: { value: string }
}) {
  const value = payload?.value ?? ""
  const maxChars = Math.max(3, Math.floor(width * CHARS_PER_PX))
  const truncated = value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill="var(--chart-muted)" fontSize={11}>
      {truncated !== value && <title>{value}</title>}
      {truncated}
    </text>
  )
}

export function HbarRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x) // the category column, rendered on the Y axis
  const yCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={BarChartHorizontal} title="Nothing to rank" description="Needs a category and an amount." />
  }

  const config: ChartConfig = { [yCol.name]: { label: yCol.label, color: "var(--series-1)" } }
  const labelWidth = compact ? LABEL_WIDTH_COMPACT : LABEL_WIDTH

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full min-h-0", className)}>
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        barCategoryGap={compact ? "16%" : "24%"}
      >
        <CartesianGrid stroke={gridColor} strokeDasharray="0" horizontal={false} />
        <XAxis type="number" tickLine={false} axisLine={axisLine} tick={tickStyle} tickFormatter={axisFormatter(yCol)} hide={compact} />
        <YAxis
          type="category"
          dataKey={xCol.name}
          tickLine={false}
          axisLine={false}
          tick={<CategoryTick width={labelWidth} />}
          width={labelWidth}
          interval={0}
        />
        <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent />} />
        <Bar dataKey={yCol.name} fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={animate} />
      </BarChart>
    </ChartContainer>
  )
}

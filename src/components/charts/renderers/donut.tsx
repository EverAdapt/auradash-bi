/** OWNER: charts. Part-of-a-whole: up to ~8 slices, a legend (never color-only), a center total. */
import { Cell, Pie, PieChart } from "recharts"
import { cn } from "cn"
import { Donut } from "lucide-react"
import { formatCompact } from "@/lib/viz"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { planSeries } from "../shared/colors"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

export function DonutRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const xCol = findColumn(profile, spec.x)
  const yCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)

  if (!xCol || !yCol || rows.length === 0) {
    return <ChartEmptyState icon={Donut} title="No slices" description="Needs a category and a non-negative amount." />
  }

  const names = rows.map((r) => String(r[xCol.name] ?? ""))
  const plan = planSeries(names)
  const data = rows.map((r, i) => ({ name: names[i], value: typeof r[yCol.name] === "number" ? r[yCol.name] : 0 }))
  const total = data.reduce((sum, d) => sum + (typeof d.value === "number" ? d.value : 0), 0)
  const config: ChartConfig = Object.fromEntries(names.map((n) => [n, { label: n, color: plan.colorOf(n) }]))

  return (
    <div className={cn("relative flex h-full w-full flex-col", className)}>
      <ChartContainer config={config} className="aspect-auto h-full w-full min-h-0">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={names.length > 1 ? 2 : 0}
            strokeWidth={0}
            isAnimationActive={animate}
          >
            {data.map((d) => (
              <Cell key={d.name} fill={plan.colorOf(d.name)} />
            ))}
          </Pie>
          {!compact && <ChartLegend content={<ChartLegendContent nameKey="name" />} />}
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-6">
        <span className="text-lg font-medium tabular-nums text-foreground">{formatCompact(total)}</span>
        <span className="text-[10px] text-muted-foreground">total</span>
      </div>
    </div>
  )
}

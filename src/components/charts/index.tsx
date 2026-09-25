/* eslint-disable react-refresh/only-export-components */
/**
 * OWNER: charts. Public surface of the chart layer: one <ChartView> for every chart type, and the
 * registry (label, icon, the criterion Jev reads, default dashboard size). Each renderer is code
 * split via React.lazy so a dashboard with a handful of chart types never pulls in all sixteen.
 * This file's exported surface (ChartView, ChartViewProps, chartRegistry, ChartRegistryEntry) is
 * the contract — it necessarily mixes a component with plain data, which is why fast refresh is
 * disabled here (same pattern as theme-provider.tsx).
 */
import * as React from "react"
import type { ChartType } from "@shared/contract"
import {
  BarChart2,
  BarChartHorizontal,
  Bubbles,
  ChartArea,
  ChartBarStacked,
  ChartColumn,
  ChartColumnBig,
  ChartLine,
  ChartScatter,
  ChartSpline,
  Donut,
  Grid3x3,
  Hash,
  Map,
  MapPin,
  Table2,
  type LucideIcon,
} from "lucide-react"
import { chartCriteria } from "@/lib/viz"
import { Spinner } from "@/components/ui/spinner"
import type { RendererProps } from "./shared/types"
import "@/styles/charts.css"

export type { RendererProps as ChartViewProps }

type Renderer = React.LazyExoticComponent<React.ComponentType<RendererProps>>

function lazyRenderer<K extends string>(loader: () => Promise<Record<K, React.ComponentType<RendererProps>>>, key: K): Renderer {
  return React.lazy(() => loader().then((mod) => ({ default: mod[key] })))
}

const renderers: Record<ChartType, Renderer> = {
  kpi: lazyRenderer(() => import("./renderers/kpi"), "KpiRenderer"),
  bar: lazyRenderer(() => import("./renderers/bar"), "BarRenderer"),
  hbar: lazyRenderer(() => import("./renderers/hbar"), "HbarRenderer"),
  line: lazyRenderer(() => import("./renderers/line"), "LineRenderer"),
  area: lazyRenderer(() => import("./renderers/area"), "AreaRenderer"),
  multi_line: lazyRenderer(() => import("./renderers/multi-line"), "MultiLineRenderer"),
  stacked_bar: lazyRenderer(() => import("./renderers/stacked-bar"), "StackedBarRenderer"),
  grouped_bar: lazyRenderer(() => import("./renderers/grouped-bar"), "GroupedBarRenderer"),
  donut: lazyRenderer(() => import("./renderers/donut"), "DonutRenderer"),
  scatter: lazyRenderer(() => import("./renderers/scatter"), "ScatterRenderer"),
  bubble: lazyRenderer(() => import("./renderers/bubble"), "BubbleRenderer"),
  histogram: lazyRenderer(() => import("./renderers/histogram"), "HistogramRenderer"),
  heatmap: lazyRenderer(() => import("./renderers/heatmap"), "HeatmapRenderer"),
  choropleth: lazyRenderer(() => import("./renderers/choropleth"), "ChoroplethRenderer"),
  point_map: lazyRenderer(() => import("./renderers/point-map"), "PointMapRenderer"),
  table: lazyRenderer(() => import("./renderers/table"), "TableRenderer"),
}

function ChartFallback() {
  return (
    <div className="flex h-full w-full min-h-[80px] items-center justify-center">
      <Spinner className="text-muted-foreground" />
    </div>
  )
}

export function ChartView({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  const Renderer = renderers[spec.type]
  return (
    <React.Suspense fallback={<ChartFallback />}>
      <Renderer spec={spec} result={result} profile={profile} className={className} animate={animate} compact={compact} />
    </React.Suspense>
  )
}

export interface ChartRegistryEntry {
  label: string
  icon: LucideIcon
  /** what Jev reads when choosing among eligible charts */
  criterion: string
  /** default size on the 12-column dashboard grid (rows are 44px) */
  defaultSize: { w: number; h: number }
}

export const chartRegistry: Record<ChartType, ChartRegistryEntry> = {
  kpi: { label: "Number", icon: Hash, criterion: chartCriteria.kpi, defaultSize: { w: 3, h: 3 } },
  bar: { label: "Columns", icon: ChartColumn, criterion: chartCriteria.bar, defaultSize: { w: 4, h: 6 } },
  hbar: { label: "Ranked bars", icon: BarChartHorizontal, criterion: chartCriteria.hbar, defaultSize: { w: 6, h: 6 } },
  line: { label: "Line", icon: ChartLine, criterion: chartCriteria.line, defaultSize: { w: 6, h: 6 } },
  area: { label: "Area", icon: ChartArea, criterion: chartCriteria.area, defaultSize: { w: 6, h: 6 } },
  multi_line: { label: "Lines", icon: ChartSpline, criterion: chartCriteria.multi_line, defaultSize: { w: 6, h: 6 } },
  stacked_bar: { label: "Stacked", icon: ChartBarStacked, criterion: chartCriteria.stacked_bar, defaultSize: { w: 6, h: 6 } },
  grouped_bar: { label: "Grouped", icon: BarChart2, criterion: chartCriteria.grouped_bar, defaultSize: { w: 6, h: 6 } },
  donut: { label: "Donut", icon: Donut, criterion: chartCriteria.donut, defaultSize: { w: 4, h: 6 } },
  scatter: { label: "Scatter", icon: ChartScatter, criterion: chartCriteria.scatter, defaultSize: { w: 6, h: 7 } },
  bubble: { label: "Bubbles", icon: Bubbles, criterion: chartCriteria.bubble, defaultSize: { w: 6, h: 7 } },
  histogram: { label: "Histogram", icon: ChartColumnBig, criterion: chartCriteria.histogram, defaultSize: { w: 4, h: 6 } },
  heatmap: { label: "Heatmap", icon: Grid3x3, criterion: chartCriteria.heatmap, defaultSize: { w: 6, h: 7 } },
  choropleth: { label: "Map", icon: Map, criterion: chartCriteria.choropleth, defaultSize: { w: 6, h: 7 } },
  point_map: { label: "Points map", icon: MapPin, criterion: chartCriteria.point_map, defaultSize: { w: 6, h: 7 } },
  table: { label: "Table", icon: Table2, criterion: chartCriteria.table, defaultSize: { w: 6, h: 6 } },
}

/**
 * OWNER: charts. Custom SVG heatmap: two categories crossed, one amount on the sequential ramp.
 * A per-cell hover tooltip stands in for the crosshair (cells, not a continuous axis, carry hover).
 */
import * as React from "react"
import { Grid3x3 } from "lucide-react"
import { cn } from "cn"
import { formatTooltipValue } from "@/lib/viz"
import { SEQ_STEPS, quantileBreaks, seqColorQuantile } from "../shared/colors"
import { ChartEmptyState } from "../shared/EmptyState"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

interface Hover {
  row: string
  col: string
  value: number | null
  x: number
  y: number
}

export function HeatmapRenderer({ spec, result, profile, className, compact }: RendererProps) {
  const colCol = findColumn(profile, spec.x)
  const rowCol = findColumn(profile, spec.series)
  const valCol = findColumn(profile, spec.y?.[0])
  const rows = toRows(result)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [hover, setHover] = React.useState<Hover | null>(null)

  if (!colCol || !rowCol || !valCol || rows.length === 0) {
    return <ChartEmptyState icon={Grid3x3} title="No grid" description="Needs two categories and an amount." />
  }

  const rowKeys: string[] = []
  const colKeys: string[] = []
  const rowSeen = new Set<string>()
  const colSeen = new Set<string>()
  const values = new Map<string, number>()
  let min = Infinity
  let max = -Infinity

  for (const r of rows) {
    const rk = String(r[rowCol.name] ?? "")
    const ck = String(r[colCol.name] ?? "")
    const v = r[valCol.name]
    if (!rowSeen.has(rk)) {
      rowSeen.add(rk)
      rowKeys.push(rk)
    }
    if (!colSeen.has(ck)) {
      colSeen.add(ck)
      colKeys.push(ck)
    }
    if (typeof v === "number") {
      values.set(`${rk}|${ck}`, v)
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min)) {
    min = 0
    max = 1
  }
  const breaks = quantileBreaks([...values.values()])

  const cellSize = compact ? 22 : 30
  const gap = 2
  const labelWidth = compact ? 52 : 92
  const labelHeight = 26
  const width = labelWidth + colKeys.length * cellSize
  const height = labelHeight + rowKeys.length * cellSize

  return (
    <div ref={containerRef} className={cn("viz-scroll relative flex h-full w-full flex-col overflow-auto", className)}>
      <svg width={width} height={height} className="shrink-0" role="img" aria-label={`${rowCol.label} by ${colCol.label}, shaded by ${valCol.label}`}>
        {colKeys.map((ck, ci) => (
          <text key={ck} x={labelWidth + ci * cellSize + cellSize / 2} y={labelHeight - 9} textAnchor="middle" fontSize={10} fill="var(--chart-muted)">
            {compact && ck.length > 6 ? `${ck.slice(0, 5)}…` : ck}
          </text>
        ))}
        {rowKeys.map((rk, ri) => (
          <g key={rk}>
            <text x={labelWidth - 8} y={labelHeight + ri * cellSize + cellSize / 2 + 3} textAnchor="end" fontSize={10} fill="var(--chart-muted)">
              {compact && rk.length > 10 ? `${rk.slice(0, 9)}…` : rk}
            </text>
            {colKeys.map((ck, ci) => {
              const v = values.get(`${rk}|${ck}`) ?? null
              return (
                <rect
                  key={ck}
                  x={labelWidth + ci * cellSize + gap / 2}
                  y={labelHeight + ri * cellSize + gap / 2}
                  width={cellSize - gap}
                  height={cellSize - gap}
                  rx={2}
                  className="viz-cell"
                  style={{ fill: seqColorQuantile(v, breaks), cursor: "default" }}
                  onMouseEnter={(e) => {
                    const box = containerRef.current?.getBoundingClientRect()
                    setHover({ row: rk, col: ck, value: v, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) })
                  }}
                  onMouseMove={(e) => {
                    const box = containerRef.current?.getBoundingClientRect()
                    setHover((h) => (h ? { ...h, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) } : h))
                  }}
                  onFocus={() => setHover({ row: rk, col: ck, value: v, x: labelWidth + ci * cellSize, y: labelHeight + ri * cellSize })}
                  onMouseLeave={() => setHover(null)}
                  tabIndex={0}
                />
              )
            })}
          </g>
        ))}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-medium text-foreground">
            {hover.row} · {hover.col}
          </div>
          <div className="text-muted-foreground">
            {valCol.label}:{" "}
            <span className="font-mono font-medium tabular-nums text-foreground">
              {hover.value === null ? "—" : formatTooltipValue(hover.value, valCol.format, valCol.unit)}
            </span>
          </div>
        </div>
      )}
      {!compact && (
        <div className="mt-1.5 flex shrink-0 items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
          <span>{formatTooltipValue(min, valCol.format, valCol.unit)}</span>
          <div className="flex h-2 overflow-hidden rounded-full">
            {SEQ_STEPS.map((s) => (
              <div key={s} style={{ background: s, width: 12 }} />
            ))}
          </div>
          <span>{formatTooltipValue(max, valCol.format, valCol.unit)}</span>
        </div>
      )}
    </div>
  )
}

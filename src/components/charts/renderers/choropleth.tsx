/**
 * OWNER: charts. Custom SVG map: geoEqualEarth fitted to a fixed design box, sequential ramp fill
 * per country, hover tooltip, small legend. `feature.id` (ISO3) is the join key.
 */
import * as React from "react"
import { geoEqualEarth, geoPath } from "d3-geo"
import { Map as MapIcon } from "lucide-react"
import { cn } from "cn"
import { formatTooltipValue } from "@/lib/viz"
import { SEQ_EMPTY, SEQ_STEPS, quantileBreaks, seqColorQuantile } from "../shared/colors"
import { ChartEmptyState } from "../shared/EmptyState"
import { loadWorldGeo, type WorldGeo } from "../shared/geo"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

const WIDTH = 960
const HEIGHT = 500

interface Hover {
  name: string
  value: number | null
  x: number
  y: number
}

export function ChoroplethRenderer({ spec, result, profile, className, compact }: RendererProps) {
  const geoCol = findColumn(profile, spec.geo)
  const valCol = findColumn(profile, spec.y?.[0])
  const [geo, setGeo] = React.useState<WorldGeo | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [hover, setHover] = React.useState<Hover | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let alive = true
    loadWorldGeo()
      .then((g) => alive && setGeo(g))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  const rows = toRows(result)

  if (!geoCol || !valCol || rows.length === 0) {
    return <ChartEmptyState icon={MapIcon} title="No map" description="Needs a country code and an amount." />
  }
  if (failed) {
    return <ChartEmptyState icon={MapIcon} title="Map unavailable" description="The world geometry couldn't be loaded." />
  }

  const valueByIso = new Map<string, number>()
  let min = Infinity
  let max = -Infinity
  for (const r of rows) {
    const code = String(r[geoCol.name] ?? "").toUpperCase()
    const v = r[valCol.name]
    if (typeof v === "number") {
      valueByIso.set(code, v)
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min)) {
    min = 0
    max = 1
  }
  const breaks = quantileBreaks([...valueByIso.values()])

  if (!geo) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center text-xs text-muted-foreground", className)}>
        Loading map…
      </div>
    )
  }

  const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], geo)
  const path = geoPath(projection)

  return (
    <div ref={containerRef} className={cn("relative h-full w-full", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${valCol.label} by country`}
      >
        {geo.features.map((feature) => {
          const code = String(feature.id ?? "")
          const value = valueByIso.get(code) ?? null
          const d = path(feature)
          if (!d) return null
          return (
            <path
              key={code}
              d={d}
              className="viz-cell"
              style={{ fill: seqColorQuantile(value, breaks), stroke: "var(--chart-surface)", strokeWidth: 0.5, cursor: "default" }}
              onMouseMove={(e) => {
                const box = containerRef.current?.getBoundingClientRect()
                setHover({
                  name: feature.properties?.name ?? code,
                  value,
                  x: e.clientX - (box?.left ?? 0),
                  y: e.clientY - (box?.top ?? 0),
                })
              }}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-medium text-foreground">{hover.name}</div>
          <div className="text-muted-foreground">
            {valCol.label}:{" "}
            <span className="font-mono font-medium tabular-nums text-foreground">
              {hover.value === null ? "No data" : formatTooltipValue(hover.value, valCol.format, valCol.unit)}
            </span>
          </div>
        </div>
      )}
      {!compact && (
        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded-full border border-border/50 bg-[var(--chart-surface)] px-2 py-1 text-[10px] text-muted-foreground">
          <span>{formatTooltipValue(min, valCol.format, valCol.unit)}</span>
          <div className="flex h-2 overflow-hidden rounded-full">
            {SEQ_STEPS.map((s) => (
              <div key={s} style={{ background: s, width: 10 }} />
            ))}
          </div>
          <span>{formatTooltipValue(max, valCol.format, valCol.unit)}</span>
          <span className="mx-0.5 h-2 w-2 rounded-full border border-border/60" style={{ background: SEQ_EMPTY }} />
          <span>no data</span>
        </div>
      )}
    </div>
  )
}

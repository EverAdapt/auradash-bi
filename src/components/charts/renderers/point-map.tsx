/**
 * OWNER: charts. Custom SVG point map: a muted basemap, one dot per location, optionally sized by
 * a measure, coloured a single series hue with a 1px surface ring so overlapping points separate.
 */
import * as React from "react"
import { geoEqualEarth, geoPath } from "d3-geo"
import { MapPin } from "lucide-react"
import { cn } from "cn"
import { formatTooltipValue } from "@/lib/viz"
import { ChartEmptyState } from "../shared/EmptyState"
import { loadWorldGeo, type WorldGeo } from "../shared/geo"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

const WIDTH = 960
const HEIGHT = 500
const MIN_R = 3
const MAX_R = 9

interface Hover {
  label: string
  value: number | null
  x: number
  y: number
}

export function PointMapRenderer({ spec, result, profile, className, compact }: RendererProps) {
  const latCol = findColumn(profile, spec.lat)
  const lonCol = findColumn(profile, spec.lon)
  const sizeCol = findColumn(profile, spec.size)
  const labelCol = findColumn(profile, spec.label)
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

  if (!latCol || !lonCol || rows.length === 0) {
    return <ChartEmptyState icon={MapPin} title="No locations" description="Needs latitude and longitude." />
  }
  if (failed) {
    return <ChartEmptyState icon={MapPin} title="Map unavailable" description="The world geometry couldn't be loaded." />
  }
  if (!geo) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center text-xs text-muted-foreground", className)}>
        Loading map…
      </div>
    )
  }

  const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], geo)
  const path = geoPath(projection)
  const sizeMin = sizeCol?.min ?? 0
  const sizeMax = sizeCol?.max ?? 1

  return (
    <div ref={containerRef} className={cn("relative h-full w-full", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={labelCol ? `${labelCol.label} locations` : "Locations"}
      >
        <g>
          {geo.features.map((feature) => {
            const d = path(feature)
            if (!d) return null
            return <path key={String(feature.id)} d={d} style={{ fill: "var(--muted)", stroke: "var(--chart-grid)", strokeWidth: 0.5 }} />
          })}
        </g>
        <g>
          {rows.map((r, i) => {
            const lat = r[latCol.name]
            const lon = r[lonCol.name]
            if (typeof lat !== "number" || typeof lon !== "number") return null
            const projected = projection([lon, lat])
            if (!projected) return null
            const [cx, cy] = projected
            const sizeVal = sizeCol ? r[sizeCol.name] : undefined
            const t = sizeCol && typeof sizeVal === "number" && sizeMax > sizeMin ? (sizeVal - sizeMin) / (sizeMax - sizeMin) : 0.4
            const radius = sizeCol ? MIN_R + Math.sqrt(Math.max(0, t)) * (MAX_R - MIN_R) : MIN_R + 1
            const label = labelCol ? String(r[labelCol.name] ?? "") : `${lat.toFixed(1)}, ${lon.toFixed(1)}`
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={radius}
                fill="var(--series-1)"
                fillOpacity={0.75}
                stroke="var(--chart-surface)"
                strokeWidth={1}
                style={{ cursor: "default" }}
                onMouseEnter={(e) => {
                  const box = containerRef.current?.getBoundingClientRect()
                  setHover({
                    label,
                    value: typeof sizeVal === "number" ? sizeVal : null,
                    x: e.clientX - (box?.left ?? 0),
                    y: e.clientY - (box?.top ?? 0),
                  })
                }}
                onMouseLeave={() => setHover(null)}
              />
            )
          })}
        </g>
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-medium text-foreground">{hover.label}</div>
          {sizeCol && hover.value !== null && (
            <div className="text-muted-foreground">
              {sizeCol.label}:{" "}
              <span className="font-mono font-medium tabular-nums text-foreground">
                {formatTooltipValue(hover.value, sizeCol.format, sizeCol.unit)}
              </span>
            </div>
          )}
        </div>
      )}
      {!compact && (
        <div className="absolute bottom-1.5 left-1.5 rounded-full border border-border/50 bg-[var(--chart-surface)] px-2 py-1 text-[10px] text-muted-foreground">
          {rows.length.toLocaleString()} locations
        </div>
      )}
    </div>
  )
}

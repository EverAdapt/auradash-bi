/**
 * OWNER: data-engine. A small, tasteful SVG ER diagram: rounded boxes for every visible table,
 * arranged in simple left-to-right layers by FK direction (longest-path layering — the "many"
 * side sits left of what it references), lines for joins, the current table highlighted.
 */
import { useMemo } from "react"
import { Link } from "wouter"
import type { Catalog, DatasetId } from "@shared/contract"

const COL_W = 200
const ROW_H = 52
const BOX_W = 156
const BOX_H = 34
const PAD = 24

function computeLayers(tableNames: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const layer = new Map(tableNames.map((t) => [t, 0]))
  for (let iter = 0; iter < tableNames.length + 1; iter++) {
    let changed = false
    for (const e of edges) {
      if (!layer.has(e.from) || !layer.has(e.to)) continue
      const from = layer.get(e.from) ?? 0
      const to = layer.get(e.to) ?? 0
      if (to < from + 1) {
        layer.set(e.to, from + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  return layer
}

export function ErDiagram({ datasetId, catalog, currentTable }: { datasetId: DatasetId; catalog: Catalog; currentTable: string }) {
  const visible = useMemo(() => catalog.tables.filter((t) => !t.hidden), [catalog])
  const names = useMemo(() => visible.map((t) => t.name), [visible])

  // One edge per connected table pair (several FK columns between the same two tables collapse).
  const pairEdges = useMemo(() => {
    const seen = new Set<string>()
    const list: { from: string; to: string }[] = []
    for (const j of catalog.joins) {
      const from = j.from.split(".")[0]
      const to = j.to.split(".")[0]
      if (from === to || !names.includes(from) || !names.includes(to)) continue
      const k = `${from}>${to}`
      if (seen.has(k)) continue
      seen.add(k)
      list.push({ from, to })
    }
    return list
  }, [catalog.joins, names])

  const layers = useMemo(() => computeLayers(names, pairEdges), [names, pairEdges])

  const { positions, maxLayer, maxRowsInAnyLayer } = useMemo(() => {
    const byLayer = new Map<number, string[]>()
    for (const name of names) {
      const l = layers.get(name) ?? 0
      byLayer.set(l, [...(byLayer.get(l) ?? []), name])
    }
    const pos = new Map<string, { x: number; y: number }>()
    const maxL = byLayer.size === 0 ? 0 : Math.max(...byLayer.keys())
    let maxRows = 1
    for (let l = 0; l <= maxL; l++) {
      const names2 = (byLayer.get(l) ?? []).sort()
      maxRows = Math.max(maxRows, names2.length)
      names2.forEach((name, i) => {
        pos.set(name, { x: PAD + l * COL_W, y: PAD + i * ROW_H })
      })
    }
    return { positions: pos, maxLayer: maxL, maxRowsInAnyLayer: maxRows }
  }, [names, layers])

  if (names.length === 0) return null

  const width = PAD * 2 + (maxLayer + 1) * COL_W - (COL_W - BOX_W)
  const height = PAD * 2 + maxRowsInAnyLayer * ROW_H - (ROW_H - BOX_H)

  const center = (name: string) => {
    const p = positions.get(name)
    if (!p) return { x: 0, y: 0 }
    return { x: p.x + BOX_W / 2, y: p.y + BOX_H / 2 }
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Table relationships">
      <defs>
        <marker id="er-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--chart-axis)" />
        </marker>
      </defs>
      {pairEdges.map((e) => {
        const a = center(e.from)
        const b = center(e.to)
        const midX = (a.x + b.x) / 2
        return (
          <path
            key={`${e.from}>${e.to}`}
            d={`M ${a.x + BOX_W / 2} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x - BOX_W / 2} ${b.y}`}
            fill="none"
            stroke="var(--chart-axis)"
            strokeWidth={1.25}
            markerEnd="url(#er-arrow)"
          />
        )
      })}
      {names.map((name) => {
        const p = positions.get(name)
        const table = visible.find((t) => t.name === name)
        if (!p || !table) return null
        const isCurrent = name === currentTable
        return (
          <g key={name}>
            <foreignObject x={p.x} y={p.y} width={BOX_W} height={BOX_H}>
              <Link
                href={`/explore/${datasetId}/${name}`}
                className="flex h-full items-center justify-center rounded-[var(--radius-md)] border px-2 text-center text-xs font-medium"
                style={{
                  borderColor: isCurrent ? "var(--brand)" : "var(--border)",
                  background: isCurrent ? "var(--brand-soft)" : "var(--card)",
                  color: isCurrent ? "var(--accent-foreground)" : "var(--foreground)",
                  boxShadow: isCurrent ? "0 0 0 1px var(--brand)" : undefined,
                }}
                title={table.label}
              >
                <span className="truncate">{table.label}</span>
              </Link>
            </foreignObject>
          </g>
        )
      })}
    </svg>
  )
}

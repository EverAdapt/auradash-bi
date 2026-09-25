/**
 * OWNER: charts. Table: sticky header, right-aligned numbers, @tanstack/react-virtual once a
 * result runs past 200 rows so a "list every laureate" result stays smooth to scroll.
 */
import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "cn"
import { formatTimeLabel, formatValue } from "@/lib/viz"
import type { ProfiledColumn } from "@shared/contract"
import { Table2 } from "lucide-react"
import { ChartEmptyState } from "../shared/EmptyState"
import type { RendererProps } from "../shared/types"

const VIRTUALIZE_ABOVE = 200
const ROW_HEIGHT = 34

function isNumeric(col: ProfiledColumn): boolean {
  return col.kind === "amount" || col.kind === "time" || col.kind === "id" || col.kind === "latitude" || col.kind === "longitude"
}

export function TableRenderer({ result, profile, className, compact }: RendererProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const columns = profile.columns

  // Every hook runs before the empty-state early return below.
  const virtualize = result.rows.length > VIRTUALIZE_ABOVE
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtualize,
  })

  if (result.rows.length === 0 || columns.length === 0) {
    return <ChartEmptyState icon={Table2} title="No rows" description="This result came back empty." />
  }

  const template = columns
    .map((c) => (isNumeric(c) ? "minmax(84px, auto)" : compact ? "minmax(90px, 1fr)" : "minmax(120px, 1.4fr)"))
    .join(" ")

  const rowsToRender = virtualize ? virtualizer.getVirtualItems() : result.rows.map((_, i) => ({ index: i, start: i * ROW_HEIGHT, key: i }))
  const totalHeight = virtualize ? virtualizer.getTotalSize() : result.rows.length * ROW_HEIGHT

  return (
    <div className={cn("flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-md)] border border-border", className)}>
      <div ref={scrollRef} className="viz-scroll min-h-0 flex-1 overflow-auto">
        <div className="grid text-sm" style={{ gridTemplateColumns: template, minWidth: "100%" }}>
          {columns.map((col) => (
            <div
              key={col.name}
              className={cn(
                "sticky top-0 z-10 truncate border-b border-border bg-[var(--chart-surface)] px-3 py-2 text-xs font-medium text-muted-foreground",
                isNumeric(col) && "text-right"
              )}
              title={col.label}
            >
              {col.label}
            </div>
          ))}
          <div style={{ gridColumn: `1 / -1`, position: "relative", height: totalHeight }}>
            {rowsToRender.map((vRow) => {
              const row = result.rows[vRow.index]
              return (
                <div
                  key={vRow.key}
                  className="grid border-b border-border/60 last:border-b-0 hover:bg-muted/40"
                  style={{
                    gridTemplateColumns: template,
                    gridColumn: `1 / -1`,
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT,
                    transform: `translateY(${vRow.start}px)`,
                  }}
                >
                  {columns.map((col, ci) => {
                    const value = col.kind === "time" && typeof row[ci] === "number" ? formatTimeLabel(row[ci] as number) : formatValue(row[ci], col.format, col.unit)
                    return (
                      <div
                        key={col.name}
                        className={cn(
                          "truncate px-3 py-1.5 text-foreground",
                          isNumeric(col) ? "text-right tabular-nums" : "text-left"
                        )}
                        title={typeof value === "string" ? value : undefined}
                      >
                        {value}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {profile.truncated && (
        <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing the first {result.rows.length.toLocaleString()} rows
        </div>
      )}
    </div>
  )
}

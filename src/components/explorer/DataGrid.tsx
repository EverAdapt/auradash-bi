/**
 * OWNER: data-engine. A virtualized (@tanstack/react-virtual) results grid shared by the Rows tab
 * and the SQL console: sticky header, tabular-nums right-aligned numbers, muted italic NULL, long
 * text truncated with a title tooltip, click-header sort, optional infinite scroll.
 *
 * Built with CSS grid (not <table>) so the sticky header and the absolutely-positioned virtual
 * rows share one column grid and scroll horizontally in lockstep inside a single container.
 */
import { useEffect, useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, ArrowUp } from "lucide-react"
import type { Cell } from "@shared/contract"
import { cn } from "@/lib/utils"

export interface DataGridColumn {
  name: string
  label?: string
  align?: "left" | "right"
  sortable?: boolean
  width?: number // px; defaults to a sensible min-content column
  /** overrides the default cell renderer (e.g. an FK value rendered as a link) */
  renderCell?: (value: Cell, rowIndex: number) => React.ReactNode
}

export interface DataGridProps {
  columns: DataGridColumn[]
  rows: Cell[][]
  rowHeight?: number
  sort?: { column: string; dir: "asc" | "desc" } | null
  onSortChange?: (column: string) => void
  /** called when the scroll position nears the bottom, for SQL-side paging */
  onEndReached?: () => void
  loadingMore?: boolean
  className?: string
}

function isNumeric(v: Cell): v is number {
  return typeof v === "number"
}

function CellValue({ value }: { value: Cell }) {
  if (value === null) return <span className="italic text-muted-foreground">NULL</span>
  const text = String(value)
  // Rows are fixed-height (virtualized): a cell must never wrap to a second line, or it spills
  // into the absolutely-positioned row below it. Always single-line + ellipsis; the title covers
  // the overflow case (harmless, ignored by the browser, when the text already fits).
  return (
    <span className="block w-full truncate" title={text}>
      {text}
    </span>
  )
}

export function DataGrid({ columns, rows, rowHeight = 34, sort, onSortChange, onEndReached, loadingMore, className }: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endReachedRef = useRef(onEndReached)
  endReachedRef.current = onEndReached

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !endReachedRef.current) return
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) endReachedRef.current?.()
    }
    el.addEventListener("scroll", onScroll)
    onScroll()
    return () => el.removeEventListener("scroll", onScroll)
  }, [rows.length])

  const aligns = useMemo(
    () => columns.map((col, i) => col.align ?? (rows[0] && isNumeric(rows[0][i]) ? "right" : "left")),
    [columns, rows],
  )
  const gridTemplateColumns = useMemo(
    () => columns.map((c) => (c.width ? `${c.width}px` : "minmax(140px, 1fr)")).join(" "),
    [columns],
  )

  return (
    <div ref={scrollRef} className={cn("relative overflow-auto rounded-lg border border-border", className)}>
      <div className="sticky top-0 z-10 grid border-b border-border bg-card" style={{ gridTemplateColumns, minWidth: "100%" }}>
        {columns.map((col, i) => (
          <div key={col.name} className={cn("px-3 py-2 text-xs font-medium text-muted-foreground", aligns[i] === "right" && "text-right")}>
            {col.sortable === false ? (
              <span className="font-mono">{col.label ?? col.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => onSortChange?.(col.name)}
                className={cn(
                  "inline-flex items-center gap-1 font-mono hover:text-foreground",
                  aligns[i] === "right" && "flex-row-reverse",
                  sort?.column === col.name && "text-foreground",
                )}
              >
                {col.label ?? col.name}
                {sort?.column === col.name &&
                  (sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
              </button>
            )}
          </div>
        ))}
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: "100%" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          return (
            <div
              key={item.key}
              className="grid border-b border-border/60 hover:bg-muted/40"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: item.size,
                transform: `translateY(${item.start}px)`,
                gridTemplateColumns,
              }}
            >
              {columns.map((col, i) => (
                <div key={col.name} className={cn("flex min-w-0 items-center px-3 py-1.5 text-sm tabular-nums", aligns[i] === "right" && "justify-end")}>
                  {col.renderCell ? col.renderCell(row[i], item.index) : <CellValue value={row[i]} />}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {loadingMore && <div className="py-2 text-center text-xs text-muted-foreground">Loading more…</div>}
      {rows.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">No rows.</div>}
    </div>
  )
}

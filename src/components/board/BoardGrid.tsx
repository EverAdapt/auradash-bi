/**
 * OWNER: ask-board. The personal dashboard grid: a react-grid-layout set-up (breakpoints lg/md/sm, drag by the card header), built on auradash-bi's `usePins` store. Only the lg
 * (12-column) geometry is persisted; md and sm are derived by react-grid-layout itself. A layout
 * change is applied to the store right away and debounced 400ms before the (already-persisted)
 * write settles, so a flurry of drags is one state update.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "./board.css"
import type { PinLayout } from "@shared/contract"
import { usePins } from "@/state/pins"
import { PinCard } from "./PinCard"

const BREAKPOINTS = { lg: 1100, md: 720, sm: 0 }
const COLS = { lg: 12, md: 8, sm: 2 }
type BP = keyof typeof COLS
const MARGIN = [16, 16] as const
const PADDING = [0, 0] as const
const DRAG_CONFIG = { handle: ".drag-handle", cancel: ".no-drag" }
const SAVE_DELAY_MS = 400
const MIN_W = 2
const MIN_H = 2

const readingOrder = (a: { layout: PinLayout }, b: { layout: PinLayout }) =>
  a.layout.y - b.layout.y || a.layout.x - b.layout.x

export function BoardGrid() {
  const pins = usePins((s) => s.pins)
  const layouts = usePins((s) => s.layouts)
  const focusPinId = usePins((s) => s.focusPinId)
  const clearFocusPin = usePins((s) => s.clearFocusPin)
  const setLayouts = usePins((s) => s.setLayouts)

  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
  })
  const [dragging, setDragging] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLayouts = useRef<Record<string, PinLayout> | null>(null)
  const skipNextChange = useRef(true) // RGL fires onLayoutChange on mount; that's not a user move

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    if (pendingLayouts.current) {
      setLayouts(pendingLayouts.current)
      pendingLayouts.current = null
    }
  }, [setLayouts])
  useEffect(() => () => flush(), [flush])

  const rglLayouts = useMemo<ResponsiveLayouts<BP>>(
    () => ({
      lg: pins.map((pin): LayoutItem => ({
        i: pin.id,
        ...(layouts[pin.id] ?? { x: 0, y: 0, w: 4, h: 6 }),
        minW: MIN_W,
        minH: MIN_H,
      })),
    }),
    [pins, layouts]
  )

  const onLayoutChange = useCallback(
    (_current: Layout, all: ResponsiveLayouts<BP>) => {
      const lg = all.lg
      if (!lg) return
      if (skipNextChange.current) {
        skipNextChange.current = false
        return
      }
      const next: Record<string, PinLayout> = {}
      for (const item of lg)
        next[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h }
      pendingLayouts.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(flush, SAVE_DELAY_MS)
    },
    [flush]
  )

  const onMove = useCallback(
    (pinId: string, direction: -1 | 1) => {
      const ordered = pins
        .map((p) => ({
          id: p.id,
          layout: layouts[p.id] ?? { x: 0, y: 0, w: 4, h: 6 },
        }))
        .sort(readingOrder)
      const index = ordered.findIndex((p) => p.id === pinId)
      const other = ordered[index + direction]
      const self = ordered[index]
      if (!self || !other) return
      setLayouts({
        ...layouts,
        [self.id]: { ...self.layout, x: other.layout.x, y: other.layout.y },
        [other.id]: { ...other.layout, x: self.layout.x, y: self.layout.y },
      })
    },
    [pins, layouts, setLayouts]
  )

  const onResize = useCallback(
    (pinId: string, size: { w: number; h: number }) => {
      const current = layouts[pinId] ?? { x: 0, y: 0, w: 4, h: 6 }
      const w = Math.min(size.w, COLS.lg)
      setLayouts({
        ...layouts,
        [pinId]: {
          ...current,
          w,
          h: size.h,
          x: Math.min(current.x, COLS.lg - w),
        },
      })
    },
    [layouts, setLayouts]
  )

  // Scroll a freshly-pinned card into view once the grid has placed it, then flash it once.
  useEffect(() => {
    if (!focusPinId || !mounted) return
    const handle = window.setTimeout(() => {
      const el = containerRef.current?.querySelector(
        `[data-pin-id="${CSS.escape(focusPinId)}"]`
      )
      el?.scrollIntoView?.({ behavior: "smooth", block: "center" })
      setFlashId(focusPinId)
      clearFocusPin()
    }, 120)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPinId, mounted])
  useEffect(() => {
    if (!flashId) return
    const handle = window.setTimeout(() => setFlashId(null), 1800)
    return () => window.clearTimeout(handle)
  }, [flashId])

  const ordered = useMemo(
    () =>
      [...pins]
        .map((p) => ({
          id: p.id,
          layout: layouts[p.id] ?? { x: 0, y: 0, w: 4, h: 6 },
        }))
        .sort(readingOrder),
    [pins, layouts]
  )

  return (
    <div ref={containerRef} className="dash-board">
      {mounted && (
        <ResponsiveGridLayout<BP>
          width={width}
          layouts={rglLayouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={44}
          margin={MARGIN}
          containerPadding={PADDING}
          dragConfig={DRAG_CONFIG}
          onLayoutChange={onLayoutChange}
          onDragStart={() => setDragging(true)}
          onDragStop={() => setDragging(false)}
          onResizeStart={() => setDragging(true)}
          onResizeStop={() => setDragging(false)}
        >
          {pins.map((pin) => (
            <div
              key={pin.id}
              data-pin-id={pin.id}
              className={
                flashId === pin.id
                  ? "dash-grid-item dash-grid-item-new"
                  : "dash-grid-item"
              }
            >
              <PinCard
                pin={pin}
                layout={layouts[pin.id]}
                isFirst={ordered[0]?.id === pin.id}
                isLast={ordered[ordered.length - 1]?.id === pin.id}
                isDragging={dragging}
                onMove={onMove}
                onResize={onResize}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  )
}

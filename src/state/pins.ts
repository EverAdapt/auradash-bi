/**
 * OWNER: ask-board. The personal dashboard: pinned queries + their grid geometry, persisted in
 * localStorage (zustand persist, key "${STORAGE_PREFIX}:board:v2", debounced by the board's own
 * onLayoutChange handler). The key is versioned so a new curated seed board (see seeds.ts) reaches
 * every visitor, including one who already has a v1 board persisted, rather than silently losing to
 * their old one. Pins hold the query, never the data; the board re-runs each pin's SQL on load.
 * Other workstreams may call `usePins.getState().addPin(...)` (e.g. the explorer's SQL console) —
 * `addPin`, `removePin`, `updatePin` and `setLayouts` keep their wave-0 signatures.
 */
import type { ChartType, Pin, PinLayout } from "@shared/contract"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { chartRegistry } from "@/components/charts"
import { STORAGE_PREFIX } from "@/lib/site"

export type NewPin = Omit<Pin, "id" | "createdAt">

const GRID_COLS = 12
const DEFAULT_SIZE = { w: 4, h: 6 }

function sizeFor(type: ChartType): { w: number; h: number } {
  const size = chartRegistry[type]?.defaultSize ?? DEFAULT_SIZE
  return { w: Math.min(size.w, GRID_COLS), h: size.h }
}

/** New pins land at the top: every existing card's y shifts down by the new card's height. */
function placeAtTop(
  layouts: Record<string, PinLayout>,
  id: string,
  size: { w: number; h: number }
) {
  const next: Record<string, PinLayout> = {}
  for (const [pinId, l] of Object.entries(layouts))
    next[pinId] = { ...l, y: l.y + size.h }
  next[id] = { x: 0, y: 0, w: size.w, h: size.h }
  return next
}

interface PinState {
  pins: Pin[]
  /** lg (12-column) geometry by pin id; md/sm are derived by react-grid-layout */
  layouts: Record<string, PinLayout>
  /** true once localStorage has been read, so the board can tell "empty" from "not loaded yet" */
  hasHydrated: boolean
  /** the board has been seeded (with examples, or emptied by the user) at least once */
  seeded: boolean
  /** a pin that was just added, for the board to scroll to and flash once (not persisted) */
  focusPinId: string | null
  /** returns the new pin id; places it at the top with the chart's default size */
  addPin: (pin: NewPin) => string
  removePin: (id: string) => void
  updatePin: (id: string, patch: Partial<Pin>) => void
  setLayouts: (layouts: Record<string, PinLayout>) => void
  /** re-insert a removed pin at its old layout (the board's Undo toast) */
  restorePin: (pin: Pin, layout: PinLayout | undefined) => void
  clearFocusPin: () => void
  /** replace the board with the seed examples (the "Reset to examples" menu item) */
  resetToExamples: (seed: {
    pins: Pin[]
    layouts: Record<string, PinLayout>
  }) => void
  /** empty the board (the "Clear all" menu item, after confirmation) */
  clearAll: () => void
  /** seed once on a first-ever visit (no persisted board yet); a no-op afterwards */
  seedIfNeeded: (seed: {
    pins: Pin[]
    layouts: Record<string, PinLayout>
  }) => void
  setHasHydrated: (v: boolean) => void
}

let n = 0
const newPinId = () => `pin_${Date.now().toString(36)}_${(n++).toString(36)}`

export const usePins = create<PinState>()(
  persist(
    (set, get) => ({
      pins: [],
      layouts: {},
      hasHydrated: false,
      seeded: false,
      focusPinId: null,

      addPin: (pin) => {
        const id = newPinId()
        const size = sizeFor(pin.chart.type)
        set((s) => ({
          pins: [
            { ...pin, id, createdAt: new Date().toISOString() },
            ...s.pins,
          ],
          layouts: placeAtTop(s.layouts, id, size),
          focusPinId: id,
          seeded: true,
        }))
        return id
      },
      removePin: (id) =>
        set((s) => ({ pins: s.pins.filter((p) => p.id !== id) })),
      updatePin: (id, patch) =>
        set((s) => ({
          pins: s.pins.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      setLayouts: (layouts) => set({ layouts }),
      restorePin: (pin, layout) =>
        set((s) => ({
          pins: s.pins.some((p) => p.id === pin.id) ? s.pins : [...s.pins, pin],
          layouts: layout ? { ...s.layouts, [pin.id]: layout } : s.layouts,
        })),
      clearFocusPin: () => set({ focusPinId: null }),
      resetToExamples: (seed) =>
        set({
          pins: seed.pins,
          layouts: seed.layouts,
          seeded: true,
          focusPinId: null,
        }),
      clearAll: () =>
        set({ pins: [], layouts: {}, seeded: true, focusPinId: null }),
      seedIfNeeded: (seed) => {
        if (get().seeded) return
        set({ pins: seed.pins, layouts: seed.layouts, seeded: true })
      },
      setHasHydrated: (v) => set({ hasHydrated: v }),
    }),
    {
      name: `${STORAGE_PREFIX}:board:v2`,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        pins: s.pins,
        layouts: s.layouts,
        seeded: s.seeded,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true)
      },
    }
  )
)

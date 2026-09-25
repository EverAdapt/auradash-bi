/**
 * OWNER: ask-board. Small cross-cutting UI store: the most recent Jev meta (source/model/latency),
 * read by the shell's status dot, and the command palette's open flag, shared so "/" from anywhere
 * in the app can open it.
 *
 * NOTE on Jev status: `@/lib/jev/status` doesn't exist yet in this worktree (it lands with the
 * planner's merge). Rather than import a module that doesn't exist, the shell reads the latest
 * `JevMeta` held here — set by the ask pipeline after every plan/chart call — via
 * `src/lib/ask/jev-status-shim.ts`. The lead will wire the global status later.
 */
import type { JevMeta } from "@shared/contract"
import { create } from "zustand"

interface UiState {
  /** The most recent Jev call's metadata (plan or chart), for the shell's status dot. */
  lastJevMeta: JevMeta | null
  setLastJevMeta: (meta: JevMeta) => void
  /** "/" on an empty ask box, or "/" anywhere else, opens the command palette. */
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  lastJevMeta: null,
  setLastJevMeta: (meta) => set({ lastJevMeta: meta }),
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}))

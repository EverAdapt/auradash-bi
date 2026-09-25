/**
 * OWNER: data-engine. Which datasets exist and which one the user is asking about.
 * The current dataset is also reflected in the URL (?d=<id>) by the shell.
 */
import type { DatasetId, DatasetInfo } from "@shared/contract"
import { create } from "zustand"
import { deleteDataset, listDatasets } from "@/lib/db"
import { invalidateCatalog } from "@/lib/catalog"

const STORAGE_KEY = "auradash-bi:dataset"
const DEFAULT_ID: DatasetId = "nobel"

/**
 * Initial dataset: a `?d=` in the URL wins (shared links, gallery "Try it"), then the last one
 * used, then Nobel. Seeding from the URL here keeps the store and the URL in agreement from the
 * first render, so no effect ever has to reconcile them on load.
 */
function readStoredId(): DatasetId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("d")
    if (fromUrl) return fromUrl
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_ID
  } catch {
    return DEFAULT_ID
  }
}

function writeStoredId(id: DatasetId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // private browsing / storage disabled: current dataset just won't survive a reload
  }
}

interface DatasetState {
  datasets: DatasetInfo[]
  currentId: DatasetId
  loaded: boolean
  setCurrent: (id: DatasetId) => void
  /** reload the list (bundled + uploads; after an import or delete) */
  refresh: () => Promise<void>
  /** delete an uploaded dataset everywhere (engine storage, catalog cache, this list) */
  removeDataset: (id: DatasetId) => Promise<void>
}

export const useDatasets = create<DatasetState>((set, get) => ({
  datasets: [],
  currentId: readStoredId(),
  loaded: false,
  setCurrent: (id) => {
    writeStoredId(id)
    set({ currentId: id })
  },
  refresh: async () => set({ datasets: await listDatasets(), loaded: true }),
  removeDataset: async (id) => {
    await deleteDataset(id)
    invalidateCatalog(id)
    const datasets = get().datasets.filter((d) => d.id !== id)
    const currentId = get().currentId === id ? DEFAULT_ID : get().currentId
    if (currentId !== get().currentId) writeStoredId(currentId)
    set({ datasets, currentId })
  },
}))

export const currentDataset = (s: DatasetState) => s.datasets.find((d) => d.id === s.currentId)

/** OWNER: data-engine. Small local hooks used across the Explorer page. */
import { useEffect, useState } from "react"
import type { Catalog, DatasetId } from "@shared/contract"
import { getCatalog } from "@/lib/catalog"

interface CatalogState {
  id?: DatasetId
  catalog: Catalog | null
  error: string | null
}

/**
 * Loads a dataset's catalog. `loading`/`catalog`/`error` are derived from comparing the loaded
 * result's dataset id against the one requested — no explicit setState at the top of the effect
 * (only inside the settle callbacks), so switching datasets can't flash stale data.
 */
export function useCatalog(datasetId: DatasetId | undefined) {
  const [state, setState] = useState<CatalogState>({ catalog: null, error: null })

  useEffect(() => {
    if (!datasetId) return
    let cancelled = false
    getCatalog(datasetId)
      .then((c) => {
        if (!cancelled) setState({ id: datasetId, catalog: c, error: null })
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ id: datasetId, catalog: null, error: e instanceof Error ? e.message : "Could not load this dataset's schema." })
      })
    return () => {
      cancelled = true
    }
  }, [datasetId])

  const settled = state.id === datasetId
  return {
    catalog: settled ? state.catalog : null,
    error: settled ? state.error : null,
    loading: datasetId !== undefined && !settled,
  }
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

/**
 * OWNER: charts. Query results come back in long format (one row per x * series pair); Recharts
 * wants wide rows (one row per x, one field per series) to draw multiple Bars/Lines/Areas.
 */
import type { Cell } from "@shared/contract"
import { OTHER_KEY } from "./colors"

export interface Pivoted {
  data: Record<string, Cell>[]
  /** series values in first-seen order — the stable "entity order" colors are assigned from */
  seriesKeys: string[]
}

export function pivotLong(rows: Record<string, Cell>[], xKey: string, seriesKey: string, valueKey: string): Pivoted {
  const xIndex = new Map<Cell, number>()
  const seriesSeen = new Set<string>()
  const seriesKeys: string[] = []
  const data: Record<string, Cell>[] = []

  for (const row of rows) {
    const xVal = row[xKey]
    const sVal = String(row[seriesKey] ?? "")
    if (!seriesSeen.has(sVal)) {
      seriesSeen.add(sVal)
      seriesKeys.push(sVal)
    }
    let idx = xIndex.get(xVal)
    if (idx === undefined) {
      idx = data.length
      xIndex.set(xVal, idx)
      data.push({ [xKey]: xVal })
    }
    data[idx][sVal] = row[valueKey]
  }

  return { data, seriesKeys }
}

/**
 * Collapses folded (past-8th) series into a single summed `__other__` field, so a chart with more
 * than 8 series still renders an honest "Other" bucket instead of a dangling, unpopulated dataKey.
 */
export function foldOthers(pivoted: Pivoted, folded: Set<string>): Pivoted {
  if (folded.size === 0) return pivoted
  const data = pivoted.data.map((row) => {
    const next: Record<string, Cell> = {}
    let sum = 0
    let any = false
    for (const [key, value] of Object.entries(row)) {
      if (folded.has(key)) {
        if (typeof value === "number") {
          sum += value
          any = true
        }
        continue
      }
      next[key] = value
    }
    next[OTHER_KEY] = any ? sum : null
    return next
  })
  return { data, seriesKeys: pivoted.seriesKeys }
}

/** OWNER: charts. Recharts wants an array of plain objects; ResultSet is columnar arrays. */
import type { Cell, ResultSet } from "@shared/contract"

export function toRows(result: ResultSet): Record<string, Cell>[] {
  return result.rows.map((row) => {
    const obj: Record<string, Cell> = {}
    result.columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

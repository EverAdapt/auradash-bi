/** OWNER: data-engine. Pure SQL builders for the Rows tab: paging, sort, search, FK filter chip. */
import type { Cell, CatalogColumn } from "@shared/contract"

export interface RowsQueryInput {
  table: string
  columns: CatalogColumn[]
  search: string
  sort: { column: string; dir: "asc" | "desc" } | null
  where: { column: string; value: string | number } | null
}

function isTextColumn(c: CatalogColumn): boolean {
  return /CHAR|CLOB|TEXT/i.test(c.sqlType) || c.role === "label" || c.role === "dimension" || c.role === "text"
}

function whereClause(input: Pick<RowsQueryInput, "columns" | "search" | "where">): { sql: string; params: Cell[] } {
  const clauses: string[] = []
  const params: Cell[] = []
  if (input.where) {
    clauses.push(`"${input.where.column}" = ?`)
    params.push(input.where.value)
  }
  const term = input.search.trim()
  if (term) {
    const textCols = input.columns.filter(isTextColumn)
    if (textCols.length) {
      clauses.push(`(${textCols.map((c) => `"${c.name}" LIKE ?`).join(" OR ")})`)
      params.push(...textCols.map(() => `%${term}%`))
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params }
}

/** `SELECT * FROM "t" [WHERE ...] [ORDER BY ...] LIMIT ? OFFSET ?`. */
export function buildRowsQuery(input: RowsQueryInput, limit: number, offset: number): { sql: string; params: Cell[] } {
  const where = whereClause(input)
  const order = input.sort ? ` ORDER BY "${input.sort.column}" ${input.sort.dir.toUpperCase()}` : ""
  return { sql: `SELECT * FROM "${input.table}"${where.sql}${order} LIMIT ? OFFSET ?`, params: [...where.params, limit, offset] }
}

/** `SELECT COUNT(*) FROM "t" [WHERE ...]` — the filtered row count shown under the grid. */
export function buildRowsCountQuery(input: Pick<RowsQueryInput, "table" | "columns" | "search" | "where">): { sql: string; params: Cell[] } {
  const where = whereClause(input)
  return { sql: `SELECT COUNT(*) AS n FROM "${input.table}"${where.sql}`, params: where.params }
}

/** Parses `?where=<col>:<value>` — column names never contain `:`, so split on the first one. */
export function parseWhereParam(raw: string | null): { column: string; value: string } | null {
  if (!raw) return null
  const i = raw.indexOf(":")
  if (i < 0) return null
  return { column: raw.slice(0, i), value: raw.slice(i + 1) }
}

export function encodeWhereParam(column: string, value: Cell): string {
  return `${column}:${String(value)}`
}

/** URL query values are strings; coerce numeric-looking ones back so affinity-sensitive equality is exact. */
export function coerceFilterValue(raw: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
}

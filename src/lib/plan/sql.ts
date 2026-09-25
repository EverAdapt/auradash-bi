/**
 * OWNER: lead (read-only for implementers — report a needed change instead). The SQL building
 * blocks every compile module shares: identifier quoting, the bound-parameter list, catalog
 * lookups that throw on unknown keys, and the FK-graph JoinPlanner. Identifiers only ever come
 * from the catalog; values only ever as bound `?` params (ParamList) — code constants (a band
 * label, "(none)") may be inlined with `sqlLiteral`.
 */
import type { Catalog, CatalogColumn, Cell } from "@shared/contract"
import { shortestJoinPath } from "./graph"


export function q(id: string): string {
  return `"${id}"`
}
export function qcol(alias: string, name: string): string {
  return `${alias}.${q(name)}`
}

export class ParamList {
  readonly params: Cell[] = []
  bind(v: Cell): string {
    this.params.push(v)
    return "?"
  }
}

export function catalogColumn(catalog: Catalog, key: string): CatalogColumn {
  const table = key.split(".")[0]!
  const col = catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.key === key)
  if (!col) throw new Error(`compilePlan: unknown column "${key}"`)
  return col
}
export function catalogTable(catalog: Catalog, name: string) {
  const t = catalog.tables.find((x) => x.name === name)
  if (!t) throw new Error(`compilePlan: unknown table "${name}"`)
  return t
}

/** Assigns aliases and emits JOIN clauses. Two alias spaces: by table (structural BFS joins,
 *  INNER) and by FK column (a specific, single-hop "fetch the display name" join, LEFT or INNER). */
export class JoinPlanner {
  private n = 1
  private readonly aliasByTable = new Map<string, string>()
  private readonly aliasByFkColumn = new Map<string, string>()
  /** table -> aliases that reached it via a single-hop FK join (ensureFkJoin) — reused by
   *  ensureTable when unambiguous, so e.g. a rows query's FK display join and a filter on the
   *  same FK-referenced table don't join it twice. */
  private readonly fkAliasesByTable = new Map<string, string[]>()
  readonly clauses: string[] = []
  private readonly catalog: Catalog
  readonly baseTable: string

  constructor(catalog: Catalog, baseTable: string) {
    this.catalog = catalog
    this.baseTable = baseTable
    this.aliasByTable.set(baseTable, "t0")
  }

  private nextAlias(): string {
    return `t${this.n++}`
  }

  /** BFS-join the base to `table` (INNER), reusing the path's intermediate tables. Idempotent. */
  ensureTable(table: string): string {
    const existing = this.aliasByTable.get(table)
    if (existing) return existing
    const viaFk = this.fkAliasesByTable.get(table)
    if (viaFk?.length === 1) {
      this.aliasByTable.set(table, viaFk[0]!)
      return viaFk[0]!
    }
    const path = shortestJoinPath(this.catalog, this.baseTable, table)
    if (!path) throw new Error(`compilePlan: no join path from "${this.baseTable}" to "${table}"`)
    for (const edge of path) {
      if (this.aliasByTable.has(edge.toTable)) continue
      const fromAlias = this.aliasByTable.get(edge.table)!
      const alias = this.nextAlias()
      this.aliasByTable.set(edge.toTable, alias)
      const fromCol = catalogColumn(this.catalog, edge.from).name
      const toCol = catalogColumn(this.catalog, edge.to).name
      this.clauses.push(`JOIN ${q(edge.toTable)} ${alias} ON ${qcol(alias, toCol)} = ${qcol(fromAlias, fromCol)}`)
    }
    return this.aliasByTable.get(table)!
  }

  /** A specific 1-hop join along `fkColumnKey`'s own FK pointer (fetching its display name).
   *  Keyed by the FK column itself, so two different FK columns to the same table (e.g. laureates'
   *  birth_country_code and death_country_code) get distinct aliases. */
  ensureFkJoin(fkColumnKey: string, opts: { left: boolean }): { alias: string; table: string } {
    const existing = this.aliasByFkColumn.get(fkColumnKey)
    const col = catalogColumn(this.catalog, fkColumnKey)
    if (!col.fk) throw new Error(`compilePlan: "${fkColumnKey}" has no fk`)
    const targetTable = col.fk.split(".")[0]!
    if (existing) return { alias: existing, table: targetTable }
    const fromAlias = this.ensureTable(col.table)
    const alias = this.nextAlias()
    this.aliasByFkColumn.set(fkColumnKey, alias)
    const seen = this.fkAliasesByTable.get(targetTable)
    if (seen) seen.push(alias)
    else this.fkAliasesByTable.set(targetTable, [alias])
    const toCol = catalogColumn(this.catalog, col.fk).name
    const kw = opts.left ? "LEFT JOIN" : "JOIN"
    this.clauses.push(`${kw} ${q(targetTable)} ${alias} ON ${qcol(alias, toCol)} = ${qcol(fromAlias, col.name)}`)
    return { alias, table: targetTable }
  }

  aliasOf(table: string): string | undefined {
    return this.aliasByTable.get(table)
  }

  /** Like `ensureTable`, but returns undefined instead of throwing when `table` is unreachable —
   *  for a low-confidence plan whose rowTable/filters/group_by answers don't structurally agree
   *  (e.g. Jev picking both `rowTable: regions` and a filter that only makes sense from
   *  aggregate_year), a single unusable filter shouldn't crash the whole query. */
  tryEnsureTable(table: string): string | undefined {
    if (this.aliasByTable.has(table) || this.fkAliasesByTable.get(table)?.length === 1) return this.ensureTable(table)
    return shortestJoinPath(this.catalog, this.baseTable, table) ? this.ensureTable(table) : undefined
  }
}

/** A SQL literal for a CODE constant (never for a value that came from the question — bind those). */
export function sqlLiteral(v: Cell): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL"
  return `'${String(v).replace(/'/g, "''")}'`
}

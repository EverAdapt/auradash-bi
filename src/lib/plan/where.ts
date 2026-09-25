/**
 * OWNER: implementer A (filters). WHERE and HAVING: turns `PlanFilter`s and `HavingFilter`s into
 * SQL conditions over the JoinPlanner's aliases, binding every value. compile.ts calls
 * `buildWhere` (all plan filters, AND-ed; OR groups inside parentheses), `buildHaving` (grouped
 * aggregates only) and `buildCondition` (one filter — also used to build a share's CASE WHEN).
 */
import type { Catalog, CatalogColumn, HavingFilter, PlanFilter } from "@shared/contract"
import { catalogColumn, type JoinPlanner, type ParamList, q, qcol } from "./sql"

/** The straightforward ops: bind every value in order, then this text after the column. Every
 *  other op (is_null/not_null/like/within/neq/not_in) needs its own clause shape and is handled
 *  directly in buildCondition/buildHaving below. */
function opSql(op: "in" | "eq" | "gte" | "lte" | "gt" | "lt" | "between", count: number): string {
  switch (op) {
    case "in":
      return `IN (${new Array(count).fill("?").join(", ")})`
    case "eq":
      return "= ?"
    case "gte":
      return ">= ?"
    case "lte":
      return "<= ?"
    case "gt":
      return "> ?"
    case "lt":
      return "< ?"
    case "between":
      return "BETWEEN ? AND ?"
  }
}

/** Escapes a LIKE fragment's own `%`, `_` and `\` (backslash first, so the escapes just added are
 *  never themselves re-escaped) so the value can never be read as a wildcard. Paired with
 *  `LIKE ? ESCAPE '\'` in buildCondition. SQLite's LIKE is ASCII case-insensitive by default. */
function escapeLikeFragment(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

/**
 * `within` (a relative period, `PlanFilter.period`) is always anchored to the LATEST value the
 * column itself has, never today's date — the bundled datasets are historical, so "last 10 years"
 * of World is 2015-2024, not 2016-2026. An integer 'time' column (a plain year) uses arithmetic; a
 * real 'date' column uses SQLite's date()/strftime() with a relative modifier; ytd anchors to
 * January 1st of the latest year present.
 */
function buildWithinClause(colExpr: string, col: CatalogColumn, f: PlanFilter, params: ParamList): string {
  const period = f.period!
  const latest = `(SELECT MAX(${q(col.name)}) FROM ${q(col.table)})`

  if (col.role !== "date") {
    // Integer year column — decade periods already arrive here as n=10, unit="year" (candidates.ts
    // converts "the last decade" up front), so no separate decade case is needed.
    params.bind(period.n)
    return `${colExpr} > ${latest} - ?`
  }
  if (period.unit === "ytd") {
    return `${colExpr} >= strftime('%Y-01-01', ${latest})`
  }
  const modifier =
    period.unit === "week"
      ? `-${period.n * 7} days`
      : period.unit === "day"
        ? `-${period.n} days`
        : period.unit === "quarter"
          ? `-${period.n * 3} months`
          : period.unit === "month"
            ? `-${period.n} months`
            : `-${period.n} years`
  params.bind(modifier)
  return `${colExpr} >= date(${latest}, ?)`
}

/**
 * A filter whose value's table plays several roles in the fact (`PlanFilter.via`, one FK column
 * key per role Jev could mean, or all of them for "any" — see interpret.ts's buildFilters and
 * graph.ts's fkRoleGroupFor): matches through those specific FK columns instead of the single
 * default join path, e.g. for AFL's `home_club_id`/`away_club_id` roles —
 *   (t0."home_club_id" IN (SELECT "club_id" FROM "clubs" WHERE "name" IN (?))
 *    OR t0."away_club_id" IN (SELECT "club_id" FROM "clubs" WHERE "name" IN (?)))
 * — joining the FK columns' own table into the main query first when it isn't already there
 * (`jp.tryEnsureTable`), and dropping (never crashing on) a role whose table the plan's base
 * cannot reach. `not_in` wraps the whole OR in NOT, matching "not any of these roles" (De Morgan).
 */
function buildViaClause(catalog: Catalog, jp: JoinPlanner, f: PlanFilter, params: ParamList): string | undefined {
  const valueCol = catalogColumn(catalog, f.column)
  const parts: string[] = []
  for (const fkKey of f.via!) {
    const fkCol = catalogColumn(catalog, fkKey)
    if (!fkCol.fk) continue
    const targetTable = fkCol.fk.split(".")[0]!
    if (valueCol.table !== targetTable) continue // defensive: roles are only ever built for the FK's own target table
    const alias = jp.tryEnsureTable(fkCol.table)
    if (!alias) continue
    const targetPk = catalogColumn(catalog, fkCol.fk)
    const placeholders = f.values.map(() => "?").join(", ")
    for (const v of f.values) params.bind(v)
    const sub = `SELECT ${q(targetPk.name)} FROM ${q(targetTable)} WHERE ${q(valueCol.name)} IN (${placeholders})`
    parts.push(`${qcol(alias, fkCol.name)} IN (${sub})`)
  }
  if (!parts.length) return undefined
  const membership = parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0]!
  return f.op === "not_in" ? `NOT ${membership}` : membership
}

/** One filter as a SQL condition (values bound in order), or undefined when its column cannot be
 *  reached from the plan's base table (a low-confidence / self-contradictory plan) — dropped, not
 *  a crash. Also used directly by B's share SQL to build the numerator's CASE WHEN condition. */
export function buildCondition(catalog: Catalog, jp: JoinPlanner, f: PlanFilter, params: ParamList): string | undefined {
  if (f.via?.length) return buildViaClause(catalog, jp, f, params) // undefined: no reachable role at all
  const col = catalogColumn(catalog, f.column)
  const alias = jp.tryEnsureTable(col.table)
  if (!alias) return undefined
  const colExpr = qcol(alias, col.name)

  if (f.op === "is_null") return `${colExpr} IS NULL`
  if (f.op === "not_null") return `${colExpr} IS NOT NULL`

  if (f.op === "like") {
    const escaped = escapeLikeFragment(String(f.values[0] ?? ""))
    const pattern = f.pattern === "starts" ? `${escaped}%` : f.pattern === "ends" ? `%${escaped}` : f.pattern === "exact" ? escaped : `%${escaped}%`
    params.bind(pattern)
    return `${colExpr} LIKE ? ESCAPE '\\'`
  }

  if (f.op === "within") return buildWithinClause(colExpr, col, f, params)

  // neq / not_in keep NULL rows: excluding a value must not silently drop rows that never had one
  // ("excluding literature" still shows a prize with no category recorded).
  if (f.op === "neq") {
    params.bind(f.values[0] ?? null)
    return `(${colExpr} <> ? OR ${colExpr} IS NULL)`
  }
  if (f.op === "not_in") {
    for (const v of f.values) params.bind(v)
    return `(${colExpr} NOT IN (${new Array(f.values.length).fill("?").join(", ")}) OR ${colExpr} IS NULL)`
  }

  for (const v of f.values) params.bind(v)
  return `${colExpr} ${opSql(f.op, f.values.length)}`
}

/** Every plan filter as WHERE clauses (the caller AND-s them). Filters sharing `PlanFilter.group`
 *  become one `(c1 OR c2)` clause instead, in the group's first-encountered position — filters are
 *  walked in their original array order throughout, so params stay bound in exact text order. */
export function buildWhere(catalog: Catalog, jp: JoinPlanner, filters: PlanFilter[], params: ParamList): string[] {
  const clauses: string[] = []
  const emittedGroups = new Set<string>()
  for (const f of filters) {
    if (f.group) {
      if (emittedGroups.has(f.group)) continue
      emittedGroups.add(f.group)
      const parts: string[] = []
      for (const member of filters) {
        if (member.group !== f.group) continue
        const clause = buildCondition(catalog, jp, member, params)
        if (clause) parts.push(clause)
      }
      if (parts.length === 1) clauses.push(parts[0]!)
      else if (parts.length > 1) clauses.push(`(${parts.join(" OR ")})`)
      continue
    }
    const clause = buildCondition(catalog, jp, f, params)
    if (clause) clauses.push(clause)
  }
  return clauses
}

/** HAVING clauses over the aggregated measure expression `measureExpr` (the caller AND-s them). */
export function buildHaving(having: HavingFilter[] | undefined, measureExpr: string, params: ParamList): string[] {
  if (!having?.length) return []
  const clauses: string[] = []
  for (const h of having) {
    if (h.op === "between") {
      params.bind(h.values[0]!)
      params.bind(h.values[1]!)
      clauses.push(`${measureExpr} BETWEEN ? AND ?`)
      continue
    }
    params.bind(h.values[0]!)
    clauses.push(`${measureExpr} ${opSql(h.op, 1)}`)
  }
  return clauses
}

/**
 * OWNER: planner. FK-graph utilities over `catalog.joins`, shared by candidates.ts (disambiguate a
 * value that exists in several columns), request.ts (resolve an FK column's referenced display
 * column, find the default fact's time column) and compile.ts (join path from the base table to
 * every table a plan touches).
 */
import type { Catalog, CatalogJoin, CatalogTable } from "@shared/contract"

/** A pure fk/id bridge table (e.g. Nobel's `award_affiliations`) with no identity of its own —
 *  safe to route a join path through. A table with real dimension/label columns (e.g.
 *  `countries`) is not: two facts sharing the same country doesn't mean they're related. */
export function isJunctionTable(t: CatalogTable): boolean {
  return t.columns.length > 0 && t.columns.every((c) => c.role === "fk" || c.role === "id" || c.role === "hidden")
}

export interface JoinEdge {
  /** table this edge is stepping FROM */
  table: string
  /** table this edge is stepping TO */
  toTable: string
  /** column key on `table` */
  from: string
  /** column key on `toTable` */
  to: string
  kind: CatalogJoin["kind"]
  /** true when this traversal climbs from the "many" side to the "one" side (as declared) —
   *  false when it's the reverse (fanning back OUT from a "one" side dimension). */
  ascending: boolean
}

const graphCache = new WeakMap<Catalog, Map<string, JoinEdge[]>>()

/** Undirected adjacency, built once per catalog and cached by object identity. */
export function buildJoinGraph(catalog: Catalog): Map<string, JoinEdge[]> {
  const cached = graphCache.get(catalog)
  if (cached) return cached
  const graph = new Map<string, JoinEdge[]>()
  const add = (table: string, edge: JoinEdge) => {
    const list = graph.get(table)
    if (list) list.push(edge)
    else graph.set(table, [edge])
  }
  for (const j of catalog.joins) {
    const fromTable = j.from.split(".")[0]!
    const toTable = j.to.split(".")[0]!
    // Declared "from" is the many side for a many-to-one join, so that direction always climbs.
    // Its reverse (to -> from) descends back out — except one-to-one, which has no hierarchy.
    add(fromTable, { table: fromTable, toTable, from: j.from, to: j.to, kind: j.kind, ascending: true })
    add(toTable, { table: toTable, toTable: fromTable, from: j.to, to: j.from, kind: j.kind, ascending: j.kind === "one-to-one" })
  }
  graphCache.set(catalog, graph)
  return graph
}

/** BFS hop-count from `start` table to every table reachable through joins (start itself = 0). */
export function tableDistances(catalog: Catalog, start: string): Map<string, number> {
  const graph = buildJoinGraph(catalog)
  const dist = new Map<string, number>([[start, 0]])
  const queue = [start]
  let head = 0
  while (head < queue.length) {
    const t = queue[head++]!
    const d = dist.get(t)!
    for (const edge of graph.get(t) ?? []) {
      if (!dist.has(edge.toTable)) {
        dist.set(edge.toTable, d + 1)
        queue.push(edge.toTable)
      }
    }
  }
  return dist
}

/**
 * Shortest path of join edges from `start` to `target`. `buildJoinGraph` adds edges in
 * `catalog.joins` declaration order, and BFS marks a state visited the first time it's
 * discovered, so when two joins link the same table pair (e.g. laureates.birth_country_code and
 * laureates.death_country_code both to countries) the first declared one wins ties.
 *
 * Once the path climbs a many-to-one edge (e.g. laureates -> countries), it may only keep
 * climbing (countries -> regions), never descend back out through a *different* many-to-one edge
 * (countries -> affiliations) — that would connect two facts merely because they share the same
 * country, which doesn't make them related. Descending is only fine before any climb (a table can
 * still reach its own "many" side rows, e.g. countries -> country_year, from the start). Each
 * (table, hasClimbed) pair is tracked separately so both kinds of path stay available.
 *
 * Returns `[]` when start === target, `null` when the target is unreachable.
 */
export function shortestJoinPath(catalog: Catalog, start: string, target: string): JoinEdge[] | null {
  if (start === target) return []
  const graph = buildJoinGraph(catalog)
  type State = { table: string; climbed: boolean }
  const key = (s: State) => `${s.table}|${s.climbed}`
  const prev = new Map<string, { from: State; edge: JoinEdge }>()
  const start0: State = { table: start, climbed: false }
  const visited = new Set([key(start0)])
  const queue: State[] = [start0]
  let head = 0
  let found: State | undefined
  while (head < queue.length) {
    const s = queue[head++]!
    if (s.table === target) {
      found = s
      break
    }
    for (const edge of graph.get(s.table) ?? []) {
      if (!edge.ascending && s.climbed) continue // no descending after a climb
      const next: State = { table: edge.toTable, climbed: s.climbed || edge.ascending }
      const k = key(next)
      if (visited.has(k)) continue
      visited.add(k)
      prev.set(k, { from: s, edge })
      queue.push(next)
    }
  }
  if (!found) return null
  const path: JoinEdge[] = []
  let cur = found
  while (cur.table !== start || cur.climbed !== start0.climbed) {
    const p = prev.get(key(cur))
    if (!p) return null
    path.unshift(p.edge)
    cur = p.from
  }
  return path
}

/** True when `table` has no join edges at all (e.g. a standalone metadata/lookup table like
 *  World's `indicators`) — such a table can only ever be its own query base, never a filter or
 *  group-by target for a different base table. Only meaningful when the catalog HAS joins
 *  elsewhere: a dataset with none at all (a single flat CSV table, most naming-convention-free
 *  uploads) makes every table trivially "isolated" by this same test, but there is no "rest of the
 *  schema" for it to be irrelevant to — it's simply the only table there is. Callers that use this
 *  to exclude a table from filter/group-by candidates (request.ts's buildDimensions,
 *  candidates.ts's value index) should gate it behind `hasAnyJoins` for exactly that reason.
 */
export function isIsolatedTable(catalog: Catalog, table: string): boolean {
  const edges = buildJoinGraph(catalog).get(table)
  return !edges || edges.length === 0
}

/** Whether the catalog has any join at all — see `isIsolatedTable`'s doc comment. */
export function hasAnyJoins(catalog: Catalog): boolean {
  return catalog.joins.length > 0
}

export interface FkRole {
  /** FK column key on the source ("many") table, e.g. "matches.home_club_id" */
  key: string
  /** that column's own catalog label, e.g. "Home team" */
  label: string
  /** v0.2: the FK column's own catalog synonyms ("won", "beat", "victor"), capped at 12 — wording
   *  hints for the role question (shared/jev/questions-filters.ts), carried on
   *  FilterCandidate.roles[].synonyms so no English vocabulary is hard-coded in the planner. */
  synonyms?: string[]
}

const MAX_ROLE_SYNONYMS = 12

const fkRoleCache = new WeakMap<Catalog, Map<string, FkRole[] | null>>()

function humanizeFkLabel(columnKey: string): string {
  return columnKey
    .split(".")
    .pop()!
    .replace(/_id$/, "")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
}

/**
 * When `targetTable` (e.g. AFL's `clubs`) is reachable from some OTHER table through TWO OR MORE
 * distinct many-to-one FK columns (e.g. `matches.home_club_id`/`away_club_id`/`winner_club_id`/
 * `loser_club_id`), a value living in `targetTable` can play any of several ROLES in a row of that
 * other table. The single default join path (`shortestJoinPath`'s first-declared-edge tie-break)
 * can only ever pick ONE of them, silently, which is wrong whenever the question means a
 * different one (a filter on "Fremantle" resolving through the winner-only path even for "played
 * in", not "won"). This returns one `{ key, label }` per FK column of the richest such source
 * table: when several tables each link to `targetTable` several ways (AFL's `seasons` also has 3
 * club roles: premier/runner-up/minor-premier), the one with the MOST role columns wins — the more
 * roles a table carries to the same target, the more clearly it is the "fact" whose rows each
 * involve `targetTable` in several distinct ways — ties prefer `catalog.defaultFact`, then
 * declaration order. Returns undefined when `targetTable` is reached at most once from every
 * table. Used by candidates.ts to attach `FilterCandidate.roles` to a value found in `targetTable`.
 */
export function fkRoleGroupFor(catalog: Catalog, targetTable: string): FkRole[] | undefined {
  let cache = fkRoleCache.get(catalog)
  if (!cache) {
    cache = new Map()
    fkRoleCache.set(catalog, cache)
  }
  const cached = cache.get(targetTable)
  if (cached !== undefined) return cached ?? undefined

  const groups = new Map<string, FkRole[]>()
  for (const j of catalog.joins) {
    if (j.kind !== "many-to-one") continue
    if (j.to.split(".")[0]! !== targetTable) continue
    const fromTable = j.from.split(".")[0]!
    const col = catalog.tables.find((t) => t.name === fromTable)?.columns.find((c) => c.key === j.from)
    const list = groups.get(fromTable) ?? []
    const synonyms = col?.synonyms.length ? col.synonyms.slice(0, MAX_ROLE_SYNONYMS) : undefined
    list.push({ key: j.from, label: col?.label ?? humanizeFkLabel(j.from), synonyms })
    groups.set(fromTable, list)
  }

  let best: { fromTable: string; roles: FkRole[] } | undefined
  for (const [fromTable, roles] of groups) {
    if (roles.length < 2) continue
    if (!best || roles.length > best.roles.length || (roles.length === best.roles.length && fromTable === catalog.defaultFact)) {
      best = { fromTable, roles }
    }
  }
  cache.set(targetTable, best?.roles ?? null)
  return best?.roles
}

/** birth_/death_/founded_ time columns describe an entity's own lifecycle, not "when the thing
 *  being counted happened" — deprioritise them against an event-table's own time column (e.g.
 *  prizes.award_year over laureates.birth_year when both are equally reachable). */
const DEMOGRAPHIC_TIME = /^(birth|death|founded)_/

/** The best column with role 'time' or 'date' on `table` (demographic columns last), or undefined.
 *  A 'date' role (uploads: a DATE/DATETIME/TIMESTAMP column, or one that looks like one) is just
 *  as good a time axis as an integer 'time' year column — request.ts's buildTimeGrains reads which
 *  role won to decide whether month/quarter/day buckets are on offer. */
export function timeColumnOf(catalog: Catalog, table: string): { key: string; grain: string } | undefined {
  const t = catalog.tables.find((x) => x.name === table)
  const candidates = t?.columns.filter((c) => (c.role === "time" || c.role === "date") && c.grain !== "decade") ?? []
  const col = candidates.find((c) => !DEMOGRAPHIC_TIME.test(c.name)) ?? candidates[0]
  if (!col) return undefined
  return { key: col.key, grain: col.grain ?? "year" }
}

/**
 * The nearest time column reachable from `startTable` by BFS (distance 0 = the table itself,
 * demographic columns penalised so a tie prefers the event's own time column), used to resolve
 * the "default fact's time column" for year filter candidates and the fact-table time grains in
 * request.ts.
 */
export function nearestTimeColumn(catalog: Catalog, startTable: string): { key: string; grain: string } | undefined {
  const dist = tableDistances(catalog, startTable)
  let best: { key: string; grain: string; score: number } | undefined
  for (const t of catalog.tables) {
    if (t.hidden) continue
    const d = dist.get(t.name)
    if (d === undefined) continue
    const col = timeColumnOf(catalog, t.name)
    if (!col) continue
    const score = d + (DEMOGRAPHIC_TIME.test(col.key.split(".").pop()!) ? 0.5 : 0)
    if (!best || score < best.score) best = { ...col, score }
  }
  return best ? { key: best.key, grain: best.grain } : undefined
}

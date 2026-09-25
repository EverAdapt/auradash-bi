/**
 * OWNER: implementer C (agnostic). The ONE place dataset-specific compile behaviour is applied —
 * a generic engine over the catalog's own declarative data (`catalog.planRules`,
 * `catalog.relationship`, `catalog.groupLabels`, from data/<id>.semantic.json). No dataset id,
 * table name or column-name regex is hard-coded here: every rule reads a pattern, a column key or
 * a column name that the semantic layer supplied. An upload (no `planRules`) makes every function
 * below a no-op, so `applyPlanRules` just returns the plan unchanged.
 *
 * compile.ts only ever calls the five functions exported below.
 */
import type { Catalog, CatalogColumn, PlanFilter, PlanRule, QueryPlan } from "@shared/contract"

// ─────────────────────────────── shared helpers ───────────────────────────────

function hasFilterOn(filters: PlanFilter[], column: string): boolean {
  return filters.some((f) => f.column === column)
}

function toPlanFilter(rf: Extract<PlanRule, { kind: "require_filter" }>["filter"]): PlanFilter {
  return { column: rf.column, op: rf.op, values: rf.values, label: rf.label }
}

function findRollupRule(catalog: Catalog): Extract<PlanRule, { kind: "rollup" }> | undefined {
  return catalog.planRules?.find((r): r is Extract<PlanRule, { kind: "rollup" }> => r.kind === "rollup")
}

function catalogColumn(catalog: Catalog, key: string): CatalogColumn | undefined {
  return catalog.tables.find((t) => t.name === key.split(".")[0])?.columns.find((c) => c.key === key)
}

// ─────────────────────────────── require_filter ───────────────────────────────

/** `when` matched against the plan's measure/measure2/groupBy/rowTable — a value-agnostic way to
 *  say "this plan touches a column/measure this pattern names" (a bare column key for groupBy, or
 *  a substring of a "c:table.col:agg"/"n:table" measure key — see the semantic layer's own regexes). */
function applyRequireFilter(rule: Extract<PlanRule, { kind: "require_filter" }>, plan: QueryPlan): QueryPlan {
  const re = new RegExp(rule.when)
  const touches = [plan.measure, plan.measure2, plan.groupBy, plan.rowTable].some((v) => v !== undefined && re.test(v))
  if (!touches || hasFilterOn(plan.filters, rule.filter.column)) return plan
  return { ...plan, filters: [...plan.filters, toPlanFilter(rule.filter)] }
}

// ─────────────────────────────── rollup ───────────────────────────────

/** Reroutes every `from.column` key (wherever it appears — inside a bare column key, or embedded
 *  in a "c:from.col:agg" measure key) to the same-named column on `to`. Column names are assumed
 *  identical on both tables (a rollup table inheriting/duplicating the fact's own measures). */
function rerouteKey(key: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return key.replace(new RegExp(`\\b${escaped}\\.`, "g"), `${to}.`)
}

function rerouteToTarget(plan: QueryPlan, from: string, to: string): QueryPlan {
  return {
    ...plan,
    measure: plan.measure ? rerouteKey(plan.measure, from, to) : plan.measure,
    measure2: plan.measure2 ? rerouteKey(plan.measure2, from, to) : plan.measure2,
    // v0.2: a rate's divisor and a share's column read the same rows as the measure
    per: plan.per ? rerouteKey(plan.per, from, to) : plan.per,
    share: plan.share ? { ...plan.share, column: rerouteKey(plan.share.column, from, to) } : plan.share,
    time: plan.time ? { ...plan.time, column: rerouteKey(plan.time.column, from, to) } : plan.time,
    filters: plan.filters.map((f) => ({ ...f, column: rerouteKey(f.column, from, to) })),
    having: plan.having,
  }
}

/** Whether a "c:<colKey>:<agg>" measure reads a column that lives on `table`. */
function measureReadsFromTable(key: string | undefined, table: string): boolean {
  if (!key?.startsWith("c:")) return false
  const rest = key.slice(2)
  const colKey = rest.slice(0, rest.lastIndexOf(":"))
  return colKey.startsWith(`${table}.`)
}

/** A plain ungrouped total (no measure2, no groupBy) whose measure reads a `from`-table column,
 *  with nothing narrowing it to one specific entity (a country, say) — see `rollup.total`. */
function isTotalCase(plan: QueryPlan, from: string, total: NonNullable<Extract<PlanRule, { kind: "rollup" }>["total"]>): boolean {
  if (plan.kind !== "aggregate" || plan.groupBy || plan.measure2) return false
  // v0.2: a share or a rate is computed across the individual entity rows (e.g. one place's share
  // of the whole), which the single precomputed total row cannot provide.
  if (plan.share || plan.per) return false
  if (!measureReadsFromTable(plan.measure, from)) return false
  return !plan.filters.some((f) => total.entityTables.includes(f.column.split(".")[0]!) || (total.entityColumns?.includes(f.column) ?? false))
}

function applyRollup(rule: Extract<PlanRule, { kind: "rollup" }>, plan: QueryPlan): QueryPlan {
  const groupTable = plan.groupBy?.split(".")[0]
  const matchedGroup = rule.groups.find((g) => g.table === groupTable)
  const filtersTargetRollup = plan.filters.some((f) => rule.filterTables.includes(f.column.split(".")[0]!))

  if (matchedGroup || filtersTargetRollup) {
    let next = rerouteToTarget(plan, rule.from, rule.to)
    if (matchedGroup) {
      const needsFilter = matchedGroup.filter && !hasFilterOn(next.filters, matchedGroup.filter.column)
      next = { ...next, groupBy: matchedGroup.groupBy, filters: needsFilter ? [...next.filters, toPlanFilter(matchedGroup.filter!)] : next.filters }
    }
    return next
  }

  if (rule.total && isTotalCase(plan, rule.from, rule.total)) {
    let next = rerouteToTarget(plan, rule.from, rule.to)
    if (!hasFilterOn(next.filters, rule.total.filter.column)) next = { ...next, filters: [...next.filters, toPlanFilter(rule.total.filter)] }
    return next
  }

  return plan
}

// ─────────────────────────────── default_latest_year ───────────────────────────────

function timeColumnFor(catalog: Catalog, table: string): string | undefined {
  return catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.role === "time" && c.grain === "year")?.key
}

/** The table a "c:<colKey>:<agg>" or "n:<table>" measure key reads from (undefined for "m:" metric
 *  keys and curated aggregates, which don't name a plain column this rule can find a year on). */
function baseTableOfMeasure(key: string | undefined): string | undefined {
  if (!key) return undefined
  if (key.startsWith("c:")) {
    const rest = key.slice(2)
    return rest.slice(0, rest.lastIndexOf(":")).split(".")[0]
  }
  if (key.startsWith("n:")) return key.slice(2)
  return undefined
}

/** Min `latestYear` across measure + measure2's own "c:" columns (a relationship chart's default
 *  year is the older of its two measures' coverage). */
function latestYearAcross(catalog: Catalog, ...keys: (string | undefined)[]): number | undefined {
  let min: number | undefined
  for (const key of keys) {
    if (!key?.startsWith("c:")) continue
    const rest = key.slice(2)
    const colKey = rest.slice(0, rest.lastIndexOf(":"))
    const col = catalogColumn(catalog, colKey)
    if (col?.latestYear !== undefined) min = min === undefined ? col.latestYear : Math.min(min, col.latestYear)
  }
  return min
}

/** No explicit time axis and no year filter on the base table -> pin to the measure's own latest
 *  well-covered year, falling back to the rollup's `from` table's year column when the (already
 *  rerouted) base table has none of its own. */
function applyDefaultLatestYear(plan: QueryPlan, catalog: Catalog): QueryPlan {
  if (plan.time) return plan
  const baseTable = baseTableOfMeasure(plan.measure)
  if (!baseTable) return plan
  const rollup = findRollupRule(catalog)
  const timeCol = timeColumnFor(catalog, baseTable) ?? (rollup ? timeColumnFor(catalog, rollup.from) : undefined)
  if (!timeCol || hasFilterOn(plan.filters, timeCol)) return plan
  const year = latestYearAcross(catalog, plan.measure, plan.measure2)
  if (year === undefined) return plan
  return { ...plan, filters: [...plan.filters, { column: timeCol, op: "eq", values: [year], label: `Year is ${year}` }] }
}

// ─────────────────────────────── the engine ───────────────────────────────

/** Rewrites the plan with the dataset's own `planRules`, in order: each rule sees the plan the
 *  previous one produced (a `rollup` reroute must run before `default_latest_year` reads the
 *  rerouted measure's table, for instance — the semantic layer lists them in that order). Absent
 *  `planRules` (an upload has none) makes this a no-op. */
export function applyPlanRules(plan: QueryPlan, catalog: Catalog): QueryPlan {
  let next = plan
  for (const rule of catalog.planRules ?? []) {
    if (rule.kind === "require_filter") next = applyRequireFilter(rule, next)
    else if (rule.kind === "rollup") next = applyRollup(rule, next)
    else if (rule.kind === "default_latest_year") next = applyDefaultLatestYear(next, catalog)
  }
  return next
}

/** The "one dot per ..." dimension key of a relationship (measure vs measure2) chart, if the
 *  catalog names one — but only while `baseTable` is still the entity-grained fact: once a rollup
 *  has rerouted the base off `catalog.relationship.entity`'s own home table (a group-level chart,
 *  whose entity is the group itself, carried as `plan.groupBy` instead), this steps aside and
 *  returns undefined so the caller falls back to `plan.groupBy`. A dataset with no rollup rule at
 *  all (Nobel: relationship charts are always laureate-grained) applies the entity unconditionally. */
export function relationshipEntity(catalog: Catalog, baseTable: string): string | undefined {
  const entity = catalog.relationship?.entity
  if (!entity) return undefined
  const rollup = findRollupRule(catalog)
  if (rollup && baseTable !== rollup.from) return undefined
  return catalog.tables.some((t) => t.name === entity.split(".")[0]) ? entity : undefined
}

/** The measure column that sizes a relationship chart's dots (bubble): a measure-role column named
 *  `catalog.relationship.size` on the entity's own table, else the measure's fact table (the same
 *  column name can live on both a rollup's `to` table and its `from` table). */
export function relationshipSize(catalog: Catalog, entityTable: string, measureTable: string): CatalogColumn | undefined {
  const name = catalog.relationship?.size
  if (!name) return undefined
  const find = (table: string) => catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.role === "measure" && c.name === name)
  return find(entityTable) ?? find(measureTable)
}

/** The FK column (on the entity's own table) whose target's display name colours a relationship
 *  chart's dots — the FK column named `catalog.relationship.color`. */
export function relationshipColorFk(catalog: Catalog, entityTable: string): CatalogColumn | undefined {
  const name = catalog.relationship?.color
  if (!name) return undefined
  return catalog.tables.find((t) => t.name === entityTable)?.columns.find((c) => c.role === "fk" && c.name === name)
}

/** A shared lookup table's own label ("Group") is too generic once a discriminator filter narrows
 *  it to one flavour — `catalog.groupLabels` says what to call it instead ("Region", "Income
 *  group"), keyed by the discriminator VALUE the plan is filtered to. */
export function groupLabelFor(catalog: Catalog, plan: QueryPlan, fallback: string | undefined): string | undefined {
  if (!plan.groupBy || !catalog.groupLabels) return fallback
  const table = catalogColumn(catalog, plan.groupBy)?.table
  if (!table) return fallback
  for (const f of plan.filters) {
    if (f.op !== "eq" && f.op !== "in") continue
    const col = catalogColumn(catalog, f.column)
    if (!col || col.table !== table || col.role !== "dimension" || f.values.length !== 1) continue
    const nice = catalog.groupLabels[String(f.values[0])]
    if (nice) return nice
  }
  return fallback
}

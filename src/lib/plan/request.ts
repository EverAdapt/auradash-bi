/**
 * OWNER: planner. Turns a catalog + the candidates found in a question into a `PlanRequest`:
 * every option Jev is allowed to pick from, all derived from the schema (never hand-written per
 * dataset). Option keys are a small contract of their own, read back by interpret.ts/compile.ts:
 *
 *   measure    "m:<metricKey>"            catalog metric
 *              "c:<table.col>:<agg>"      a measure-role column, aggregated with <agg>
 *              "n:<table>"                COUNT(*) of a visible, non-junction table
 *   dimension  "<table.col>"              a dimension/label/geo_code column (FK columns are
 *                                         replaced by the referenced table's display column)
 */
import type { Catalog, CatalogColumn, CatalogMetric, CatalogTable, FilterCandidate, OptionText, PlanRequest, TimeGrain } from "@shared/contract"
import { MAX_OPTION_EXAMPLES } from "@shared/validate"
import { isJunctionTable, nearestTimeColumn, tableDistances } from "./graph"
import { capitalizeFirst, isGenericDisplayName, singularizeLabel } from "./normalize"

// `Candidates` is not exported by the contract (it's a planner-internal shape); re-declare the
// narrow bit request.ts needs so this module only imports real contract types.
type CandidatesLike = { filters: FilterCandidate[]; numbers: string[] } & Partial<Pick<PlanRequest, "thresholds" | "texts" | "orPairs" | "rankWindows" | "cues">>

const MAX_OPTIONS = 254
const SAMPLE_VALUES = 3

function sampleValuesFor(catalog: Catalog, columnKey: string, n = SAMPLE_VALUES): string[] {
  const out: string[] = []
  for (const v of catalog.values) {
    if (v.column !== columnKey) continue
    out.push(v.display ?? v.value)
    if (out.length >= n) break
  }
  return out
}

/** The column a dimension option should key off: itself, or its FK target's display column. */
function resolveDimensionTarget(catalog: Catalog, col: CatalogColumn): { key: string; table: CatalogTable; column: CatalogColumn } | null {
  if (col.role !== "fk") return { key: col.key, table: catalog.tables.find((t) => t.name === col.table)!, column: col }
  if (!col.fk) return null
  const refTable = col.fk.split(".")[0]!
  const t = catalog.tables.find((x) => x.name === refTable)
  if (!t) return null
  const displayCol = t.columns.find((c) => c.name === t.display) ?? t.columns.find((c) => c.role === "dimension" || c.role === "label")
  if (!displayCol) return null
  return { key: displayCol.key, table: t, column: displayCol }
}

/** A table IS a geo/country identity (its own code is authoritative, not a reference to another
 *  geo table) — e.g. `countries.country_code`. Contrast an institution's own `country_code`,
 *  which points AT such a table but isn't one itself. */
function isGeoIdentityTable(t: CatalogTable): boolean {
  return t.columns.some((c) => c.role === "geo_code" && !c.fk)
}

/** The request schema caps an option's `examples` at `MAX_OPTION_EXAMPLES`; several sources
 *  (a column's own synonyms, its table's, sample values) get concatenated below, so cap once,
 *  here, rather than risk a 400 from the Worker whenever any one of them is generous. */
function capExamples(examples: string[]): string[] {
  return examples.slice(0, MAX_OPTION_EXAMPLES)
}

function dimensionOption(catalog: Catalog, col: CatalogColumn): { key: string; text: OptionText } | null {
  const target = resolveDimensionTarget(catalog, col)
  if (!target) return null
  const sourceTable = catalog.tables.find((t) => t.name === col.table)
  // The column's own synonyms are often empty even when the table's are rich (e.g. affiliations'
  // display column "name" carries none of the table's "university"/"institute" wording) — include
  // both, but the column's own (more specific) synonyms win the slots when the combination is long.
  // An FK column's synonyms describe the pointer ("support", "rep"), never the table it points AT
  // ("employee", "staff") — without the TARGET table's own synonyms too, "which employee..." has no
  // word in common with an option built from Customer.SupportRepId at all.
  const examples = capExamples([...col.synonyms, ...(sourceTable?.synonyms ?? []), ...(col.role === "fk" ? target.table.synonyms : []), ...sampleValuesFor(catalog, target.key)])
  // A table's own display column named "name"/"title"/... says nothing about WHAT it names —
  // "Name (Products)" reads far more weakly to Jev than "Product (Products)" for "top 5 products
  // by ...". Word it as the table's own singular concept instead whenever that's all the column is.
  const isOwnGenericDisplay = col.role !== "fk" && sourceTable?.display === col.name && isGenericDisplayName(col.name)
  const label = isOwnGenericDisplay ? capitalizeFirst(singularizeLabel(sourceTable!.label)) : col.label
  // An FK column's own label is almost always "<Entity> ID" (humanize() renders "_id" as " ID") —
  // drop that suffix so the option reads "Store (Stores)" rather than "Store ID (Stores)"; a
  // column whose name carries a real ROLE beyond "which one" (birth_country_code, manager_id)
  // never ends in " ID" this way and keeps its own specific label untouched.
  const fkLabel = label.replace(/\s+ID$/, "")
  const what = col.role === "fk" ? `${fkLabel} (${target.table.label})` : `${label} (${sourceTable?.label ?? col.table})`
  return { key: target.key, text: examples.length ? { what, examples } : what }
}

/** A metric that is just `COUNT(*)` of one table names the table it counts — used to skip a
 *  redundant, worse-labelled `n:<table>` option for that same table (e.g. Nobel's curated
 *  "Prizes won" metric already IS the count of `awards` rows; offering a second, generic
 *  "Number of awards" option only invites Jev to pick the weaker-worded one). */
function countMetricTable(m: CatalogMetric): string | undefined {
  return /^count\(\s*\*\s*\)$/i.test(m.sql.trim()) ? m.table : undefined
}

/** Builds the `measures` record: catalog metrics, measure columns (each exposed once), row counts. */
function buildMeasures(catalog: Catalog): Record<string, OptionText> {
  const out: Record<string, OptionText> = {}
  for (const m of catalog.metrics) {
    const examples = capExamples(m.synonyms)
    out[`m:${m.key}`] = m.description ? { what: `${m.label} — ${m.description}`, examples } : { what: m.label, examples }
  }
  const countMetricTables = new Set(catalog.metrics.map(countMetricTable).filter((t): t is string => !!t))

  // Expose each measure column once by name: prefer the default-fact table's copy when the same
  // column name is duplicated on an aggregate table (world's country_year vs aggregate_year).
  const byName = new Map<string, { table: CatalogTable; col: CatalogColumn }>()
  for (const t of catalog.tables) {
    if (t.hidden) continue
    for (const col of t.columns) {
      if (col.role !== "measure") continue
      const existing = byName.get(col.name)
      const isDefault = t.name === catalog.defaultFact
      if (!existing || isDefault) byName.set(col.name, { table: t, col })
    }
  }
  for (const { table, col } of byName.values()) {
    const agg = col.agg ?? "sum"
    const key = `c:${col.key}:${agg}`
    const examples = capExamples(col.synonyms)
    out[key] = { what: `${col.label} (${table.label})${col.unit ? `, ${col.unit}` : ""}`, examples }
  }

  for (const t of catalog.tables) {
    if (t.hidden || isJunctionTable(t) || countMetricTables.has(t.name)) continue
    const what = t.description ? `Number of ${t.label.toLowerCase()} — ${t.description}` : `Number of ${t.label.toLowerCase()}`
    out[`n:${t.name}`] = { what, examples: capExamples(t.synonyms) }
  }
  return out
}

/** Builds the `dimensions` record from visible dimension/label/geo_code columns (no time). */
function buildDimensions(catalog: Catalog): Record<string, OptionText> {
  const out: Record<string, OptionText> = {}
  // Hidden tables (metadata such as World's `indicators`, marked in the semantic layer) are left
  // out; a table with no joins can still be a real standalone fact (Swift's awards, an uploaded
  // staff.csv), so its dimensions stay on offer. compilePlan drops a grouping it cannot reach.
  for (const t of catalog.tables) {
    if (t.hidden) continue
    for (const col of t.columns) {
      if (col.role !== "dimension" && col.role !== "label" && col.role !== "geo_code" && col.role !== "fk") continue
      if (col.role === "label" && col.key !== `${t.name}.${t.display}`) continue // only the display label, not free-text labels
      // A geo identity table's own display column (e.g. `countries.name` — "dimension"-rolerole
      // in one catalog, "label" in another) is redundant with its geo_code column
      // (`countries.country_code`), which compile.ts already enriches with the display name AND
      // tags as kind "geo_code" (map-eligible) — offering both just splits Jev's pick and loses
      // the map half the time. A table's OTHER dimension columns (e.g. `countries.continent`)
      // are unaffected — only the specific column matching `t.display` is suppressed.
      if (col.name === t.display && isGeoIdentityTable(t)) continue
      const opt = dimensionOption(catalog, col)
      if (!opt) continue
      if (!(opt.key in out)) out[opt.key] = opt.text
    }
  }
  return out
}

/** v0.2: the nearest role-"date" column reachable from `startTable`, ignoring role "time" columns
 *  — e.g. AFL's `matches.match_date` next to `matches.year` (an integer, role "time", that already
 *  wins the ordinary time axis above). Used to offer cyclical grains (weekday, month of year, hour)
 *  even when the fact's ordinary time axis is a plain year column, and to resolve the actual column
 *  a cyclical grain buckets on (see interpret.ts). Only visible tables are considered, matching
 *  `nearestTimeColumn`. There is no sampled-value check here: a "date"-role column with no real
 *  date-looking values (the semantic layer mis-typing a free-text column) is a catalog bug for the
 *  agnostic/semantic-layer owner to fix at the source, not something this code can detect from the
 *  catalog alone (no raw rows are available at request-build time) — it relies on the role.
 */
export function nearestDateColumn(catalog: Catalog, startTable: string): CatalogColumn | undefined {
  const dist = tableDistances(catalog, startTable)
  let best: { col: CatalogColumn; d: number } | undefined
  for (const t of catalog.tables) {
    if (t.hidden) continue
    const d = dist.get(t.name)
    if (d === undefined) continue
    const col = t.columns.find((c) => c.role === "date")
    if (!col) continue
    if (!best || d < best.d) best = { col, d }
  }
  return best?.col
}

/** Whether `col` is worth offering in bands: curated `binnable: true`, or (when the curator didn't
 *  say either way) a plain measure column with a real numeric range — but never one curated
 *  `binnable: false` (deliberately excluded, e.g. too wide-ranging or better left on a log scale). */
function isBandable(col: CatalogColumn): boolean {
  if (col.role !== "measure") return false
  if (col.binnable === true) return true
  if (col.binnable === false) return false
  return col.min !== undefined && col.max !== undefined
}

/** v0.2 bands: one `b:<table.col>` dimension option per visible, bandable measure column — same
 *  one-per-name dedup as `buildMeasures` (prefer the default fact's own copy of a column name
 *  shared with a rollup table, e.g. World's `population` on both `country_year` and
 *  `aggregate_year`), so bands never duplicate a measure that already reads the same on both. */
function buildBandOptions(catalog: Catalog): Record<string, OptionText> {
  const byName = new Map<string, { table: CatalogTable; col: CatalogColumn }>()
  for (const t of catalog.tables) {
    if (t.hidden) continue
    for (const col of t.columns) {
      if (!isBandable(col)) continue
      const existing = byName.get(col.name)
      const isDefault = t.name === catalog.defaultFact
      if (!existing || isDefault) byName.set(col.name, { table: t, col })
    }
  }
  const out: Record<string, OptionText> = {}
  for (const { col } of byName.values()) {
    const examples = capExamples(col.synonyms)
    const what = `${col.label} in bands (ranges such as 0–10, 10–20)`
    out[`b:${col.key}`] = examples.length ? { what, examples } : what
  }
  return out
}

function buildTimeGrains(catalog: Catalog): TimeGrain[] {
  const fact = catalog.defaultFact
  if (!fact) return []
  const nearest = nearestTimeColumn(catalog, fact)
  if (!nearest) return []
  const grains = new Set<TimeGrain>(["year"])
  const nearestCol = catalogColumnByKey(catalog, nearest.key)
  if (nearestCol?.role === "date") {
    // A real DATE/DATETIME/TIMESTAMP column (declared, named `*_on`/`*_date`/`*_at`, or >= 80%
    // ISO-looking text — see buildAutoCatalog) can bucket at any of these grains via strftime.
    grains.add("quarter")
    grains.add("month")
    grains.add("day")
  } else {
    // The decade grain lives next to whichever table actually carries the nearest year column
    // (e.g. Nobel's `prizes.decade`, one hop from the `awards` fact) — not necessarily the fact
    // table itself, which is where the old check looked and always came up empty for Nobel.
    const nearestTable = catalog.tables.find((t) => t.name === nearest.key.split(".")[0])
    if (nearestTable?.columns.some((c) => c.role === "time" && c.grain === "decade")) grains.add("decade")
  }

  // v0.2 cyclical grains: offered whenever a real DATE column is reachable at all, independent of
  // whether the ordinary time axis above is that same column or an integer year sitting next to it.
  const dateCol = nearestDateColumn(catalog, fact)
  if (dateCol) {
    grains.add("weekday")
    grains.add("month_of_year")
    if (dateCol.hasTime) grains.add("hour")
  }
  return [...grains]
}

function catalogColumnByKey(catalog: Catalog, key: string): CatalogColumn | undefined {
  const table = key.split(".")[0]!
  return catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.key === key)
}

function buildRowTables(catalog: Catalog): Record<string, OptionText> {
  const out: Record<string, OptionText> = {}
  for (const t of catalog.tables) {
    if (t.hidden || isJunctionTable(t)) continue
    out[t.name] = { what: t.description || t.label, examples: capExamples(t.synonyms) }
  }
  return out
}

function buildSortColumns(catalog: Catalog): Record<string, OptionText> {
  const out: Record<string, OptionText> = {}
  for (const t of catalog.tables) {
    if (t.hidden) continue
    for (const col of t.columns) {
      if (col.role === "measure" || col.role === "time" || col.role === "date") {
        out[col.key] = `${col.label} (${t.label})`
      }
    }
  }
  return out
}

function capOptions(record: Record<string, OptionText>, keep: number): Record<string, OptionText> {
  const keys = Object.keys(record)
  if (keys.length <= keep) return record
  const out: Record<string, OptionText> = {}
  for (const k of keys.slice(0, keep)) out[k] = record[k]!
  return out
}

/**
 * `catalog.contains` (lead-owned build-catalog.ts) is just visible table labels, which under-
 * signals topical coverage for the in_scope judgment (e.g. "forest cover" isn't a table name).
 * Add metric and measure-column labels so Jev sees the actual topics the dataset can answer.
 */
function buildContains(catalog: Catalog): string[] {
  const topics = new Set(catalog.contains.map((c) => c.toLowerCase()))
  for (const m of catalog.metrics) topics.add(m.label.toLowerCase())
  for (const t of catalog.tables) {
    if (t.hidden) continue
    for (const c of t.columns) if (c.role === "measure") topics.add(c.label.toLowerCase())
  }
  return [...topics].slice(0, 60)
}

/** v0.2: columns that actually have missing values (options for the `missing` question): visible
 *  dimension / label / measure / time / date / fk / geo columns with nullCount > 0. */
function buildNullableColumns(catalog: Catalog): Record<string, OptionText> {
  const out: Record<string, OptionText> = {}
  const roles = new Set(["dimension", "label", "measure", "time", "date", "fk", "geo_code"])
  // A year/decade column derived from a date on the same table ("death_year" next to "death_date",
  // equally often missing) records the SAME fact — offering both only splits Jev's pick in half.
  const stem = (name: string) => name.replace(/_(date|on|at|year|decade)$/, "")
  for (const t of catalog.tables) {
    if (t.hidden) continue
    const dateStems = new Map(t.columns.filter((c) => c.role === "date" && c.nullCount).map((c) => [stem(c.name), c.nullCount]))
    for (const col of t.columns) {
      if (!roles.has(col.role) || !col.nullCount) continue
      if (col.role === "time" && dateStems.has(stem(col.name))) continue
      out[col.key] = `${col.label} (${t.label})`
    }
  }
  return out
}

/** v0.2: text columns a fragment can be searched in (options for `text:<id>` questions): the
 *  display/label/dimension/text columns of visible tables stored as TEXT. */
function buildTextColumns(catalog: Catalog): Record<string, OptionText> {
  const out: Record<string, OptionText> = {}
  for (const t of catalog.tables) {
    if (t.hidden) continue
    for (const col of t.columns) {
      if (col.role !== "label" && col.role !== "dimension" && col.role !== "text") continue
      if (!/char|text|clob/i.test(col.sqlType || "TEXT")) continue
      out[col.key] = `${col.label} (${t.label})`
    }
  }
  return out
}

export function buildPlanRequest(question: string, catalog: Catalog, candidates: CandidatesLike): PlanRequest {
  return {
    datasetId: catalog.datasetId,
    schemaHash: catalog.schemaHash,
    question: question.slice(0, 300),
    dataset: { name: catalog.title, about: catalog.about, contains: buildContains(catalog) },
    measures: capOptions(buildMeasures(catalog), MAX_OPTIONS),
    dimensions: capOptions({ ...buildDimensions(catalog), ...buildBandOptions(catalog) }, MAX_OPTIONS),
    timeGrains: buildTimeGrains(catalog),
    rowTables: capOptions(buildRowTables(catalog), MAX_OPTIONS),
    sortColumns: capOptions(buildSortColumns(catalog), MAX_OPTIONS),
    numbers: candidates.numbers,
    filters: candidates.filters,
    thresholds: candidates.thresholds ?? [],
    texts: candidates.texts ?? [],
    orPairs: candidates.orPairs ?? [],
    rankWindows: candidates.rankWindows ?? [],
    cues: candidates.cues ?? { missing: false, rate: false, change: false },
    nullableColumns: capOptions(buildNullableColumns(catalog), MAX_OPTIONS / 2),
    textColumns: capOptions(buildTextColumns(catalog), MAX_OPTIONS),
  }
}

// Re-exported so callers (offline.ts, interpret.ts) can share the exact same "is this a junction
// table" rule without re-deriving it.
export { isJunctionTable }

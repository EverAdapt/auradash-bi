/**
 * OWNER: data-engine.
 * The semantic layer the planner reads.
 *
 * Bundled datasets: public/data/<id>.catalog.json (built by scripts/build-catalog.ts).
 * Uploads: buildAutoCatalog() infers the same shape from the database, entirely from the schema
 * and its data — never from hand-picked table/column names, so any uploaded database gets the
 * same treatment:
 *   - roles from declared types, naming conventions and value shape (ids, dates, geo codes, flags,
 *     measures, dimensions vs. free-text labels — see inferRole/looksLikeDateColumn below);
 *   - joins from PRAGMA foreign_key_list and `<table>_id` naming conventions;
 *   - synonyms from tokenizing identifier names plus a small business thesaurus (revenue/qty/
 *     price/customer/store/... — see THESAURUS_GROUPS), so Jev's option text reads naturally
 *     whatever the schema's own naming style (snake_case dumps, PascalCase SQLite, Title Case CSV
 *     headers);
 *   - a default fact table and two auto metrics (a row count and, when the shape supports it, a
 *     qty × price "Revenue") — see buildAutoMetrics.
 * Pure TS apart from fetch — introspects only through the QueryFn (sqlite_schema, PRAGMA
 * table_xinfo/foreign_key_list, aggregate stats), never the DB directly, so scripts/upload-cli.ts
 * can build the exact same catalog over bun:sqlite that the browser builds over sqlite-wasm.
 */
import type { Agg, Catalog, CatalogColumn, CatalogJoin, CatalogMetric, CatalogTable, CatalogValue, ColumnRole, DatasetId, DatasetInfo, QueryFn } from "@shared/contract"
import { del, get, set } from "idb-keyval"
import { suggestPrompts } from "@/lib/plan"
import { listDatasets, queryFn } from "@/lib/db"
import { isJunctionTable } from "@/lib/plan/graph"
import { isGenericDisplayName, pluralize, singularize, singularizeLabel } from "@/lib/plan/normalize"

const cache = new Map<DatasetId, Promise<Catalog>>()
// Bumped from "catalog:" so a catalog built by an earlier version of buildAutoCatalog (before the
// date/measure/synonym/metric improvements below) is never read back from IndexedDB — every
// upload rebuilds once, then caches under the new key.
const CATALOG_IDB_PREFIX = "catalog:v4:"
const MAX_CATALOG_VALUES = 6000
const MAX_VALUE_DISTINCT = 2500

export function getCatalog(datasetId: DatasetId): Promise<Catalog> {
  let hit = cache.get(datasetId)
  if (!hit) {
    hit = datasetId.startsWith("up_") ? loadUploadCatalog(datasetId) : loadBundledCatalog(datasetId)
    cache.set(datasetId, hit)
  }
  return hit
}

/** Forget a cached catalog (after an upload is replaced or deleted); best-effort clears the IDB copy too. */
export function invalidateCatalog(datasetId: DatasetId): void {
  cache.delete(datasetId)
  void del(CATALOG_IDB_PREFIX + datasetId).catch(() => {})
}

async function loadBundledCatalog(datasetId: DatasetId): Promise<Catalog> {
  const r = await fetch(`/data/${datasetId}.catalog.json`)
  if (!r.ok) throw new Error(`No catalog for ${datasetId}`)
  return (await r.json()) as Catalog
}

async function loadUploadCatalog(datasetId: DatasetId): Promise<Catalog> {
  const persisted = await get<Catalog>(CATALOG_IDB_PREFIX + datasetId)
  if (persisted) return persisted

  const info = (await listDatasets()).find((d) => d.id === datasetId)
  if (!info) throw new Error(`Unknown dataset ${datasetId}`)

  const catalog = await buildAutoCatalog(info, queryFn(datasetId))
  await set(CATALOG_IDB_PREFIX + datasetId, catalog)
  return catalog
}

// ─────────────────────────────── naming: tokens, humanize, plural/singular ───────────────────────────────

/** Splits an identifier into lowercase words, whatever its style: `unit_price`, `UnitPrice` and
 *  `Unit Price` (a CSV header) all become `["unit", "price"]`. Every naming/synonym/date/measure
 *  heuristic below reads names through this, which is what makes them dataset-agnostic. */
function toWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function capitalizeFirst(s: string): string {
  return s.replace(/^./, (c) => c.toUpperCase())
}

/** Joins words back into a label, e.g. ["store", "id"] -> "Store ID", ["unit", "price"] -> "Unit price". */
function humanizeWords(words: string[]): string {
  const ABBREVIATIONS: Record<string, string> = { qty: "quantity", amt: "amount", avg: "average", num: "number", temp: "temperature" }
  const joined = words
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(" ")
    .replace(/\bpct\b/gi, "%")
    .replace(/\bid\b/gi, "ID")
  return capitalizeFirst(joined)
}

/** A column's display label: tokenize, then humanize (handles snake_case, PascalCase and Title Case names alike). */
function humanize(name: string): string {
  return humanizeWords(toWords(name))
}

/** Pluralizes just the last word of a (possibly multi-word) identifier: "playlist_track" ->
 *  ["playlist", "tracks"], "Employee" -> ["employees"]. Singularizing first makes this idempotent
 *  on names that are already plural (e.g. "stores" round-trips to "stores", not "storeses"). */
function pluralizeLastWord(words: string[]): string[] {
  if (!words.length) return words
  const last = words[words.length - 1]!
  return [...words.slice(0, -1), pluralize(singularize(last))]
}

/** A table's display label: always plural, however the table itself is named ("Employees",
 *  "Sales", "Playlist tracks") — "tables: ... label humanized and pluralized sensibly". */
function tableLabel(name: string): string {
  return humanizeWords(pluralizeLastWord(toWords(name)))
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]!
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s)

/** "about: a readable one-liner ... from table labels" — but a one- or two-table upload's table
 *  label(s) alone ("Your data: energy readings") give the in_scope judgment almost nothing to go
 *  on; folding in that table's own measure/dimension topics (the way the bundled catalogs' hand
 *  written `about` already reads, e.g. "population, wealth, health, energy, internet...") gives it
 *  real topics to match a question against without needing to be hand-written. */
function aboutSentence(visible: CatalogTable[]): string {
  if (!visible.length) return "Your data"
  const tableLabels = visible.map((t) => t.label.toLowerCase())
  if (visible.length > 2) return `Your data: ${joinWithAnd(tableLabels)}`
  const topics = new Set<string>()
  for (const t of visible) {
    for (const c of t.columns) {
      if (c.role === "measure" || c.role === "dimension" || c.role === "geo_code") topics.add(c.label.toLowerCase())
    }
  }
  if (!topics.size) return `Your data: ${joinWithAnd(tableLabels)}`
  return `Your data: ${joinWithAnd(tableLabels)} — ${joinWithAnd([...topics].slice(0, 8))}`
}

// ─────────────────────────────── synonyms: tokens + a small business thesaurus ───────────────────────────────

/** A small business thesaurus: naming a column/table with any one word in a group pulls in the
 *  whole group as synonyms, so "amount", "revenue" and "turnover" are interchangeable to Jev's
 *  matching regardless of which one an uploaded schema actually used. */
const THESAURUS_GROUPS: readonly (readonly string[])[] = [
  ["amount", "total", "revenue", "sales", "turnover", "money", "value"],
  ["qty", "quantity", "units", "items", "sold", "volume"],
  ["price", "cost", "unit price"],
  ["customer", "client", "buyer"],
  ["employee", "staff"],
  ["product", "item", "sku"],
  ["store", "shop", "branch", "location"],
  ["city", "town"],
  ["country"],
  ["category", "type", "kind"],
  ["date", "day", "when"],
]

function thesaurusFor(words: string[]): string[] {
  const out = new Set<string>()
  for (const w of words) {
    for (const group of THESAURUS_GROUPS) {
      if (group.includes(w)) for (const g of group) out.add(g)
    }
  }
  return [...out]
}

function columnSynonyms(name: string): string[] {
  const words = toWords(name)
  return dedupe([...words, ...thesaurusFor(words)])
}

/** Table synonyms: its own words, the singular/plural of its last word ("stores"/"store"), and
 *  any thesaurus hits — "table synonyms from singular/plural forms". */
function tableSynonyms(name: string): string[] {
  const words = toWords(name)
  if (!words.length) return []
  const base = words.slice(0, -1)
  const last = words[words.length - 1]!
  const singular = singularize(last)
  const plural = pluralize(singular)
  return dedupe([...words, [...base, singular].join(" "), [...base, plural].join(" "), ...thesaurusFor(words)])
}

// ─────────────────────────────── dates ───────────────────────────────

/** `*_on`, `*_date`, `*_at`, or the bare words `date`/`day`/`month` — matched against the
 *  normalized (snake_case) form of the name so `SoldOn`, `sold_on` and "Sold On" all hit it. */
const DATE_NAME_RE = /(^|_)(date|day|month)$|_on$|_at$/
const DATE_TYPE_RE = /^(DATE|DATETIME|TIMESTAMP)\b/i

function looksLikeIsoDateValues(stats: StatsRow): boolean {
  return stats.total > 0 && stats.isoDate / stats.total >= 0.8
}

/** A column is 'date' when: its declared type says so (DATE/DATETIME/TIMESTAMP survives dump
 *  normalization as-is); or it's text-ish and either named like a date or at least 80% of its
 *  values look like an ISO date (`YYYY-MM-DD...`). Integer year/decade columns are handled by
 *  inferRole's own 'time' rule and never reach here. */
function looksLikeDateColumn(name: string, sqlType: string, isText: boolean, stats: StatsRow): boolean {
  if (DATE_TYPE_RE.test(sqlType.trim())) return true
  if (!isText) return false
  if (DATE_NAME_RE.test(toWords(name).join("_"))) return true
  return looksLikeIsoDateValues(stats)
}

// ─────────────────────────────── measures ───────────────────────────────

/** price/rate/pct/avg/age-named measures default to averaging (a per-unit or per-person value
 *  isn't meaningful summed across rows); everything else (amount, revenue, qty, ...) sums. Checked
 *  per WORD (toWords), not as a substring of the raw name — a plain regex word boundary (`\b`)
 *  can't see the join between "avg" and "temp" in "avg_temp_c": `_` counts as a word character, so
 *  there is no boundary there at all. */
const AVG_WORD_RE = /^(price|rate|pct|percent|avg|average|age)/i
function defaultAgg(name: string): Agg {
  return toWords(name).some((w) => AVG_WORD_RE.test(w)) ? "avg" : "sum"
}

/** `*_cents` -> cents, `*_usd`/price/amount/revenue -> money, `*_pct`/percent -> a share. */
function unitHint(name: string): string | undefined {
  const n = name.toLowerCase()
  if (/_cents$/.test(n)) return "cents"
  if (/_usd$/.test(n) || /price/.test(n) || /amount/.test(n) || /revenue/.test(n)) return "money"
  if (/_pct$/.test(n) || /percent/.test(n)) return "%"
  return undefined
}

function formatForUnit(unit: string | undefined): CatalogColumn["format"] {
  if (unit === "money" || unit === "cents") return "currency"
  if (unit === "%") return "percent"
  return undefined
}

const QTY_TOKENS = new Set(["qty", "quantity", "units", "item", "items", "volume"])
const PRICE_TOKENS = new Set(["price", "cost"])

function hasToken(name: string, tokens: Set<string>): boolean {
  return toWords(name).some((w) => tokens.has(w))
}

/** The fact's own qty-like measure column, only when exactly one such column exists (unambiguous). */
function findQtyColumn(fact: CatalogTable): CatalogColumn | undefined {
  const candidates = fact.columns.filter((c) => c.role === "measure" && hasToken(c.name, QTY_TOKENS))
  return candidates.length === 1 ? candidates[0] : undefined
}

/** A price-like measure column for the fact: on the fact table itself first (e.g. "price at the
 *  time of sale" captured on the sale row, the more correct real-world shape), else one that's
 *  exactly one FK hop away (e.g. sales.product_id -> products.price). Undefined whenever more
 *  than one candidate exists at whichever level is checked — "only when unambiguous". */
function findPriceColumn(tables: CatalogTable[], fact: CatalogTable): CatalogColumn | undefined {
  const isPricey = (c: CatalogColumn) => c.role === "measure" && hasToken(c.name, PRICE_TOKENS)
  const own = fact.columns.filter(isPricey)
  if (own.length === 1) return own[0]
  if (own.length > 1) return undefined

  const hits: CatalogColumn[] = []
  for (const fkCol of fact.columns.filter((c) => c.fk !== undefined)) {
    const target = tables.find((t) => t.name === fkCol.fk!.split(".")[0])
    const pricey = target?.columns.filter(isPricey) ?? []
    if (pricey.length === 1) hits.push(pricey[0]!)
  }
  return hits.length === 1 ? hits[0] : undefined
}

/** "metrics: add useful auto metrics for the default fact": a row count, always; a derived
 *  `SUM(qty * price)` "Revenue" metric when the fact's shape supports one, unambiguously. Metric
 *  SQL is written exactly like the bundled catalogs' — an aggregate expression over qualified
 *  `table.column` — so compile.ts's `rewriteQualifiedSql` joins it in without any special-casing. */
function buildAutoMetrics(tables: CatalogTable[], defaultFact: string | undefined): CatalogMetric[] {
  const fact = tables.find((t) => t.name === defaultFact)
  if (!fact) return []

  const metrics: CatalogMetric[] = [
    {
      key: "count",
      label: `Number of ${lowerFirst(fact.label)}`,
      sql: "COUNT(*)",
      table: fact.name,
      synonyms: dedupe([...fact.synonyms, "count", "number", "how many", "total"]),
      format: "number",
    },
  ]

  const qtyCol = findQtyColumn(fact)
  const priceCol = qtyCol ? findPriceColumn(tables, fact) : undefined
  if (qtyCol && priceCol) {
    metrics.push({
      key: "revenue",
      label: "Revenue",
      sql: `SUM(${fact.name}.${qtyCol.name} * ${priceCol.table}.${priceCol.name})`,
      table: fact.name,
      synonyms: thesaurusFor(["amount"]),
      unit: priceCol.unit ?? "money",
      format: "currency",
    })
  }
  return metrics
}

/** "defaultFact = the table with the most rows that has >= 1 foreign key (declared or
 *  naming-convention), else the largest table." A column's `fk` is set independently of its
 *  headline `role` (a geo_code column can still carry one), so this checks `fk` directly. A pure
 *  many-to-many bridge table (only fk/id columns, e.g. Chinook's PlaylistTrack) is excluded even
 *  when it happens to have the most rows of any table — it has no measure or dimension of its own
 *  to be a useful fact, and request.ts's buildRowTables/buildMeasures already skip it the same way. */
function pickDefaultFact(tables: CatalogTable[]): string | undefined {
  const visible = tables.filter((t) => !t.hidden && !isJunctionTable(t))
  if (!visible.length) return undefined
  const withFk = visible.filter((t) => t.columns.some((c) => c.fk !== undefined))
  const pool = withFk.length ? withFk : visible
  return pool.reduce((best, t) => (t.rowCount > best.rowCount ? t : best)).name
}

// ─────────────────────────────── display column ───────────────────────────────

const normId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** "display column (name/title/label/full_name/first+last... first match)". A table that has
 *  BOTH a first and a last name column is a person record (a customer, an employee, ...) — its own
 *  identity is that name, which beats an incidental same-named-as-"title" field an employee table
 *  can also have (a job title is not a display name, even though the word "title" is generically
 *  one of the names this function otherwise treats as a display column). Falls through to
 *  compile.ts's own dimension/label fallback (used at every join site) when nothing here matches,
 *  rather than guessing at a second, less certain fallback here too. */
function pickDisplayColumn(columns: CatalogColumn[]): string | undefined {
  const byNormName = (n: string) => columns.find((c) => normId(c.name) === n)
  const name = byNormName("name")
  if (name) return name.name
  const firstName = byNormName("firstname")
  const lastName = byNormName("lastname")
  if (firstName && lastName) return firstName.name
  const rest = columns.find((c) => isGenericDisplayName(c.name))
  return rest?.name ?? firstName?.name
}

// ─────────────────────────────── auto catalog ───────────────────────────────

interface XInfoRow {
  name: string
  type: string
  pk: number
}
interface FkRow {
  table: string
  from: string
  to: string
}
interface StatsRow {
  d: number
  n: number
  mn: number | null
  mx: number | null
  iso: number
  isoDate: number
  hasTimeOfDay: number
  total: number
}

async function sha256Hex16(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  return hex.slice(0, 16)
}

/** ISO3-code detection: TEXT column where >= 80% of non-null values are 3 uppercase letters. */
function looksLikeIso3(stats: StatsRow): boolean {
  return stats.total > 0 && stats.iso / stats.total >= 0.8
}

function isLatByRange(name: string, min: number | null, max: number | null): boolean {
  return /^lat(itude)?$/i.test(name) && min !== null && max !== null && min >= -90 && max <= 90
}
function isLonByRange(name: string, min: number | null, max: number | null): boolean {
  return /^lo?ng?(itude)?$/i.test(name) && min !== null && max !== null && min >= -180 && max <= 180
}

/** A 0/1-only numeric column is a real boolean flag; two distinct values that aren't 0 and 1 (e.g.
 *  Chinook's `UnitPrice`, which is 0.99 or 1.99 across the whole catalog) are still a measure —
 *  low cardinality alone doesn't make an amount a flag. */
function isBooleanRange(min: number | null, max: number | null): boolean {
  return min !== null && max !== null && min >= 0 && max <= 1
}

/** Same shape of heuristics as scripts/build-catalog.ts's inferRole, without a semantic override. */
function baseInferRole(name: string, sqlType: string, isPk: boolean, distinct: number, rows: number, min: number | null, max: number | null): ColumnRole {
  const t = sqlType.toUpperCase()
  if (isPk && rows > 0 && distinct === rows) return "id"
  if (/(^|_)id$/i.test(name)) return "id"
  if (/year|decade/i.test(name) && /INT/.test(t)) return "time"
  if (/date|_at$/i.test(name)) return "date"
  if (/INT|REAL|NUM|DEC|DOUB|FLOA/.test(t)) return distinct <= 2 && isBooleanRange(min, max) ? "flag" : "measure"
  if (/url|link/i.test(name)) return "url"
  // Contact/identifying fields (phone, fax, email, a postal code, a street address) are never a
  // meaningful "group by" category — nobody asks "sales by phone number" — however low their
  // distinct count happens to be on a small table (a 59-row customer table's phone numbers are
  // all but unique, but so is its distinct COUNTRY count on a larger one; naming, not cardinality,
  // is what tells them apart). Excluding these here keeps them out of buildDimensions' group_by
  // options, so Jev isn't picking a category among two dozen addresses and fax numbers.
  if (/phone|fax|email|postal|zip|address/i.test(name)) return "label"
  if (distinct <= 60) return "dimension"
  return "label"
}

/** Naming-convention join target for an `<x>_id` column: a table named `x`, `xs` or `xes`. */
function findNamingConventionTarget(colName: string, ownTable: string, tableNames: Set<string>): string | null {
  const m = colName.match(/^(.+)_id$/i)
  if (!m) return null
  const x = m[1].toLowerCase()
  for (const candidate of [x, `${x}s`, `${x}es`]) {
    if (candidate !== ownTable && tableNames.has(candidate)) return candidate
  }
  return null
}

export async function buildAutoCatalog(info: DatasetInfo, run: QueryFn): Promise<Catalog> {
  const q = async <T = Record<string, unknown>>(sql: string, params: (string | number)[] = []): Promise<T[]> => {
    const res = await run(sql, params)
    return res.rows.map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i]]))) as T[]
  }

  const objects = await q<{ name: string; type: string }>(
    "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  const tableNames = new Set(objects.map((o) => o.name.toLowerCase()))

  // Pre-pass: cache every table's columns and record its PK column name, so naming-convention
  // joins can resolve a target table's PK regardless of schema (alphabetical) processing order.
  const xinfoByTable = new Map<string, XInfoRow[]>()
  const pkColumnByTable = new Map<string, string>()
  for (const obj of objects) {
    const xinfo = await q<XInfoRow>(`PRAGMA table_xinfo("${obj.name}")`)
    xinfoByTable.set(obj.name, xinfo)
    const pk = xinfo.find((c) => c.pk > 0)
    if (pk) pkColumnByTable.set(obj.name.toLowerCase(), pk.name)
  }

  const tables: CatalogTable[] = []
  const joins: CatalogJoin[] = []
  const values: CatalogValue[] = []
  let valueBudget = MAX_CATALOG_VALUES

  for (const obj of objects) {
    const hidden = obj.name.startsWith("_") || obj.type === "view"
    const rowCount = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM "${obj.name}"`))[0]?.n ?? 0)
    const xinfo = xinfoByTable.get(obj.name) ?? []
    const fks = hidden ? [] : await q<FkRow>(`PRAGMA foreign_key_list("${obj.name}")`)
    const fkByColumn = new Map(fks.map((fk) => [fk.from, fk]))

    const columns: CatalogColumn[] = []
    for (const c of xinfo) {
      const t = c.type.toUpperCase()
      const isText = /CHAR|CLOB|TEXT/.test(t) || t === ""
      const [stats] = await q<StatsRow>(
        `SELECT COUNT(DISTINCT "${c.name}") AS d, SUM("${c.name}" IS NULL) AS n,
                MIN(CASE WHEN typeof("${c.name}") IN ('integer','real') THEN "${c.name}" END) AS mn,
                MAX(CASE WHEN typeof("${c.name}") IN ('integer','real') THEN "${c.name}" END) AS mx,
                SUM(CASE WHEN typeof("${c.name}") = 'text' AND "${c.name}" GLOB '[A-Z][A-Z][A-Z]' THEN 1 ELSE 0 END) AS iso,
                SUM(CASE WHEN typeof("${c.name}") = 'text' AND "${c.name}" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN 1 ELSE 0 END) AS isoDate,
                SUM(CASE WHEN typeof("${c.name}") = 'text' AND "${c.name}" GLOB '*[0-9][0-9]:[0-9][0-9]*' THEN 1 ELSE 0 END) AS hasTimeOfDay,
                SUM(CASE WHEN "${c.name}" IS NOT NULL THEN 1 ELSE 0 END) AS total
         FROM "${obj.name}"`,
      )

      // The join target (`fk`) is resolved independently of the column's headline `role`: a
      // country-code column, for instance, is more useful tagged `geo_code` than `fk`, but still
      // needs `fk` set so the explorer can link it through to the referenced table.
      let fk: string | undefined
      const declaredFk = fkByColumn.get(c.name)
      const namingTarget = !declaredFk ? findNamingConventionTarget(c.name, obj.name.toLowerCase(), tableNames) : null
      if (declaredFk) {
        fk = `${declaredFk.table}.${declaredFk.to}`
        joins.push({ from: `${obj.name}.${c.name}`, to: fk, kind: "many-to-one" })
      } else if (namingTarget) {
        const targetPk = pkColumnByTable.get(namingTarget) ?? "id"
        fk = `${namingTarget}.${targetPk}`
        joins.push({ from: `${obj.name}.${c.name}`, to: fk, kind: "many-to-one" })
      }

      let role: ColumnRole
      if (isLatByRange(c.name, stats.mn, stats.mx)) {
        role = "latitude"
      } else if (isLonByRange(c.name, stats.mn, stats.mx)) {
        role = "longitude"
      } else if (isText && looksLikeIso3(stats)) {
        role = "geo_code"
      } else if (looksLikeDateColumn(c.name, c.type, isText, stats)) {
        role = "date"
      } else if (fk) {
        role = "fk"
      } else {
        role = baseInferRole(c.name, c.type, c.pk > 0, stats.d, rowCount, stats.mn, stats.mx)
      }

      const agg = role === "measure" ? defaultAgg(c.name) : undefined
      const unit = role === "measure" ? unitHint(c.name) : undefined
      // Same honesty check as scripts/build-catalog.ts: an hour grain is only offered (request.ts's
      // buildTimeGrains) when a 'date' column's own values really carry a time of day.
      const hasTime = role === "date" && stats.total > 0 && stats.hasTimeOfDay / stats.total >= 0.5

      columns.push({
        key: `${obj.name}.${c.name}`,
        table: obj.name,
        name: c.name,
        label: humanize(c.name),
        sqlType: c.type || "",
        role,
        agg,
        unit,
        format: role === "measure" ? formatForUnit(unit) : undefined,
        additive: role === "measure" ? agg === "sum" : undefined,
        binnable: role === "measure" && (stats.d ?? 0) > 10 ? true : undefined,
        grain: role === "time" ? (/decade/i.test(c.name) ? "decade" : "year") : role === "date" ? "day" : undefined,
        fk,
        synonyms: columnSynonyms(c.name),
        distinctCount: stats.d,
        nullCount: stats.n ?? 0,
        min: stats.mn ?? undefined,
        max: stats.mx ?? undefined,
        hasTime: hasTime || undefined,
      })
    }

    // Filterable values: dimensions and reasonably-sized labels, budget capped globally.
    if (!hidden) {
      for (const col of columns) {
        if (valueBudget <= 0) break
        const isCandidate = col.role === "dimension" || (col.role === "label" && (col.distinctCount ?? 0) <= MAX_VALUE_DISTINCT)
        if (!isCandidate || (col.distinctCount ?? 0) > MAX_VALUE_DISTINCT) continue
        const rows = await q<{ v: string }>(
          `SELECT DISTINCT "${col.name}" AS v FROM "${obj.name}" WHERE "${col.name}" IS NOT NULL AND typeof("${col.name}") = 'text' LIMIT ?`,
          [valueBudget],
        )
        for (const r of rows) values.push({ column: col.key, value: r.v, aliases: [] })
        valueBudget -= rows.length
      }
    }

    // A display column called "name"/"title" reads as the thing it names: stores.name -> "Store",
    // so titles and chips say "Revenue by store", not "Revenue by name".
    const display = pickDisplayColumn(columns)
    const displayCol = display ? columns.find((c) => c.name === display) : undefined
    if (displayCol && /^(name|title|label|full_?name|display_?name)$/i.test(displayCol.name)) {
      displayCol.synonyms = [...new Set([...displayCol.synonyms, displayCol.label.toLowerCase()])]
      displayCol.label = capitalizeFirst(singularizeLabel(tableLabel(obj.name)))
    }

    tables.push({
      name: obj.name,
      label: tableLabel(obj.name),
      description: obj.type === "view" ? "Convenience view" : "",
      synonyms: tableSynonyms(obj.name),
      rowCount,
      display,
      hidden,
      isView: obj.type === "view",
      columns,
    })
  }

  const seen = new Set<string>()
  const uniqJoins = joins.filter((j) => {
    const k = `${j.from}>${j.to}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const visible = tables.filter((t) => !t.hidden)
  const schemaHash = await sha256Hex16(JSON.stringify(visible.map((t) => [t.name, t.columns.map((c) => [c.name, c.sqlType, c.role])])))
  const defaultFact = pickDefaultFact(tables)

  const catalog: Catalog = {
    datasetId: info.id,
    title: info.title,
    tagline: info.tagline,
    about: aboutSentence(visible),
    contains: visible.map((t) => t.label.toLowerCase()),
    tables,
    joins: uniqJoins,
    metrics: buildAutoMetrics(tables, defaultFact),
    values: values.slice(0, MAX_CATALOG_VALUES),
    rules: [],
    tryPrompts: [],
    defaultFact,
    schemaHash,
  }
  catalog.tryPrompts = suggestPrompts(catalog)
  return catalog
}

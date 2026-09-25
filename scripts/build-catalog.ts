/**
 * Build-time catalog for the bundled datasets (bun scripts/build-catalog.ts).
 *
 *   data/<id>.sqlite + data/<id>.semantic.json
 *     → public/data/<id>.sqlite.gz        (served as a static asset, inflated in the browser)
 *     → public/data/<id>.catalog.json     (the contract `Catalog`; the planner's only schema input)
 *     → public/data/datasets.json         (DatasetInfo[] for the bundled datasets)
 *     → src/fixtures/try-results.json     (real results of every curated prompt's reference SQL)
 *
 * Uploaded datasets get the same Catalog shape at runtime from src/lib/catalog (auto roles).
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { bundledDatasetIds } from "./datasets"
import type {
  Catalog,
  CatalogColumn,
  CatalogJoin,
  CatalogMetric,
  CatalogTable,
  CatalogValue,
  ChartType,
  ColumnRole,
  DatasetInfo,
  PlanRule,
  ResultSet,
  TryPrompt,
} from "../shared/contract"

const ROOT = path.resolve(import.meta.dir, "..")
const DATASETS = bundledDatasetIds(ROOT)

// The semantic files name a few charts differently from the contract.
const CHART_ALIASES: Record<string, ChartType> = {
  bubble_scatter: "bubble",
  bar_ranked: "hbar",
  diverging_bar: "hbar",
  stacked_column: "stacked_bar",
  ranked_bar: "hbar",
}
const toChart = (c?: string): ChartType | undefined => (c ? (CHART_ALIASES[c] ?? (c as ChartType)) : undefined)

type SemColumn = {
  label?: string
  description?: string
  role?: ColumnRole
  agg?: CatalogColumn["agg"]
  weight?: string
  additive?: boolean
  unit?: string
  grain?: CatalogColumn["grain"]
  fk?: string
  synonyms?: string[]
  values?: Record<string, string[]>
  binnable?: boolean | { width?: number }
  format?: CatalogColumn["format"]
  scale?: "log" | "linear"
  sortBy?: string
  direction?: 1 | -1 | 0
}
type SemTable = {
  /** metadata/helper table: shown in the explorer, never offered to the planner */
  hidden?: boolean
  label?: string
  description?: string
  synonyms?: string[]
  display?: string
  /** curated column names (FK columns render as their referenced display name) preferred over the
   *  compiler's own heuristic when listing this table's rows — see CatalogTable.listColumns. */
  listColumns?: string[]
  columns?: Record<string, SemColumn>
  inheritMeasuresFrom?: string
}
type Semantic = {
  id: string
  title: string
  tagline: string
  source?: { name: string; url: string }
  license?: { id: string; url: string } | string
  attribution?: string
  defaultFact?: string
  tables: Record<string, SemTable>
  joins?: CatalogJoin[]
  metrics?: Record<string, { label: string; sql: string; table: string; synonyms?: string[]; unit?: string; format?: string; description?: string }>
  rules?: string[]
  caveats?: string[]
  tryPrompts?: { text: string; chart?: string; sql?: string }[]
  morePrompts?: { text: string; chart?: string; sql?: string }[]
  /** v0.2: declarative compile rules, passed through verbatim — see src/lib/plan/rules.ts. */
  planRules?: PlanRule[]
  relationship?: Catalog["relationship"]
  groupLabels?: Record<string, string>
}

const humanize = (s: string) =>
  s
    .replace(/_/g, " ")
    .replace(/\bpct\b/g, "%")
    .replace(/\busd\b/g, "USD")
    .replace(/^./, (c) => c.toUpperCase())

function inferRole(name: string, sqlType: string, isPk: boolean, distinct: number, rows: number): ColumnRole {
  const t = sqlType.toUpperCase()
  if (isPk && rows > 0 && distinct === rows) return "id"
  if (/(^|_)id$/.test(name)) return "id"
  if (/year|decade/.test(name) && /INT/.test(t)) return "time"
  if (/date|_at$/.test(name)) return "date"
  if (/lat(itude)?$/.test(name)) return "latitude"
  if (/(lon|lng|longitude)$/.test(name)) return "longitude"
  if (/INT|REAL|NUM|DEC|DOUB|FLOA/.test(t)) return distinct <= 2 ? "flag" : "measure"
  if (/url|link/.test(name)) return "url"
  if (distinct <= 60) return "dimension"
  return "label"
}

function buildOne(id: string) {
  const dbPath = path.join(ROOT, "data", `${id}.sqlite`)
  const sem: Semantic = JSON.parse(readFileSync(path.join(ROOT, "data", `${id}.semantic.json`), "utf8"))
  const db = new Database(dbPath, { readonly: true })
  const q = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
    db.query(sql).all(...(params as never[])) as T[]

  const about = Object.fromEntries(
    (() => {
      try {
        return q<{ key: string; value: string }>("SELECT key, value FROM _about").map((r) => [r.key, r.value])
      } catch {
        return []
      }
    })(),
  ) as Record<string, string>
  const builtDate = (about.built_at ?? new Date().toISOString()).slice(0, 10)

  const objects = q<{ name: string; type: string }>(
    "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )

  const tables: CatalogTable[] = []
  const joins: CatalogJoin[] = [...(sem.joins ?? [])]
  const values: CatalogValue[] = []

  for (const obj of objects) {
    const st = sem.tables[obj.name]
    const hidden = obj.name.startsWith("_") || obj.type === "view" || !st || st.hidden === true
    const rowCount = (q<{ n: number }>(`SELECT COUNT(*) AS n FROM "${obj.name}"`)[0]?.n ?? 0) as number
    const info = q<{ name: string; type: string; pk: number; hidden: number }>(`PRAGMA table_xinfo("${obj.name}")`)
    const inherit = st?.inheritMeasuresFrom ? sem.tables[st.inheritMeasuresFrom]?.columns ?? {} : {}

    const columns: CatalogColumn[] = info.map((c) => {
      const stats = q<{ d: number; n: number; mn: number | null; mx: number | null; isoDate: number; hasTimeOfDay: number; total: number }>(
        `SELECT COUNT(DISTINCT "${c.name}") AS d, SUM("${c.name}" IS NULL) AS n,
                MIN(CASE WHEN typeof("${c.name}") IN ('integer','real') THEN "${c.name}" END) AS mn,
                MAX(CASE WHEN typeof("${c.name}") IN ('integer','real') THEN "${c.name}" END) AS mx,
                SUM(CASE WHEN typeof("${c.name}") = 'text' AND "${c.name}" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN 1 ELSE 0 END) AS isoDate,
                SUM(CASE WHEN typeof("${c.name}") = 'text' AND "${c.name}" GLOB '*[0-9][0-9]:[0-9][0-9]*' THEN 1 ELSE 0 END) AS hasTimeOfDay,
                SUM(CASE WHEN "${c.name}" IS NOT NULL THEN 1 ELSE 0 END) AS total
         FROM "${obj.name}"`,
      )[0]
      const sc: SemColumn = st?.columns?.[c.name] ?? inherit[c.name] ?? {}
      const role = sc.role ?? inferRole(c.name, c.type, c.pk > 0, stats.d, rowCount)
      // A "date" role promises a real, parseable calendar value; warn (never silently fix) when a
      // column claiming that role is mostly NOT ISO-looking text, so a source-table quirk like
      // Swift's year-less "March 17" gets caught instead of quietly misbehaving as a time axis.
      if (role === "date" && stats.total > 0 && stats.isoDate / stats.total < 0.8) {
        console.warn(`  ⚠ ${id}.${obj.name}.${c.name}: role "date" but only ${Math.round((100 * stats.isoDate) / stats.total)}% of values look ISO-formatted`)
      }
      const hasTime = role === "date" && stats.total > 0 && stats.hasTimeOfDay / stats.total >= 0.5
      const binnable = sc.binnable === undefined ? undefined : Boolean(sc.binnable)
      const binWidth = typeof sc.binnable === "object" ? sc.binnable.width : undefined
      const weight = sc.weight ? (sc.weight.includes(".") ? sc.weight : `${obj.name}.${sc.weight}`) : undefined
      const col: CatalogColumn = {
        key: `${obj.name}.${c.name}`,
        table: obj.name,
        name: c.name,
        label: sc.label ?? humanize(c.name),
        description: sc.description,
        sqlType: c.type || "",
        role: hidden && role !== "hidden" ? role : role,
        agg: sc.agg ?? (role === "measure" ? "sum" : undefined),
        weight,
        additive: sc.additive,
        unit: sc.unit,
        grain: sc.grain ?? (role === "time" ? (/decade/.test(c.name) ? "decade" : "year") : undefined),
        fk: sc.fk,
        synonyms: sc.synonyms ?? [],
        distinctCount: stats.d,
        nullCount: stats.n ?? 0,
        min: stats.mn ?? undefined,
        max: stats.mx ?? undefined,
        binnable,
        binWidth,
        format: sc.format,
        scale: sc.scale,
        sortBy: sc.sortBy,
        direction: sc.direction,
        hasTime: hasTime || undefined,
      }
      return col
    })

    // Declared foreign keys join the semantic ones (deduplicated below).
    if (!hidden) {
      for (const fk of q<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list("${obj.name}")`)) {
        joins.push({ from: `${obj.name}.${fk.from}`, to: `${fk.table}.${fk.to}`, kind: "many-to-one" })
      }
    }

    // Filterable values: categories and labels (with aliases), ISO3 codes with their country name.
    if (!hidden) {
      for (const col of columns) {
        const sc = st?.columns?.[col.name] ?? {}
        const aliases = sc.values ?? {}
        const isCat = col.role === "dimension" || (col.role === "label" && (col.distinctCount ?? 0) <= 2500)
        if (isCat && (col.distinctCount ?? 0) <= 2500) {
          for (const r of q<{ v: string }>(
            `SELECT DISTINCT "${col.name}" AS v FROM "${obj.name}" WHERE "${col.name}" IS NOT NULL AND typeof("${col.name}") = 'text'`,
          )) {
            values.push({ column: col.key, value: r.v, aliases: aliases[r.v] ?? [] })
          }
        }
        // Semantic-only aliases for values that are not literally stored (e.g. "world" kind).
        for (const [v, al] of Object.entries(aliases)) {
          if (!values.some((x) => x.column === col.key && x.value === v)) values.push({ column: col.key, value: v, aliases: al })
        }
      }
    }

    tables.push({
      name: obj.name,
      label: st?.label ?? humanize(obj.name),
      description: st?.description ?? (obj.type === "view" ? "Convenience view" : ""),
      synonyms: st?.synonyms ?? [],
      rowCount,
      display: st?.display,
      listColumns: st?.listColumns,
      hidden,
      isView: obj.type === "view",
      columns,
    })
  }

  // Latest well-covered year per measure (World Bank: indicators.latest_year by column name),
  // shared by every table that carries the same measure column (country_year, aggregate_year).
  try {
    const latest = new Map(
      q<{ column_name: string; latest_year: number }>("SELECT column_name, latest_year FROM indicators").map((r) => [
        r.column_name,
        r.latest_year,
      ]),
    )
    for (const t of tables) for (const c of t.columns) if (c.role === "measure" && latest.has(c.name)) c.latestYear = latest.get(c.name)
    // derived total CO2 follows its per-person source
    for (const t of tables)
      for (const c of t.columns) if (c.name === "co2_total_mt" && latest.has("co2_per_capita_t")) c.latestYear = latest.get("co2_per_capita_t")
  } catch {
    // no indicators table (Nobel): nothing to do
  }

  // Deduplicate joins.
  const seen = new Set<string>()
  const uniqJoins = joins.filter((j) => {
    const k = `${j.from}>${j.to}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const metrics: CatalogMetric[] = Object.entries(sem.metrics ?? {}).map(([key, m]) => ({
    key,
    label: m.label,
    description: m.description,
    sql: m.sql,
    table: m.table,
    synonyms: m.synonyms ?? [],
    unit: m.unit,
    format: (m.format as CatalogMetric["format"]) ?? undefined,
  }))

  const prompts = [...(sem.tryPrompts ?? []), ...(sem.morePrompts ?? [])]
  const tryPrompts: TryPrompt[] = prompts.map((p) => ({ text: p.text, chart: toChart(p.chart) }))

  const visible = tables.filter((t) => !t.hidden)
  const schemaHash = createHash("sha256")
    .update(JSON.stringify(visible.map((t) => [t.name, t.columns.map((c) => [c.name, c.sqlType, c.role])])))
    .digest("hex")
    .slice(0, 16)

  const license = typeof sem.license === "string" ? sem.license : sem.license?.id
  const attribution = (sem.attribution ?? "").replace("<BUILD_DATE>", builtDate)

  const catalog: Catalog = {
    datasetId: id,
    title: sem.title,
    tagline: sem.tagline,
    about: sem.tagline,
    contains: visible.map((t) => t.label.toLowerCase()),
    tables,
    joins: uniqJoins,
    metrics,
    values: values.slice(0, 6000),
    rules: sem.rules ?? sem.caveats ?? [],
    tryPrompts,
    defaultFact: sem.defaultFact,
    schemaHash,
    attribution,
    license,
    planRules: sem.planRules,
    relationship: sem.relationship,
    groupLabels: sem.groupLabels,
  }

  // Reference results for every curated prompt (fixtures for charts + stubs).
  const fixtures = prompts
    .filter((p) => p.sql)
    .map((p) => {
      const t0 = performance.now()
      const stmt = db.query(p.sql!)
      const rows = stmt.values() as ResultSet["rows"]
      const result: ResultSet = {
        columns: stmt.columnNames,
        rows,
        truncated: false,
        elapsedMs: Math.round(performance.now() - t0),
      }
      return { datasetId: id, text: p.text, chart: toChart(p.chart), sql: p.sql!, result }
    })

  const info: DatasetInfo = {
    id,
    title: sem.title,
    tagline: sem.tagline,
    kind: "bundled",
    attribution,
    license,
    sourceUrl: sem.source?.url,
    sizeBytes: readFileSync(dbPath).byteLength,
    tableCount: visible.length,
  }

  db.close()
  return { catalog, fixtures, info, bytes: readFileSync(dbPath) }
}

mkdirSync(path.join(ROOT, "public", "data"), { recursive: true })
mkdirSync(path.join(ROOT, "src", "fixtures"), { recursive: true })

const infos: DatasetInfo[] = []
const allFixtures: unknown[] = []
for (const id of DATASETS) {
  const { catalog, fixtures, info, bytes } = buildOne(id)
  writeFileSync(path.join(ROOT, "public", "data", `${id}.catalog.json`), JSON.stringify(catalog))
  writeFileSync(path.join(ROOT, "public", "data", `${id}.sqlite.gz`), Bun.gzipSync(bytes, { level: 9 }))
  infos.push(info)
  allFixtures.push(...fixtures)
  const vis = catalog.tables.filter((t) => !t.hidden)
  console.log(
    `${id}: ${vis.length} tables, ${vis.reduce((n, t) => n + t.columns.length, 0)} columns, ` +
      `${catalog.joins.length} joins, ${catalog.metrics.length} metrics, ${catalog.values.length} values, ` +
      `${fixtures.length} fixtures, schema ${catalog.schemaHash}`,
  )
}
writeFileSync(path.join(ROOT, "public", "data", "datasets.json"), JSON.stringify(infos, null, 2))
writeFileSync(path.join(ROOT, "src", "fixtures", "try-results.json"), JSON.stringify(allFixtures))

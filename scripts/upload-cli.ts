#!/usr/bin/env bun
/**
 * OWNER: catalog/planner (this task). Dev harness for UPLOADED data: loads a `.sql` dump (through
 * normalizeDump, same as the browser's importer), a `.csv` (papaparse + the same type inference as
 * db.worker.ts's importCsv), or a `.sqlite`/`.db` file into bun:sqlite; builds the catalog with
 * buildAutoCatalog(info, queryFn) EXACTLY as the browser does (a QueryFn over bun:sqlite in place
 * of sqlite-wasm); then runs questions through the same planner pipeline as scripts/plan-cli.ts
 * (candidates -> a direct Jev call -> interpret -> compile), executes the SQL, and prints the
 * answer, the plan, the SQL, the row count and the chart-eligibility for the result.
 *
 * This script never special-cases a table or column name — everything it does to build the
 * catalog is exactly what src/lib/catalog's buildAutoCatalog does for any uploaded database.
 *
 *   bun scripts/upload-cli.ts --file data.sql --file staff.csv --q "total revenue by store"
 *   bun scripts/upload-cli.ts --file chinook.sqlite --suite chinook
 *   bun scripts/upload-cli.ts --suite sample                 # auto-generates the sample files
 *   bun scripts/upload-cli.ts --suite energy                 # auto-generates the CSV
 *   bun scripts/upload-cli.ts --file energy.csv --prompts    # print suggestPrompts(catalog)
 *   bun scripts/upload-cli.ts --file data.sql --q "..." --offline   # force the offline planner
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import Papa from "papaparse"
import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { Catalog, Cell, DatasetInfo, JevMeta, PlanAnswers, QueryFn, ResultSet } from "@shared/contract"
import { normalizePlanAnswers, planQuestions, planState, type RawPlanAnswers } from "@shared/jev/questions"
import { buildAutoCatalog } from "@/lib/catalog"
import { findCandidates } from "@/lib/plan/candidates"
import { compilePlan } from "@/lib/plan/compile"
import { interpretAnswers } from "@/lib/plan/interpret"
import { offlineAnswers } from "@/lib/plan/offline"
import { buildPlanRequest } from "@/lib/plan/request"
import { normalizeDump, splitStatements } from "@/lib/db/sql-normalize"
import { eligibleCharts, profileResult } from "@/lib/viz"
import { sampleCsv, sampleDump } from "@/components/data/samples"

const ROOT = path.resolve(import.meta.dir, "..")
// Outside the repo on purpose (test-schema fixtures: the sample dump/CSV and the
// generated energy CSV — are never committed; Chinook's downloaded .sqlite never is either).
const SCRATCH_DIR = path.join(os.tmpdir(), "auradash-bi-upload-cli")

// ─────────────────────────────── Jev (mirrors scripts/plan-cli.ts) ───────────────────────────────

function loadDevVars(): Record<string, string> {
  try {
    const text = readFileSync(path.join(ROOT, ".dev.vars"), "utf8")
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "")
    }
    return out
  } catch {
    return {}
  }
}

const devVars = loadDevVars()
const apiKey = devVars.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY
const model = devVars.JEV_MODEL ?? process.env.JEV_MODEL ?? "jev-latest"
const jev = apiKey ? new TypeSafeClient({ apiKey, defaultModel: model, timeout: 4000, retry: { maxRetries: 0 } }) : undefined

// ─────────────────────────────── bun:sqlite QueryFn (mirrors db.worker.ts's handleQuery) ───────────────────────────────

function bunQueryFn(db: Database): QueryFn {
  return async (sql: string, params: Cell[] = []): Promise<ResultSet> => {
    const statements = splitStatements(sql)
    if (statements.length === 0) throw new Error("Empty query.")
    if (statements.length > 1) throw new Error("Only one SQL statement is allowed here.")
    const trimmed = statements[0]!.trim()
    if (!/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(trimmed)) throw new Error("Only read-only queries (SELECT, ...) are allowed here.")

    const t0 = performance.now()
    const stmt = db.query(trimmed)
    try {
      const cap = 5000
      const raw = stmt.values(...(params as Cell[])) as unknown[][]
      const rows: Cell[][] = raw.slice(0, cap).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : (v as Cell))))
      return { columns: stmt.columnNames, rows, truncated: raw.length > cap, elapsedMs: Math.round(performance.now() - t0) }
    } finally {
      stmt.finalize()
    }
  }
}

// ─────────────────────────────── loading files (mirrors db.worker.ts's handleImport) ───────────────────────────────

function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false
  let head = ""
  for (let i = 0; i < 16; i++) head += String.fromCharCode(bytes[i]!)
  return head === "SQLite format 3\0"
}

function sanitizeTableName(filename: string, used: Set<string>): string {
  let base = filename
    .replace(/\.[^./\\]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!base) base = "table"
  if (/^[0-9]/.test(base)) base = `t_${base}`
  let name = base
  let n = 2
  while (used.has(name)) name = `${base}_${n++}`
  used.add(name)
  return name
}

/** Same inference as db.worker.ts's importCsv: numeric unless any row has a non-numeric value. */
function inferCsvColumnTypes(fields: string[], rows: Record<string, unknown>[]): ("INTEGER" | "REAL" | "TEXT")[] {
  const sawNumber = fields.map(() => false)
  const sawReal = fields.map(() => false)
  const sawOther = fields.map(() => false)
  for (const row of rows) {
    fields.forEach((f, i) => {
      const v = row[f]
      if (v === null || v === undefined || v === "") return
      if (typeof v === "number") {
        sawNumber[i] = true
        if (!Number.isInteger(v)) sawReal[i] = true
      } else if (typeof v === "boolean") {
        sawNumber[i] = true
      } else {
        sawOther[i] = true
      }
    })
  }
  return fields.map((_, i) => (sawOther[i] || !sawNumber[i] ? "TEXT" : sawReal[i] ? "REAL" : "INTEGER"))
}

function importCsvText(db: Database, text: string, filename: string, tableName: string): { rows: number; warnings: string[] } {
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, dynamicTyping: true, skipEmptyLines: true })
  const warnings = (parsed.errors ?? []).slice(0, 5).map((e) => `${filename}: ${e.message}${e.row !== undefined ? ` (row ${e.row})` : ""}`)

  const rawFields = parsed.meta.fields ?? []
  const seen = new Map<string, number>()
  const colNames = rawFields.map((f) => {
    const clean = f.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "col"
    const n = (seen.get(clean) ?? 0) + 1
    seen.set(clean, n)
    return n === 1 ? clean : `${clean}_${n}`
  })
  const types = inferCsvColumnTypes(rawFields, parsed.data)

  db.exec(`CREATE TABLE "${tableName}" (${colNames.map((c, i) => `"${c}" ${types[i]}`).join(", ")})`)
  if (rawFields.length === 0) return { rows: 0, warnings }

  const stmt = db.prepare(`INSERT INTO "${tableName}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${colNames.map(() => "?").join(", ")})`)
  let rows = 0
  try {
    const insertAll = db.transaction((data: Record<string, unknown>[]) => {
      for (const row of data) {
        const values = rawFields.map((f) => {
          const v = row[f]
          return v === undefined || v === "" ? null : (v as Cell)
        })
        stmt.run(...(values as Cell[]))
        rows++
      }
    })
    insertAll(parsed.data)
  } finally {
    stmt.finalize()
  }
  return { rows, warnings }
}

/** Loads one or more local files into a fresh bun:sqlite database, exactly like importDataset:
 *  a single .sqlite/.db is opened as-is; any mix of .sql dumps and .csv files is executed/imported
 *  into a new in-memory database. */
function loadFiles(filePaths: string[]): Database {
  if (filePaths.length === 0) throw new Error("No --file given.")
  const bytesByPath = new Map(filePaths.map((fp) => [fp, new Uint8Array(readFileSync(fp))]))
  const sqliteFiles = filePaths.filter((fp) => isSqliteFile(bytesByPath.get(fp)!))

  if (sqliteFiles.length === 1 && filePaths.length === 1) {
    console.log(`  loading "${path.basename(filePaths[0]!)}" as a SQLite database`)
    return new Database(filePaths[0]!, { readonly: true })
  }

  const db = new Database(":memory:")
  const used = new Set<string>()
  for (const fp of filePaths.filter((f) => /\.sql$/i.test(f))) {
    const text = readFileSync(fp, "utf8")
    const { statements, warnings } = normalizeDump(text)
    for (const w of warnings) console.log(`  [warn] ${path.basename(fp)}: ${w}`)
    let executed = 0
    for (const stmt of statements) {
      try {
        db.exec(stmt)
        executed++
      } catch (e) {
        console.log(`  [skip] ${path.basename(fp)}: ${(e as Error).message} :: ${stmt.slice(0, 120)}`)
      }
    }
    console.log(`  loaded "${path.basename(fp)}": ${executed}/${statements.length} statements executed`)
  }
  for (const fp of filePaths.filter((f) => /\.csv$/i.test(f))) {
    const tableName = sanitizeTableName(path.basename(fp), used)
    const { rows, warnings } = importCsvText(db, readFileSync(fp, "utf8"), path.basename(fp), tableName)
    for (const w of warnings) console.log(`  [warn] ${w}`)
    console.log(`  loaded "${path.basename(fp)}" as table "${tableName}": ${rows} rows`)
  }
  for (const fp of sqliteFiles) console.log(`  [skip] "${path.basename(fp)}" is a SQLite database; it can only be imported on its own.`)
  return db
}

function listTables(db: Database): string[] {
  const rows = db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").values() as unknown[][]
  return rows.map((r) => r[0] as string)
}

// ─────────────────────────────── test schema fixtures ───────────────────────────────

function ensureScratchDir(): void {
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true })
}

/** (a) the built-in "Try a sample" dump + CSV, exported verbatim from samples.ts. */
function materializeSampleFiles(): string[] {
  ensureScratchDir()
  const sqlPath = path.join(SCRATCH_DIR, "coffee_shop.sql")
  const csvPath = path.join(SCRATCH_DIR, "staff.csv")
  writeFileSync(sqlPath, sampleDump.sqlText, "utf8")
  writeFileSync(csvPath, sampleCsv.csvText, "utf8")
  return [sqlPath, csvPath]
}

/** (c) a CSV-only dataset generated here: monthly energy readings per site, no FKs at all — a
 *  single flat table, the opposite shape from (a)/(b), to prove the catalog builder needs no
 *  relational structure to find a date column, a dimension and several measures. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateEnergyCsv(): string {
  const rand = mulberry32(20250601)
  const sites = ["Downtown", "Riverside", "Harbourfront", "Uplands", "Eastgate"]
  const rows: string[] = ["reading_date,site,kwh_consumed,cost_usd,avg_temp_c,peak_demand_kw"]
  for (let year = 2023; year <= 2024; year++) {
    for (let month = 1; month <= 12; month++) {
      const seasonal = 1 + 0.35 * Math.cos(((month - 1) / 12) * 2 * Math.PI) // higher in winter months
      for (const site of sites) {
        const base = 8000 + rand() * 4000
        const kwh = Math.round(base * seasonal)
        const costUsd = Math.round(kwh * (0.14 + rand() * 0.03) * 100) / 100
        const avgTempC = Math.round((22 - 12 * Math.cos(((month - 1) / 12) * 2 * Math.PI) + (rand() * 4 - 2)) * 10) / 10
        const peakDemandKw = Math.round((kwh / 24 / 30) * (1.4 + rand() * 0.3) * 10) / 10
        const date = `${year}-${String(month).padStart(2, "0")}-01`
        rows.push(`${date},${site},${kwh},${costUsd},${avgTempC},${peakDemandKw}`)
      }
    }
  }
  return rows.join("\n") + "\n"
}

function materializeEnergyFile(): string[] {
  ensureScratchDir()
  const csvPath = path.join(SCRATCH_DIR, "energy_readings.csv")
  writeFileSync(csvPath, generateEnergyCsv(), "utf8")
  return [csvPath]
}

// ─────────────────────────────── suites: 8-10 questions per test schema ───────────────────────────────

const SUITES: Record<string, string[]> = {
  sample: [
    "Total revenue by store", // totals by a dimension reached through an FK (sales -> stores)
    "Units sold by product, top 5", // top N by a sum
    "Revenue by month", // trend by month from a DATE column
    "Sales in Portland", // a filter on a named value
    "How many sales are there?", // a count
    "Share of revenue by category", // a share (category reached via sales -> products)
    "Distribution of quantity per sale", // a distribution
    "Average hourly rate by role", // a second, unrelated CSV table (staff) with its own dimension
    "Which store sold the most coffee?", // filter + ranking
    "What's the weather in Paris tomorrow?", // out of scope
  ],
  chinook: [
    "Total sales by country", // totals by a dimension reached through an FK (invoices -> customers)
    "Top 10 artists by tracks sold", // top N by a sum, two FK hops away
    "Sales trend by month", // trend by month from a DATE column (Invoice.InvoiceDate)
    "Sales in the USA", // a filter on a named value
    "How many customers are there?", // a count
    "Share of sales by genre", // a share
    "Distribution of unit price", // a distribution
    "How many customers does each employee support?", // ranking via FK
    "Average invoice total by country", // avg measure by dimension
    "What's the capital of France?", // out of scope
  ],
  energy: [
    "Total energy consumption by site", // totals by a (plain, non-FK) dimension
    "Top 3 sites by energy cost", // top N by a sum
    "Energy cost trend by month", // trend by month from a DATE column
    "Energy usage at the Downtown site", // a filter on a named value
    "How many readings are there?", // a count
    "Share of total cost by site", // a share
    "Distribution of average temperature", // a distribution
    "Energy cost by site and month", // 2D breakdown (dimension + time)
    "Average peak demand per reading", // a plain aggregate, no grouping
    "What's the population of Mars?", // out of scope
  ],
}

// ─────────────────────────────── one question, end to end (mirrors scripts/plan-cli.ts's runOne) ───────────────────────────────

function fmtProb(p: Record<string, number>, n = 3): string {
  return Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join(" ")
}

interface RunResult {
  ok: boolean
  status: string
  rowCount: number
  chartEligible: string[]
  error?: string
}

async function runOne(catalog: Catalog, db: Database, question: string, opts: { offline: boolean }): Promise<RunResult> {
  const candidates = findCandidates(question, catalog)
  const req = buildPlanRequest(question, catalog, candidates)

  let answers: PlanAnswers
  let meta: JevMeta
  const t0 = performance.now()
  if (!opts.offline && jev) {
    const questions = planQuestions(req)
    try {
      const res = await jev.systemOne({ state: planState(req), questions })
      meta = { source: "jev", model: res.model, latencyMs: Math.round(performance.now() - t0), questionCount: Object.keys(questions).length }
      answers = normalizePlanAnswers(res.answers as unknown as RawPlanAnswers, req)
    } catch (err) {
      console.log(`    [jev error, falling back to offline] ${err instanceof Error ? err.message : err}`)
      answers = offlineAnswers(req)
      meta = { source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason: "jev_error" }
    }
  } else {
    answers = offlineAnswers(req)
    meta = { source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason: opts.offline ? "forced" : "no_key" }
  }

  console.log(`\n=== "${question}" (${meta.source}, ${meta.latencyMs}ms, q=${meta.questionCount}) ===`)
  console.log(`  filters found: ${candidates.filters.map((f) => `${f.kind}:${f.display}(${f.column})`).join(", ") || "(none)"}  numbers: ${candidates.numbers.join(",") || "(none)"}`)
  console.log(`  in_scope=${answers.inScope.toFixed(2)} answerKind=${answers.answerKind.value}(${answers.answerKind.confidence.toFixed(2)}) [${fmtProb(answers.answerKind.probabilities)}]`)
  console.log(`  measure=${answers.measure.value} measure2=${answers.measure2.value} groupBy=${answers.groupBy.value} timeGrain=${answers.timeGrain.value} sort=${answers.sort.value} limit=${answers.limit.value}`)

  const interpretation = interpretAnswers(answers, req, catalog)
  console.log(`  status=${interpretation.status} confidence=${interpretation.confidence.toFixed(2)}${interpretation.message ? ` message="${interpretation.message}"` : ""}`)
  if (!interpretation.plan) {
    return { ok: interpretation.status === "out_of_scope", status: interpretation.status, rowCount: 0, chartEligible: [] }
  }
  console.log(`  plan: ${JSON.stringify(interpretation.plan)}`)

  try {
    const compiled = compilePlan(interpretation.plan, catalog)
    console.log(`  sql: ${compiled.sql}`)
    console.log(`  params: ${JSON.stringify(compiled.params)}`)
    console.log(`  title: ${compiled.title}${compiled.subtitle ? ` (${compiled.subtitle})` : ""}`)
    const result = await bunQueryFn(db)(compiled.sql, compiled.params)
    console.log(`  rows: ${result.rows.length}  columns: ${compiled.columns.map((c) => `${c.name}:${c.kind}`).join(", ")}`)
    console.log(`  first rows: ${JSON.stringify(result.rows.slice(0, 5))}`)
    const profile = profileResult(result, compiled.columns)
    const chartEligible = eligibleCharts(profile)
    console.log(`  chart eligible: ${chartEligible.join(", ")}`)
    return { ok: true, status: interpretation.status, rowCount: result.rows.length, chartEligible }
  } catch (err) {
    console.log(`  COMPILE/SQL ERROR: ${err instanceof Error ? err.stack : err}`)
    return { ok: false, status: "error", rowCount: 0, chartEligible: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// ─────────────────────────────── catalog summary ───────────────────────────────

function printCatalogSummary(catalog: Catalog): void {
  console.log(`\ncatalog: ${catalog.title} — ${catalog.about}`)
  console.log(`  defaultFact: ${catalog.defaultFact ?? "(none)"}`)
  console.log(`  metrics: ${catalog.metrics.map((m) => `${m.key}="${m.label}" (${m.sql})`).join("; ") || "(none)"}`)
  for (const t of catalog.tables) {
    if (t.hidden) continue
    const cols = t.columns.map((c) => `${c.name}:${c.role}${c.role === "measure" ? `/${c.agg}` : ""}${c.fk ? `->${c.fk}` : ""}`).join(", ")
    console.log(`  table ${t.name} (label="${t.label}", display=${t.display ?? "none"}, rows=${t.rowCount}, synonyms=[${t.synonyms.slice(0, 6).join(",")}]): ${cols}`)
  }
  console.log(`  tryPrompts: ${catalog.tryPrompts.map((p) => `"${p.text}"`).join(", ")}`)
}

// ─────────────────────────────── main ───────────────────────────────

function argValues(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]!)
  return out
}
function argValue(args: string[], flag: string): string | undefined {
  return argValues(args, flag)[0]
}

async function main() {
  const args = process.argv.slice(2)
  const offline = args.includes("--offline")
  const suiteName = argValue(args, "--suite")
  const question = argValue(args, "--q")
  const wantsPrompts = args.includes("--prompts")
  let files = argValues(args, "--file")

  if (suiteName && !SUITES[suiteName]) {
    console.log(`Unknown --suite "${suiteName}". Known suites: ${Object.keys(SUITES).join(", ")}`)
    process.exit(1)
  }
  if (files.length === 0 && suiteName === "sample") files = materializeSampleFiles()
  if (files.length === 0 && suiteName === "energy") files = materializeEnergyFile()
  if (files.length === 0) {
    console.log('usage: bun scripts/upload-cli.ts --file <path> [--file <path> ...] (--q "question" | --suite <sample|chinook|energy> | --prompts) [--offline]')
    console.log(`  --suite sample and --suite energy auto-generate their fixture files under ${SCRATCH_DIR}`)
    console.log('  --suite chinook needs --file pointing at a downloaded Chinook_Sqlite.sqlite')
    process.exit(1)
  }

  console.log(`loading ${files.length} file(s):`)
  const db = loadFiles(files)
  const tables = listTables(db)
  console.log(`  tables: ${tables.join(", ")}`)

  const info: DatasetInfo = { id: "up_cli", title: suiteName ?? path.basename(files[0]!), tagline: "", kind: "upload" }
  const catalog = await buildAutoCatalog(info, bunQueryFn(db))
  printCatalogSummary(catalog)

  if (wantsPrompts) return

  const results: { question: string; r: RunResult }[] = []
  if (suiteName) {
    for (const q of SUITES[suiteName]!) results.push({ question: q, r: await runOne(catalog, db, q, { offline }) })
  } else if (question) {
    results.push({ question, r: await runOne(catalog, db, question, { offline }) })
  }

  if (results.length) {
    console.log("\n\n=== SUMMARY ===")
    console.log("question | status | rows | chart eligible | OK")
    for (const { question: q, r } of results) console.log(`${q} | ${r.status} | ${r.rowCount} | ${r.chartEligible.join("/")} | ${r.ok ? "OK" : "FAIL"}`)
    const failed = results.filter((x) => !x.r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} OK`)
    if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.question}: ${f.r.error ?? f.r.status}`)
  }
}

await main()

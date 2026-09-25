/**
 * OWNER: data-engine. The ONE module worker that owns every @sqlite.org/sqlite-wasm `oo1.DB`
 * (oo1 API only — Worker1/Promiser are deprecated). Spawned by src/lib/db/rpc.ts and talked to
 * only through the typed request/response messages defined there; app code never imports this
 * file directly.
 *
 * Handles: query (bundled + uploaded datasets, one read-only statement, row cap, BigInt→Number,
 * friendly errors), import (.sqlite/.db, normalized .sql dumps via sql-normalize, .csv via
 * papaparse), delete, export. Persistence: idb-keyval `db:<id>` (exported bytes) and the
 * `datasets:v1` metadata list (uploads only — bundled datasets come from /data/datasets.json).
 */
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { del, get, set } from "idb-keyval"
import Papa from "papaparse"
import type { Cell, DatasetId, DatasetInfo, ResultSet } from "@shared/contract"
import { normalizeDump, splitStatements } from "@/lib/db/sql-normalize"
import { checkUserSql } from "@/lib/db/policy"
import type { ImportFile, ImportReportWire, RpcMethod, RpcMethods, RpcRequest, RpcResponse } from "@/lib/db/rpc"

const DATASETS_KEY = "datasets:v1"
const MAX_IMPORT_BYTES = 100 * 1024 * 1024
const SQLITE_MAGIC = "SQLite format 3\0"
/** Hard ceiling on rows returned to the UI, regardless of what a caller asks for. */
const HARD_ROW_CAP = 5000
/** A query (trusted or not) is interrupted once it has run this long. */
const QUERY_TIMEOUT_MS = 4000
/** How many VM instructions the progress handler lets run between checks (~sub-ms granularity). */
const PROGRESS_HANDLER_INTERVAL_OPS = 1000
/** Display cells longer than this are truncated — keeps huge text fields from bloating the grid. */
const MAX_CELL_TEXT_LENGTH = 5000

let sqlite3Promise: Promise<Sqlite3Static> | null = null
function getSqlite3(): Promise<Sqlite3Static> {
  sqlite3Promise ??= sqlite3InitModule()
  return sqlite3Promise
}

/** Open datasets stay open for the life of the worker (bundled + this session's uploads). */
const openDbs = new Map<DatasetId, Database>()

/** Strips sqlite-wasm's "sqlite3 result code N: " boilerplate, keeping the human message. */
function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = raw.match(/^sqlite3 result code \d+:\s*(.+)$/is)
  return (m?.[1] ?? raw).trim()
}

function isSqliteMagic(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 16) return false
  let head = ""
  const bytes = new Uint8Array(buf, 0, 16)
  for (const b of bytes) head += String.fromCharCode(b)
  return head === SQLITE_MAGIC
}

function deserializeInto(sqlite3: Sqlite3Static, db: Database, bytes: Uint8Array): Database {
  const p = sqlite3.wasm.allocFromTypedArray(bytes)
  db.checkRc(
    sqlite3.capi.sqlite3_deserialize(
      db.pointer!,
      "main",
      p,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    ),
  )
  return db
}

async function loadUploadBytes(id: DatasetId): Promise<Uint8Array> {
  const bytes = await get<Uint8Array>(`db:${id}`)
  if (!bytes) throw new Error(`No stored data for "${id}" — it may have been deleted in another tab.`)
  return bytes
}

/** Fetches a bundled `.sqlite.gz`; inflates unless the host already decoded the Content-Encoding. */
async function fetchBundledBytes(id: DatasetId): Promise<Uint8Array> {
  const res = await fetch(`/data/${id}.sqlite.gz`)
  if (!res.ok) throw new Error(`Could not load the "${id}" dataset (${res.status}).`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const inflated = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")))
    return new Uint8Array(await inflated.arrayBuffer())
  }
  return buf
}

async function openDataset(id: DatasetId): Promise<Database> {
  const open = openDbs.get(id)
  if (open) return open
  const sqlite3 = await getSqlite3()
  const bytes = id.startsWith("up_") ? await loadUploadBytes(id) : await fetchBundledBytes(id)
  const db = deserializeInto(sqlite3, new sqlite3.oo1.DB(), bytes)
  // Every dataset opened for querying (bundled or a previously-imported upload) is read-only at
  // the engine level — the only writer is `handleImport`'s own short-lived connection.
  db.exec("PRAGMA query_only = ON")
  openDbs.set(id, db)
  return db
}

/**
 * Interrupts the running statement once it has been executing for longer than `timeoutMs`.
 * `sqlite3_progress_handler` fires every `PROGRESS_HANDLER_INTERVAL_OPS` VM instructions and, on a
 * non-zero return, aborts the current step from *inside* it — the only way to stop a single
 * `stmt.step()` call that never returns on its own (a recursive CTE with no terminating LIMIT, a
 * pathological join). Replaces whatever handler is registered on this connection, so calling it
 * again for the next query resets the clock. Registering it also covers trusted/compiled SQL —
 * cheap insurance against a bug in the planner or compiler, not just user-typed SQL.
 */
function armQueryTimeout(sqlite3: Sqlite3Static, db: Database, timeoutMs: number): void {
  const startedAt = performance.now()
  sqlite3.capi.sqlite3_progress_handler(db.pointer!, PROGRESS_HANDLER_INTERVAL_OPS, () => (performance.now() - startedAt > timeoutMs ? 1 : 0), 0)
}

/** Long text values are truncated for display so one huge cell can't bloat a whole result set. */
function truncateForDisplay(v: Cell): Cell {
  if (typeof v === "string" && v.length > MAX_CELL_TEXT_LENGTH) {
    return `${v.slice(0, MAX_CELL_TEXT_LENGTH)}… [truncated, ${v.length.toLocaleString()} chars]`
  }
  return v
}

// ─────────────────────────────── query ───────────────────────────────

async function handleQuery(p: RpcMethods["query"]["params"]): Promise<ResultSet> {
  // Untrusted (user-typed) SQL is checked again here, server-side, even though the caller
  // (lib/db/index.ts's queryUserSql) already checked it — never trust a single layer, and this
  // worker is the only place that can actually reach the database.
  if (p.untrusted) {
    const check = checkUserSql(p.sql)
    if (!check.ok) throw new Error(check.reason ?? "That query isn't allowed here.")
  }

  const sqlite3 = await getSqlite3()
  const db = await openDataset(p.datasetId)
  const statements = splitStatements(p.sql)
  if (statements.length === 0) throw new Error("Empty query.")
  if (statements.length > 1) throw new Error("Only one SQL statement is allowed here.")

  const t0 = performance.now()
  armQueryTimeout(sqlite3, db, QUERY_TIMEOUT_MS)
  const stmt = db.prepare(statements[0])
  try {
    if (!sqlite3.capi.sqlite3_stmt_readonly(stmt)) {
      throw new Error("Only read-only queries (SELECT, ...) are allowed here.")
    }
    if (p.params.length) stmt.bind(p.params as never)
    const columns = stmt.getColumnNames()
    const cap = Math.min(HARD_ROW_CAP, Math.max(1, p.maxRows))
    const rows: Cell[][] = []
    try {
      while (stmt.step()) {
        const raw = stmt.get([]) as unknown[]
        rows.push(raw.map((v) => truncateForDisplay(typeof v === "bigint" ? Number(v) : (v as Cell))))
        if (rows.length > cap) break
      }
    } catch (e) {
      if (performance.now() - t0 >= QUERY_TIMEOUT_MS - 50) {
        throw new Error(`Query stopped after ${Math.round(QUERY_TIMEOUT_MS / 1000)} s. Try adding a LIMIT or a WHERE.`, { cause: e })
      }
      throw e
    }
    const truncated = rows.length > cap
    if (truncated) rows.length = cap
    return { columns, rows, truncated, elapsedMs: Math.round(performance.now() - t0) }
  } finally {
    stmt.finalize()
  }
}

// ─────────────────────────────── import ───────────────────────────────

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

function importCsv(db: Database, file: ImportFile, tableName: string): { rows: number; warnings: string[] } {
  const text = new TextDecoder("utf-8").decode(file.bytes)
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, dynamicTyping: true, skipEmptyLines: true })
  const warnings = (parsed.errors ?? [])
    .slice(0, 5)
    .map((e) => `${file.name}: ${e.message}${e.row !== undefined ? ` (row ${e.row})` : ""}`)

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

  const placeholders = colNames.map(() => "?").join(", ")
  const stmt = db.prepare(`INSERT INTO "${tableName}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`)
  let rows = 0
  try {
    db.savepoint(() => {
      for (const row of parsed.data) {
        const values = rawFields.map((f) => {
          const v = row[f]
          return v === undefined || v === "" ? null : (v as Cell)
        })
        stmt.bind(values as never).stepReset()
        rows++
      }
    })
  } finally {
    stmt.finalize()
  }
  return { rows, warnings }
}

function listTables(db: Database): string[] {
  return db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as string[]
}

function countRows(db: Database, table: string): number {
  return Number(db.selectValue(`SELECT COUNT(*) FROM "${table}"`) ?? 0)
}

async function handleImport(p: RpcMethods["import"]["params"]): Promise<ImportReportWire> {
  const totalBytes = p.files.reduce((n, f) => n + f.bytes.byteLength, 0) + (p.sqlText?.length ?? 0)
  if (totalBytes > MAX_IMPORT_BYTES) {
    throw new Error(`That's ${Math.round(totalBytes / 1e6)} MB of data; the limit is 100 MB.`)
  }

  const sqlite3 = await getSqlite3()
  const warnings: string[] = []
  const skipped: { statement: string; error: string }[] = []
  let executed = 0
  let db: Database

  const sqliteFiles = p.files.filter((f) => isSqliteMagic(f.bytes))
  if (sqliteFiles.length === 1 && p.files.length === 1 && !p.sqlText) {
    db = new sqlite3.oo1.DB()
    deserializeInto(sqlite3, db, new Uint8Array(sqliteFiles[0].bytes))
    executed = 1
  } else {
    db = new sqlite3.oo1.DB()
    const used = new Set<string>()

    const sqlSources = [
      ...(p.sqlText ? [{ name: "pasted SQL", text: p.sqlText }] : []),
      ...p.files.filter((f) => /\.sql$/i.test(f.name)).map((f) => ({ name: f.name, text: new TextDecoder("utf-8").decode(f.bytes) })),
    ]
    for (const src of sqlSources) {
      const { statements, warnings: normWarnings } = normalizeDump(src.text)
      warnings.push(...normWarnings.map((w) => `${src.name}: ${w}`))
      for (const stmt of statements) {
        try {
          db.savepoint(() => db.exec(stmt))
          executed++
        } catch (e) {
          skipped.push({ statement: stmt.slice(0, 200), error: friendlyError(e) })
        }
      }
    }

    for (const f of p.files.filter((f) => /\.csv$/i.test(f.name))) {
      const tableName = sanitizeTableName(f.name, used)
      try {
        const { warnings: csvWarnings } = importCsv(db, f, tableName)
        warnings.push(...csvWarnings)
        executed++
      } catch (e) {
        skipped.push({ statement: `Import ${f.name}`, error: friendlyError(e) })
      }
    }

    for (const f of sqliteFiles) {
      warnings.push(`"${f.name}" is a SQLite database; it can only be imported on its own, so it was skipped.`)
    }
    if (executed === 0 && skipped.length === 0) {
      throw new Error("Nothing to import: no .sqlite/.db, .sql or .csv file, and no pasted SQL.")
    }
  }

  const id = `up_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`
  const tables = listTables(db).map((name) => ({ name, rows: countRows(db, name) }))
  const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer!)
  await set(`db:${id}`, bytes)
  // Writes are only ever needed during import itself; once it's done this connection is used
  // purely for querying (handleQuery reuses it via openDbs), same as a freshly opened dataset.
  db.exec("PRAGMA query_only = ON")
  openDbs.set(id, db)

  const info: DatasetInfo = {
    id,
    title: p.name,
    tagline: `${tables.length} table${tables.length === 1 ? "" : "s"} · imported ${new Date().toLocaleDateString()}`,
    kind: "upload",
    sizeBytes: bytes.byteLength,
    tableCount: tables.length,
    createdAt: new Date().toISOString(),
  }
  const list = (await get<DatasetInfo[]>(DATASETS_KEY)) ?? []
  await set(DATASETS_KEY, [...list, info])

  return { dataset: info, tables, executed, skipped, warnings }
}

// ─────────────────────────────── delete / export ───────────────────────────────

async function handleDelete(p: RpcMethods["delete"]["params"]): Promise<void> {
  const open = openDbs.get(p.datasetId)
  if (open) {
    open.close()
    openDbs.delete(p.datasetId)
  }
  await del(`db:${p.datasetId}`)
  await del(`catalog:${p.datasetId}`)
  const list = (await get<DatasetInfo[]>(DATASETS_KEY)) ?? []
  await set(
    DATASETS_KEY,
    list.filter((d) => d.id !== p.datasetId),
  )
}

async function handleExport(p: RpcMethods["export"]["params"]): Promise<{ bytes: ArrayBuffer }> {
  const sqlite3 = await getSqlite3()
  const db = await openDataset(p.datasetId)
  const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer!)
  return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
}

// ─────────────────────────────── message loop ───────────────────────────────

async function dispatch(method: RpcMethod, params: unknown): Promise<unknown> {
  switch (method) {
    case "query":
      return handleQuery(params as RpcMethods["query"]["params"])
    case "import":
      return handleImport(params as RpcMethods["import"]["params"])
    case "delete":
      return handleDelete(params as RpcMethods["delete"]["params"])
    case "export":
      return handleExport(params as RpcMethods["export"]["params"])
    default: {
      const _exhaustive: never = method
      throw new Error(`Unknown DB worker method: ${String(_exhaustive)}`)
    }
  }
}

addEventListener("message", (ev: MessageEvent<RpcRequest>) => {
  const { id, method, params } = ev.data
  dispatch(method, params)
    .then((result) => {
      const res: RpcResponse = { id, method, ok: true, result } as RpcResponse
      postMessage(res)
    })
    .catch((e: unknown) => {
      const res: RpcResponse = { id, method, ok: false, error: friendlyError(e) }
      postMessage(res)
    })
})

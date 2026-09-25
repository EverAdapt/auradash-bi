/**
 * OWNER: data-engine. Public API of the in-browser SQLite engine (@sqlite.org/sqlite-wasm in a
 * module worker, src/workers/db.worker.ts, talked to via the typed RPC in src/lib/db/rpc.ts).
 * Everything else in the app talks to data only through these functions.
 */
import type { Cell, DatasetId, DatasetInfo, QueryFn, ResultSet } from "@shared/contract"
import { get } from "idb-keyval"
import { getDbRpc } from "@/lib/db/rpc"
import { checkUserSql } from "@/lib/db/policy"

const DATASETS_KEY = "datasets:v1"

export interface QueryOptions {
  /** hard row cap (default 5,000); the result is marked truncated when hit */
  maxRows?: number
  signal?: AbortSignal
}

export interface ImportInput {
  /** display name for the new dataset */
  name: string
  /** .sqlite/.db, .sql dump(s), .csv file(s) (one table per CSV) */
  files?: File[]
  /** pasted SQL dump (CREATE TABLE + INSERT ...); MySQL/Postgres dialects are normalized */
  sqlText?: string
}

export interface ImportReport {
  dataset: DatasetInfo
  tables: { name: string; rows: number }[]
  executed: number
  skipped: { statement: string; error: string }[]
  warnings: string[]
}

/** Bundled datasets (public/data/datasets.json) followed by the user's uploads (IndexedDB). */
export async function listDatasets(): Promise<DatasetInfo[]> {
  const [bundled, uploads] = await Promise.all([
    fetch("/data/datasets.json").then((r) => (r.ok ? (r.json() as Promise<DatasetInfo[]>) : [])),
    get<DatasetInfo[]>(DATASETS_KEY).then((v) => v ?? []),
  ])
  return [...bundled, ...uploads]
}

/** Run read-only SQL against one dataset (opens/loads it on first use). */
export async function query(datasetId: DatasetId, sql: string, params: Cell[] = [], opts: QueryOptions = {}): Promise<ResultSet> {
  return getDbRpc().call("query", { datasetId, sql, params, maxRows: opts.maxRows ?? 5000 }, opts.signal)
}

/**
 * Run SQL a person typed themselves (the SQL console, or any future user-typed SQL entry point).
 * Checked client-side first against the strict read-only policy (see `lib/db/policy.ts`) so a
 * blocked query never round-trips to the DB worker; the worker enforces the same policy again
 * server-side (defense in depth — never trust a single layer), plus a ~4s query timeout and
 * `PRAGMA query_only`.
 */
export async function queryUserSql(datasetId: DatasetId, sql: string, params: Cell[] = [], opts: QueryOptions = {}): Promise<ResultSet> {
  const check = checkUserSql(sql)
  if (!check.ok) throw new Error(check.reason ?? "That query isn't allowed here.")
  return getDbRpc().call("query", { datasetId, sql, params, maxRows: opts.maxRows ?? 5000, untrusted: true }, opts.signal)
}

/** A QueryFn bound to one dataset, for the pure libraries (catalog, plan, viz). */
export function queryFn(datasetId: DatasetId, opts?: QueryOptions): QueryFn {
  return (sql, params) => query(datasetId, sql, params, opts)
}

export async function importDataset(input: ImportInput): Promise<ImportReport> {
  const files = await Promise.all(
    (input.files ?? []).map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })),
  )
  const wire = await getDbRpc().call("import", { name: input.name, files, sqlText: input.sqlText })
  return wire
}

export async function deleteDataset(id: DatasetId): Promise<void> {
  await getDbRpc().call("delete", { datasetId: id })
}

/** The dataset as a downloadable .sqlite file (bundled datasets export their inflated bytes). */
export async function exportDataset(id: DatasetId): Promise<Blob> {
  const { bytes } = await getDbRpc().call("export", { datasetId: id })
  return new Blob([bytes], { type: "application/vnd.sqlite3" })
}

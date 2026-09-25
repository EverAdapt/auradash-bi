/**
 * OWNER: data-engine. Small typed request/response RPC between the main thread and the one
 * module worker (db.worker.ts) that owns every @sqlite.org/sqlite-wasm `oo1.DB`.
 *
 * AbortSignal support is client-side only: sqlite-wasm's oo1 API runs synchronously inside the
 * worker's single JS thread, so a message posted while a query is mid-`step()` can't be delivered
 * (and couldn't interrupt it if it were). Aborting here rejects the caller immediately with an
 * AbortError and simply drops the worker's response when it eventually arrives — matching "reject
 * with AbortError and ignore the late result".
 */
import type { Cell, DatasetId, DatasetInfo, ResultSet } from "@shared/contract"

export interface ImportFile {
  name: string
  bytes: ArrayBuffer
}

export interface ImportReportWire {
  dataset: DatasetInfo
  tables: { name: string; rows: number }[]
  executed: number
  skipped: { statement: string; error: string }[]
  warnings: string[]
}

export interface RpcMethods {
  query: {
    /**
     * `untrusted: true` marks SQL a person typed themselves (the SQL console): the worker runs it
     * through `lib/db/policy.ts`'s strict read-only check before executing it. Omitted/false is
     * code-generated SQL (compiled plans, explorer row/sort/filter queries, catalog introspection's
     * `PRAGMA table_xinfo`/`PRAGMA foreign_key_list`), which skips that check but still runs under
     * the engine's row cap, ~4s progress-handler timeout and `PRAGMA query_only`.
     */
    params: { datasetId: DatasetId; sql: string; params: Cell[]; maxRows: number; untrusted?: boolean }
    result: ResultSet
  }
  import: {
    params: { name: string; files: ImportFile[]; sqlText?: string }
    result: ImportReportWire
  }
  delete: { params: { datasetId: DatasetId }; result: void }
  export: { params: { datasetId: DatasetId }; result: { bytes: ArrayBuffer } }
}

export type RpcMethod = keyof RpcMethods

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: number
  method: M
  params: RpcMethods[M]["params"]
}

export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | { id: number; method: M; ok: true; result: RpcMethods[M]["result"] }
  | { id: number; method: M; ok: false; error: string }

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  settled: boolean
}

/** One live connection to the DB worker. Import lazily where it's used to keep it out of the main chunk. */
export class DbRpcClient {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor() {
    this.worker = new Worker(new URL("../../workers/db.worker.ts", import.meta.url), { type: "module" })
    this.worker.addEventListener("message", (ev: MessageEvent<RpcResponse>) => {
      const msg = ev.data
      const p = this.pending.get(msg.id)
      if (!p || p.settled) return // aborted (or duplicate) — drop the late result
      this.pending.delete(msg.id)
      p.settled = true
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    })
    this.worker.addEventListener("error", (ev) => {
      // A worker-level error (e.g. module load failure) fails every still-pending call.
      for (const [id, p] of this.pending) {
        if (p.settled) continue
        p.settled = true
        p.reject(new Error(ev.message || "DB worker error"))
        this.pending.delete(id)
      }
    })
  }

  call<M extends RpcMethod>(method: M, params: RpcMethods[M]["params"], signal?: AbortSignal): Promise<RpcMethods[M]["result"]> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
    const id = this.nextId++
    const entry: Pending = { resolve: () => {}, reject: () => {}, settled: false }
    const promise = new Promise<RpcMethods[M]["result"]>((resolve, reject) => {
      entry.resolve = resolve as (v: unknown) => void
      entry.reject = reject
    })
    this.pending.set(id, entry)
    const req: RpcRequest<M> = { id, method, params }
    this.worker.postMessage(req)
    if (signal) {
      const onAbort = () => {
        const p = this.pending.get(id)
        if (!p || p.settled) return
        p.settled = true
        this.pending.delete(id)
        p.reject(new DOMException("Aborted", "AbortError"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {})
    }
    return promise
  }

  terminate(): void {
    this.worker.terminate()
  }
}

let shared: DbRpcClient | undefined
/** One worker for the whole app (created lazily, on first query/import). */
export function getDbRpc(): DbRpcClient {
  shared ??= new DbRpcClient()
  return shared
}

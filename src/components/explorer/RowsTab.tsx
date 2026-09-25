/**
 * OWNER: data-engine. Rows tab: SQL-side paging (200/page, infinite scroll), sort, debounced
 * search, FK cells linking to the referenced table with a removable filter chip, filtered count.
 */
import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { Search, X } from "lucide-react"
import type { Catalog, CatalogTable, Cell, DatasetId } from "@shared/contract"
import { query } from "@/lib/db"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataGrid, type DataGridColumn } from "@/components/explorer/DataGrid"
import { useDebouncedValue } from "@/components/explorer/hooks"
import { buildRowsCountQuery, buildRowsQuery, encodeWhereParam, type RowsQueryInput } from "@/components/explorer/rows-query"
import { formatCount } from "@/lib/db/format"

const PAGE_SIZE = 200

export function RowsTab({
  datasetId,
  catalog,
  table,
  whereFilter,
  onClearFilter,
}: {
  datasetId: DatasetId
  catalog: Catalog
  table: CatalogTable
  whereFilter: { column: string; value: string } | null
  onClearFilter: () => void
}) {
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebouncedValue(search, 300)
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null)

  const queryInput: RowsQueryInput = { table: table.name, columns: table.columns, search: debouncedSearch, sort, where: whereFilter }
  // Identifies one (table, search, sort, filter) combination. Results are tagged with the key
  // they answer, so `loading` and `rows` are derived by comparing keys instead of resetting state
  // synchronously inside the effect (which would immediately re-trigger a render on every change).
  const requestKey = useMemo(
    () => JSON.stringify(queryInput),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on queryInput's primitive inputs, not its (re-created every render) identity
    [table.name, debouncedSearch, sort, whereFilter?.column, whereFilter?.value],
  )

  const [page, setPage] = useState<{ key: string; rows: Cell[][]; count: number | null; hasMore: boolean; error: string | null }>({
    key: "",
    rows: [],
    count: null,
    hasMore: true,
    error: null,
  })
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const { sql, params } = buildRowsQuery(queryInput, PAGE_SIZE, 0)
    const countQ = buildRowsCountQuery(queryInput)
    Promise.all([
      query(datasetId, sql, params, { signal: controller.signal }),
      query(datasetId, countQ.sql, countQ.params, { signal: controller.signal }),
    ])
      .then(([res, countRes]) => {
        if (cancelled) return
        setPage({
          key: requestKey,
          rows: res.rows,
          count: typeof countRes.rows[0]?.[0] === "number" ? countRes.rows[0][0] : null,
          hasMore: res.rows.length === PAGE_SIZE,
          error: null,
        })
      })
      .catch((e: unknown) => {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return
        setPage({ key: requestKey, rows: [], count: null, hasMore: false, error: e instanceof Error ? e.message : "Could not load rows." })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestKey already encodes every input below
  }, [datasetId, requestKey])

  const loading = page.key !== requestKey
  const { rows, count, hasMore, error } = loading ? { rows: [] as Cell[][], count: null, hasMore: false, error: null } : page

  const loadMore = () => {
    if (loading || loadingMore || !hasMore) return
    setLoadingMore(true)
    const { sql, params } = buildRowsQuery(queryInput, PAGE_SIZE, rows.length)
    query(datasetId, sql, params)
      .then((res) => {
        setPage((prev) => (prev.key !== requestKey ? prev : { ...prev, rows: [...prev.rows, ...res.rows], hasMore: res.rows.length === PAGE_SIZE }))
      })
      .catch(() => setPage((prev) => (prev.key !== requestKey ? prev : { ...prev, hasMore: false })))
      .finally(() => setLoadingMore(false))
  }

  const onSortChange = (column: string) => {
    setSort((prev) => {
      if (prev?.column !== column) return { column, dir: "asc" }
      if (prev.dir === "asc") return { column, dir: "desc" }
      return null
    })
  }

  const columns: DataGridColumn[] = table.columns.map((c) => {
    // Not gated on role === "fk": a column can be tagged geo_code/latitude/etc. as its headline
    // role while `fk` still points at the table it joins to (see scripts/build-catalog.ts).
    const fkTarget = c.fk ? c.fk.split(".") : null
    const targetLabel = fkTarget ? catalog.tables.find((t) => t.name === fkTarget[0])?.label : undefined
    return {
      name: c.name,
      label: c.name,
      align: c.role === "measure" || c.role === "id" ? "right" : undefined,
      renderCell:
        fkTarget && fkTarget.length === 2
          ? (value: Cell) =>
              value === null ? (
                <span className="italic text-muted-foreground">NULL</span>
              ) : (
                <Link
                  href={`/explore/${datasetId}/${fkTarget[0]}?${new URLSearchParams({ where: encodeWhereParam(fkTarget[1], value) })}`}
                  className="block w-full truncate text-brand hover:underline"
                  title={targetLabel ? `${String(value)} · Go to ${targetLabel}` : String(value)}
                >
                  {String(value)}
                </Link>
              )
          : undefined,
    }
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Quick search…" className="h-8 pl-8 text-sm" />
        </div>
        {whereFilter && (
          <Badge variant="secondary" className="h-7 gap-1.5 px-2.5 text-xs">
            {whereFilter.column} = {whereFilter.value}
            <button type="button" onClick={onClearFilter} aria-label="Remove filter" className="rounded-full hover:text-foreground">
              <X className="size-3" />
            </button>
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {count !== null ? `${formatCount(count)} row${count === 1 ? "" : "s"}` : loading ? "Loading…" : ""}
        </span>
      </div>

      {error ? (
        <div className="rounded-lg bg-destructive/10 px-3 py-6 text-center text-sm text-destructive">{error}</div>
      ) : (
        <DataGrid columns={columns} rows={rows} sort={sort} onSortChange={onSortChange} onEndReached={loadMore} loadingMore={loadingMore} className="h-[calc(100svh-19rem)]" />
      )}
    </div>
  )
}

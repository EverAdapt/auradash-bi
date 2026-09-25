/** OWNER: data-engine. "/explore/:datasetId?/:table?" — browse tables, schema, rows, SQL console. */
import { useEffect } from "react"
import { useLocation, useParams, useSearchParams } from "wouter"
import type { DatasetId } from "@shared/contract"
import { useDatasets } from "@/state/datasets"
import { useCatalog } from "@/components/explorer/hooks"
import { ExplorerSidebar } from "@/components/explorer/ExplorerSidebar"
import { TableHeaderBar } from "@/components/explorer/TableHeaderBar"
import { RowsTab } from "@/components/explorer/RowsTab"
import { SchemaTab } from "@/components/explorer/SchemaTab"
import { RelationshipsTab } from "@/components/explorer/RelationshipsTab"
import { SqlConsoleTab } from "@/components/explorer/SqlConsoleTab"
import { parseWhereParam } from "@/components/explorer/rows-query"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"

type Tab = "rows" | "schema" | "relationships" | "sql"

export default function ExplorePage() {
  const params = useParams<{ datasetId?: string; table?: string }>()
  const [, navigate] = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  const datasets = useDatasets((s) => s.datasets)
  const loadedDatasets = useDatasets((s) => s.loaded)
  const currentId = useDatasets((s) => s.currentId)
  const setCurrent = useDatasets((s) => s.setCurrent)
  const refresh = useDatasets((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const datasetId: DatasetId = params.datasetId || currentId
  const { catalog, loading, error } = useCatalog(datasetId)

  useEffect(() => {
    if (datasetId !== currentId) setCurrent(datasetId)
    // only sync the store when the URL disagrees with it; setCurrent is stable from zustand
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId])

  const visibleTables = catalog?.tables.filter((t) => !t.hidden) ?? []
  const tableName = params.table || visibleTables[0]?.name
  const table = catalog?.tables.find((t) => t.name === tableName)

  const tab = (searchParams.get("tab") as Tab | null) ?? "rows"
  const whereFilter = parseWhereParam(searchParams.get("where"))
  const sqlParam = searchParams.get("sql")

  const setTab = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("tab", value)
      return next
    }, { replace: true })
  }
  const clearFilter = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("where")
      return next
    }, { replace: true })
  }
  const onDatasetChange = (id: string) => {
    setCurrent(id)
    navigate(`/explore/${id}`)
  }

  return (
    <div className="flex">
      <ExplorerSidebar
        datasets={datasets}
        datasetId={datasetId}
        onDatasetChange={onDatasetChange}
        catalog={catalog}
        currentTable={table?.name}
      />
      <main className="min-w-0 flex-1 px-6 py-6 sm:px-8">
        {loading && (
          <div className="flex items-center gap-2 py-20 text-sm text-muted-foreground">
            <Spinner /> Loading dataset…
          </div>
        )}
        {!loading && error && <div className="rounded-lg bg-destructive/10 px-4 py-6 text-sm text-destructive">{error}</div>}
        {!loading && !error && catalog && !table && (
          <div className="py-20 text-center text-sm text-muted-foreground">
            {loadedDatasets ? "This dataset has no visible tables." : "Loading…"}
          </div>
        )}
        {!loading && !error && catalog && table && (
          <div className="flex flex-col gap-5">
            <TableHeaderBar datasetId={datasetId} table={table} />
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="rows">Rows</TabsTrigger>
                <TabsTrigger value="schema">Schema</TabsTrigger>
                <TabsTrigger value="relationships">Relationships</TabsTrigger>
                <TabsTrigger value="sql">SQL</TabsTrigger>
              </TabsList>
              <TabsContent value="rows" className="mt-4">
                <RowsTab key={table.name} datasetId={datasetId} catalog={catalog} table={table} whereFilter={whereFilter} onClearFilter={clearFilter} />
              </TabsContent>
              <TabsContent value="schema" className="mt-4">
                <SchemaTab datasetId={datasetId} catalog={catalog} table={table} />
              </TabsContent>
              <TabsContent value="relationships" className="mt-4">
                <RelationshipsTab datasetId={datasetId} catalog={catalog} table={table} />
              </TabsContent>
              <TabsContent value="sql" className="mt-4">
                <SqlConsoleTab key={table.name} datasetId={datasetId} catalog={catalog} table={table} initialSql={sqlParam ?? undefined} />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>
    </div>
  )
}

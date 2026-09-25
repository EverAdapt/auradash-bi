/** OWNER: data-engine. Relationships tab: every join as a list, plus the small ER diagram. */
import { Link } from "wouter"
import { ArrowRight } from "lucide-react"
import type { Catalog, CatalogTable, DatasetId } from "@shared/contract"
import { ErDiagram } from "@/components/explorer/ErDiagram"

export function RelationshipsTab({ datasetId, catalog, table }: { datasetId: DatasetId; catalog: Catalog; table: CatalogTable }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="overflow-x-auto rounded-xl border border-border bg-card p-4">
        <ErDiagram datasetId={datasetId} catalog={catalog} currentTable={table.name} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">All joins ({catalog.joins.length})</h3>
        <ul className="flex flex-col gap-1.5">
          {catalog.joins.map((j) => {
            const involved = j.from.startsWith(`${table.name}.`) || j.to.startsWith(`${table.name}.`)
            return (
              <li
                key={`${j.from}>${j.to}`}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 font-mono text-xs ${involved ? "bg-brand-soft" : "bg-muted/50"}`}
              >
                <Link href={`/explore/${datasetId}/${j.from.split(".")[0]}`} className="hover:underline">
                  {j.from}
                </Link>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                <Link href={`/explore/${datasetId}/${j.to.split(".")[0]}`} className="hover:underline">
                  {j.to}
                </Link>
                <span className="ml-auto text-muted-foreground">{j.kind}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

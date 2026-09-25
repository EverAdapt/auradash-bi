/** OWNER: data-engine. Main-panel header above the tabs: label, mono name, description, row count. */
import { Link } from "wouter"
import { MessageCircleQuestion } from "lucide-react"
import type { CatalogTable, DatasetId } from "@shared/contract"
import { formatCount } from "@/lib/db/format"

export function TableHeaderBar({ datasetId, table }: { datasetId: DatasetId; table: CatalogTable }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{table.label}</h1>
          <span className="font-mono text-xs text-muted-foreground">{table.name}</span>
        </div>
        {table.description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{table.description}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{formatCount(table.rowCount)} rows</p>
      </div>
      <Link
        href={`/?d=${datasetId}`}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-brand-soft/70"
      >
        <MessageCircleQuestion className="size-3.5" /> Ask about this data
      </Link>
    </div>
  )
}

/**
 * OWNER: data-engine. Explorer left rail: dataset switcher, About card (tagline, license,
 * attribution, source link, download), and the table list (visible tables; hidden tables/views
 * collapsed under "Views & helpers").
 */
import { useState } from "react"
import { Link } from "wouter"
import { ChevronDown, ChevronRight, Download, ExternalLink, Table2 } from "lucide-react"
import type { Catalog, DatasetInfo } from "@shared/contract"
import { exportDataset } from "@/lib/db"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatCount } from "@/lib/db/format"

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ExplorerSidebar({
  datasets,
  datasetId,
  onDatasetChange,
  catalog,
  currentTable,
}: {
  datasets: DatasetInfo[]
  datasetId: string
  onDatasetChange: (id: string) => void
  catalog: Catalog | null
  currentTable?: string
}) {
  const [showHidden, setShowHidden] = useState(false)
  const info = datasets.find((d) => d.id === datasetId)
  const visible = catalog?.tables.filter((t) => !t.hidden) ?? []
  const hidden = catalog?.tables.filter((t) => t.hidden) ?? []

  return (
    <aside className="sticky top-0 flex h-svh w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-4 py-5">
      <Select value={datasetId} onValueChange={onDatasetChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose a dataset" />
        </SelectTrigger>
        <SelectContent>
          {datasets.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {info && (
        <div className="flex flex-col gap-2 rounded-xl bg-muted/60 p-3 text-xs">
          <p className="text-foreground">{info.tagline}</p>
          {(info.license || info.attribution) && (
            <p className="text-muted-foreground">
              {info.license}
              {info.license && info.attribution && " · "}
              {info.attribution}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {info.sourceUrl && (
              <a
                href={info.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
              >
                Source <ExternalLink className="size-3" />
              </a>
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 px-2 text-xs"
              onClick={async () => download(await exportDataset(datasetId), `${info.title.replace(/[^a-z0-9]+/gi, "_")}.sqlite`)}
            >
              <Download className="size-3" /> Download .sqlite
            </Button>
          </div>
        </div>
      )}

      <nav className="flex flex-col gap-0.5">
        {visible.map((t) => (
          <Link
            key={t.name}
            href={`/explore/${datasetId}/${t.name}`}
            className={cn(
              "group flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted",
              currentTable === t.name && "bg-brand-soft text-accent-foreground",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{t.label}</span>
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatCount(t.rowCount)}</span>
          </Link>
        ))}

        {hidden.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              {showHidden ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Views &amp; helpers ({hidden.length})
            </button>
            {showHidden &&
              hidden.map((t) => (
                <Link
                  key={t.name}
                  href={`/explore/${datasetId}/${t.name}`}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 pl-7 text-sm text-muted-foreground hover:bg-muted",
                    currentTable === t.name && "bg-brand-soft text-accent-foreground",
                  )}
                >
                  <span className="truncate font-mono text-xs">{t.name}</span>
                  <span className="shrink-0 font-mono text-[10px]">{formatCount(t.rowCount)}</span>
                </Link>
              ))}
          </div>
        )}
      </nav>
    </aside>
  )
}

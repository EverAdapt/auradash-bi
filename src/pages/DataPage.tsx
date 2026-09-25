/** OWNER: data-engine. "/data" — pick a dataset, bring your own data, manage uploads. */
import { useEffect } from "react"
import { ShieldCheck } from "lucide-react"
import { useDatasets } from "@/state/datasets"
import { DatasetCard } from "@/components/data/DatasetCard"
import { ImportPanel } from "@/components/data/ImportPanel"
import { UploadsList } from "@/components/data/UploadsList"

export default function DataPage() {
  const datasets = useDatasets((s) => s.datasets)
  const loaded = useDatasets((s) => s.loaded)
  const refresh = useDatasets((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const bundled = datasets.filter((d) => d.kind === "bundled")
  const uploads = datasets.filter((d) => d.kind === "upload")

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data</h1>
        <p className="text-sm text-muted-foreground">
          Two bundled datasets to explore right away, or bring your own — it stays in this browser.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted-foreground">Bundled datasets</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {loaded && bundled.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bundled datasets found.</p>
          ) : (
            bundled.map((d) => <DatasetCard key={d.id} dataset={d} />)
          )}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">Bring your own data</h2>
          <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            Stays in your browser. Only your question, table and column names, and the values you
            mention are sent to Jev.
          </p>
        </div>
        <ImportPanel />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted-foreground">Your datasets</h2>
        <UploadsList datasets={uploads} />
      </section>
    </div>
  )
}

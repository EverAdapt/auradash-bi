/** OWNER: data-engine. A bundled dataset's card on the Data page: title, tagline, license, size. */
import { useLocation } from "wouter"
import { Compass, MessageCircleQuestion } from "lucide-react"
import type { DatasetInfo } from "@shared/contract"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useDatasets } from "@/state/datasets"
import { formatBytes } from "@/lib/db/format"

export function DatasetCard({ dataset }: { dataset: DatasetInfo }) {
  const [, navigate] = useLocation()
  const setCurrent = useDatasets((s) => s.setCurrent)

  const goAsk = () => {
    setCurrent(dataset.id)
    navigate(`/?d=${dataset.id}`)
  }
  const goExplore = () => {
    setCurrent(dataset.id)
    navigate(`/explore/${dataset.id}`)
  }

  return (
    <Card className="flex h-full flex-col justify-between">
      <CardHeader>
        <CardTitle>{dataset.title}</CardTitle>
        <CardDescription>{dataset.tagline}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Tables</dt>
          <dd className="text-right tabular-nums text-foreground">{dataset.tableCount ?? "—"}</dd>
          <dt>Size</dt>
          <dd className="text-right tabular-nums text-foreground">{formatBytes(dataset.sizeBytes)}</dd>
          <dt>License</dt>
          <dd className="truncate text-right text-foreground" title={dataset.license}>
            {dataset.license ?? "—"}
          </dd>
        </dl>
        {dataset.attribution && <p className="mt-2 text-xs text-muted-foreground">{dataset.attribution}</p>}
        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={goAsk}>
            <MessageCircleQuestion /> Ask
          </Button>
          <Button size="sm" variant="outline" onClick={goExplore}>
            <Compass /> Explore
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

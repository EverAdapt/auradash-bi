/** OWNER: data-engine. "Your datasets": uploads with Ask / Explore / Download / Delete (confirm). */
import { useState } from "react"
import { useLocation } from "wouter"
import { Compass, Database, Download, MessageCircleQuestion, Trash2 } from "lucide-react"
import type { DatasetInfo } from "@shared/contract"
import { exportDataset } from "@/lib/db"
import { useDatasets } from "@/state/datasets"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { formatBytes, formatDate } from "@/lib/db/format"

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function UploadRow({ dataset }: { dataset: DatasetInfo }) {
  const [, navigate] = useLocation()
  const setCurrent = useDatasets((s) => s.setCurrent)
  const removeDataset = useDatasets((s) => s.removeDataset)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const goAsk = () => {
    setCurrent(dataset.id)
    navigate(`/?d=${dataset.id}`)
  }
  const goExplore = () => {
    setCurrent(dataset.id)
    navigate(`/explore/${dataset.id}`)
  }
  const doDownload = async () => {
    const blob = await exportDataset(dataset.id)
    download(blob, `${dataset.title.replace(/[^a-z0-9]+/gi, "_") || "dataset"}.sqlite`)
  }
  const doDelete = async () => {
    setBusy(true)
    try {
      await removeDataset(dataset.id)
      setConfirmOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <Database className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{dataset.title}</div>
        <div className="text-xs text-muted-foreground">
          {dataset.tableCount ?? "—"} tables · {formatBytes(dataset.sizeBytes)} · added {formatDate(dataset.createdAt)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Ask about this dataset" onClick={goAsk}>
          <MessageCircleQuestion />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Explore this dataset" onClick={goExplore}>
          <Compass />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Download .sqlite" onClick={doDownload}>
          <Download />
        </Button>
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button size="icon-sm" variant="ghost" aria-label="Delete dataset" onClick={() => setConfirmOpen(true)}>
            <Trash2 />
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete "{dataset.title}"?</DialogTitle>
              <DialogDescription>
                This removes the dataset from this browser for good. It cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button variant="destructive" onClick={doDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </li>
  )
}

export function UploadsList({ datasets }: { datasets: DatasetInfo[] }) {
  if (datasets.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database />
          </EmptyMedia>
          <EmptyTitle>No uploads yet</EmptyTitle>
          <EmptyDescription>Bring your own data above, or try the sample.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {datasets.map((d) => (
        <UploadRow key={d.id} dataset={d} />
      ))}
    </ul>
  )
}

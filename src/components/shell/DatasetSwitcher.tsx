/**
 * OWNER: ask-board. Top-bar pill: current dataset's icon + title, a dropdown of every dataset
 * (title + tagline), a separator, then "Add your data…" -> /data (or, in the public demo where
 * /data can't accept uploads, straight to the GitHub repo).
 */
import { ChevronDownIcon, DatabaseIcon, PlusIcon } from "lucide-react"
import { useLocation } from "wouter"
import type { DatasetId } from "@shared/contract"
import { useDemo } from "@/lib/demo"
import { REPO_URL } from "@/lib/site"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { currentDataset, useDatasets } from "@/state/datasets"

export function DatasetSwitcher() {
  const datasets = useDatasets((s) => s.datasets)
  const current = useDatasets(currentDataset)
  const setCurrent = useDatasets((s) => s.setCurrent)
  const demo = useDemo((s) => s.demo)
  const [, navigate] = useLocation()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-48 gap-1.5 rounded-full pl-2.5"
        >
          <DatabaseIcon className="size-3.5 shrink-0 text-brand" />
          <span className="truncate">
            {current?.title ?? "Choose a dataset"}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {datasets.map((d) => (
          <DropdownMenuItem
            key={d.id}
            data-variant={d.id === current?.id ? "default" : undefined}
            className="flex-col items-start gap-0.5 py-2"
            onSelect={() => setCurrent(d.id as DatasetId)}
          >
            <span className="text-sm font-medium text-foreground">
              {d.title}
            </span>
            <span className="line-clamp-2 text-xs text-muted-foreground">
              {d.tagline}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            demo ? window.open(REPO_URL, "_blank", "noopener,noreferrer") : navigate("/data")
          }
        >
          <PlusIcon /> Add your data…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * OWNER: ask-board. "/" on an empty ask box opens this: every dataset's Try prompts, grouped by
 * dataset, plus quick actions to switch dataset or jump to Explore / Charts / Data. Ported from
 * shapeshift's `IntentPalette` (porting guide §2.10): a shadcn `CommandDialog`, nested `<Command>`.
 */
import { useEffect, useState } from "react"
import { useLocation } from "wouter"
import type { DatasetId } from "@shared/contract"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { getCatalog } from "@/lib/catalog"
import { APP_NAME } from "@/lib/site"
import { useDatasets } from "@/state/datasets"

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentDatasetId: DatasetId
  onPickPrompt: (question: string, datasetId: DatasetId) => void
  onSwitchDataset: (datasetId: DatasetId) => void
}

export function CommandPalette({
  open,
  onOpenChange,
  currentDatasetId,
  onPickPrompt,
  onSwitchDataset,
}: CommandPaletteProps) {
  const datasets = useDatasets((s) => s.datasets)
  const [prompts, setPrompts] = useState<Record<string, string[]>>({})
  const [, navigate] = useLocation()

  useEffect(() => {
    if (!open || datasets.length === 0) return
    let cancelled = false
    Promise.all(
      datasets.map(async (d) => {
        try {
          const catalog = await getCatalog(d.id)
          return [d.id, catalog.tryPrompts.map((p) => p.text)] as const
        } catch {
          return [d.id, []] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) setPrompts(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [open, datasets])

  const go = (path: string) => {
    onOpenChange(false)
    navigate(path)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Ask ${APP_NAME}`}
      description="Try a prompt, switch dataset, or jump to a page."
    >
      <Command>
        <CommandInput placeholder="Search prompts, datasets, pages…" />
        <CommandList>
          <CommandEmpty>
            Nothing matches. Try a different question.
          </CommandEmpty>

          {datasets.map((dataset) => {
            const items = prompts[dataset.id] ?? []
            if (items.length === 0) return null
            return (
              <CommandGroup key={dataset.id} heading={dataset.title}>
                {items.map((text) => (
                  <CommandItem
                    key={`${dataset.id}:${text}`}
                    value={`${dataset.title} ${text}`}
                    onSelect={() => {
                      onOpenChange(false)
                      onPickPrompt(text, dataset.id)
                    }}
                  >
                    {text}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          })}

          <CommandSeparator />

          <CommandGroup heading="Dataset">
            {datasets
              .filter((d) => d.id !== currentDatasetId)
              .map((d) => (
                <CommandItem
                  key={d.id}
                  value={`switch to ${d.title}`}
                  onSelect={() => {
                    onOpenChange(false)
                    onSwitchDataset(d.id)
                  }}
                >
                  Switch to {d.title}
                </CommandItem>
              ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Go to">
            <CommandItem value="go to explore" onSelect={() => go("/explore")}>
              Explore
            </CommandItem>
            <CommandItem value="go to charts" onSelect={() => go("/charts")}>
              Charts
            </CommandItem>
            <CommandItem value="go to data" onSelect={() => go("/data")}>
              Data
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

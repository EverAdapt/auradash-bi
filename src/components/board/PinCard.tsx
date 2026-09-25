/**
 * OWNER: ask-board. One pinned card on the board. The pin stores the query, never the data: this
 * component re-runs `pin.sql` on mount (and on Refresh), profiles it and renders it with the
 * shared `<ChartView>`. The header is the drag handle; the hover toolbar (chart switcher, View SQL,
 * move/size, Remove) is `.no-drag` so `dragConfig.cancel` keeps it clickable while dragging is
 * bound to the header.
 */
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import type {
  ChartType,
  Pin,
  PinLayout,
  ResultProfile,
  ResultSet,
} from "@shared/contract"
import { Link } from "wouter"
import { ChartView, chartRegistry } from "@/components/charts"
import { LazySqlEditor } from "@/components/sql/LazySqlEditor"
import { displaySqlFor } from "@/components/sql/inline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { query } from "@/lib/db"
import { eligibleCharts, profileResult } from "@/lib/viz"
import { useDatasets } from "@/state/datasets"
import { usePins } from "@/state/pins"

const SIZE_PRESETS = [
  { key: "S", label: "Small", w: 3, h: 4 },
  { key: "M", label: "Medium", w: 6, h: 6 },
  { key: "L", label: "Large", w: 8, h: 8 },
  { key: "XL", label: "Extra large", w: 12, h: 8 },
] as const

type LoadState =
  | { status: "loading" }
  | { status: "ready"; result: ResultSet; profile: ResultProfile }
  | { status: "error"; message: string }

export interface PinCardProps {
  pin: Pin
  layout: PinLayout | undefined
  isFirst: boolean
  isLast: boolean
  isDragging: boolean
  onMove: (id: string, direction: -1 | 1) => void
  onResize: (id: string, size: { w: number; h: number }) => void
}

export function PinCard({
  pin,
  layout,
  isFirst,
  isLast,
  isDragging,
  onMove,
  onResize,
}: PinCardProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  const [reloadToken, setReloadToken] = useState(0)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const updatePin = usePins((s) => s.updatePin)
  const removePin = usePins((s) => s.removePin)
  const datasets = useDatasets((s) => s.datasets)
  const dataset = datasets.find((d) => d.id === pin.datasetId)

  useEffect(() => {
    const ctrl = new AbortController()
    // Starting a fetch when the query identity changes (dataset/sql/params/refresh) — the
    // standard "synchronize with an external system" useEffect case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" })
    query(pin.datasetId, pin.sql, pin.params, { signal: ctrl.signal })
      .then((result) => {
        if (ctrl.signal.aborted) return
        setState({
          status: "ready",
          result,
          profile: profileResult(result, pin.columns),
        })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        const message =
          err instanceof Error
            ? err.message
            : `The "${pin.datasetId}" dataset could not be found.`
        setState({ status: "error", message })
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.datasetId, pin.sql, JSON.stringify(pin.params), reloadToken])

  const switchType = (type: ChartType) => {
    if (state.status !== "ready") return
    updatePin(pin.id, { chart: { ...pin.chart, type } })
  }

  const chartOptions: { type: ChartType; p?: number }[] =
    pin.chartRanking && pin.chartRanking.length > 0
      ? pin.chartRanking
      : state.status === "ready"
        ? eligibleCharts(state.profile).map((type) => ({ type }))
        : []

  const remove = () => {
    const savedLayout = layout
    removePin(pin.id)
    toast(`Removed "${pin.title}"`, {
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => usePins.getState().restorePin(pin, savedLayout),
      },
    })
  }

  // A Pin's contract has no `displaySql` field (only CompiledQuery does), so its "exact SQL"
  // dialog always inlines `params` into `sql` locally and pretty-prints the result.
  const displaySql = useMemo(() => displaySqlFor(pin.sql, pin.params), [pin.sql, pin.params])

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(displaySql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard can be denied; the dialog still shows the SQL to copy by hand
    }
  }

  const encodedSql = encodeURIComponent(displaySql)

  return (
    <div className="dash-pin-card group" data-pin-id={pin.id}>
      <header className="@container drag-handle flex min-h-11 cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[15px] leading-snug font-[550] text-foreground" title={pin.title}>
            {pin.title}
          </h3>
          {pin.subtitle && (
            <p className="truncate text-[13px] text-muted-foreground">
              {pin.subtitle}
            </p>
          )}
        </div>
        {dataset && (
          <Badge
            variant="secondary"
            className="hidden shrink-0 font-normal text-muted-foreground @xs:inline-flex"
          >
            {dataset.title}
          </Badge>
        )}
        <div className="no-drag flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {chartOptions.length > 1 && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Change chart type"
                    >
                      {(() => {
                        const Icon = chartRegistry[pin.chart.type]?.icon
                        return Icon ? <Icon /> : null
                      })()}
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Change chart type</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Show as</DropdownMenuLabel>
                {chartOptions.map(({ type, p }) => {
                  const entry = chartRegistry[type]
                  const Icon = entry?.icon
                  return (
                    <DropdownMenuItem
                      key={type}
                      onSelect={() => switchType(type)}
                      data-active={type === pin.chart.type}
                    >
                      {Icon && <Icon />}
                      <span className="flex-1">{entry?.label ?? type}</span>
                      {typeof p === "number" && p > 0 && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {Math.round(p * 100)}%
                        </span>
                      )}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="View SQL"
                onClick={() => setSqlOpen(true)}
              >
                <CodeIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>View SQL</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Card options">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setReloadToken((n) => n + 1)}>
                <RefreshCwIcon /> Refresh
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onMove(pin.id, -1)}
                disabled={isFirst}
              >
                <ChevronLeftIcon /> Move earlier
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onMove(pin.id, 1)}
                disabled={isLast}
              >
                <ChevronRightIcon /> Move later
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Size</DropdownMenuLabel>
              {SIZE_PRESETS.map((size) => (
                <DropdownMenuItem
                  key={size.key}
                  onSelect={() => onResize(pin.id, { w: size.w, h: size.h })}
                >
                  {size.label} ({size.key})
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={remove}>
                <Trash2Icon /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="min-h-0 flex-1 p-3">
        {state.status === "loading" && (
          <div className="flex h-full flex-col gap-2">
            <Skeleton className="h-full w-full" />
          </div>
        )}
        {state.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md bg-destructive/5 p-4 text-center">
            <p className="text-sm text-destructive">{state.message}</p>
            <Link
              href="/data"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Manage datasets
            </Link>
          </div>
        )}
        {state.status === "ready" && (
          <ChartView
            spec={pin.chart}
            result={state.result}
            profile={state.profile}
            compact
            animate={!isDragging}
            className="h-full"
          />
        )}
      </div>

      <Dialog open={sqlOpen} onOpenChange={setSqlOpen}>
        <DialogContent
          className="no-drag sm:max-w-2xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>{pin.title}</DialogTitle>
            <DialogDescription>The exact SQL this card runs.</DialogDescription>
          </DialogHeader>
          <LazySqlEditor value={displaySql} readOnly minHeight={100} maxHeight={320} />
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={copySql}>
              <CopyIcon /> {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link
                href={`/explore/${pin.datasetId}?tab=sql&sql=${encodedSql}`}
              >
                <ExternalLinkIcon /> Open in console
              </Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

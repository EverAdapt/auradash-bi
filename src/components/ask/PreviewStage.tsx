/**
 * OWNER: ask-board. The live/committed preview card: a header (title + a "SQL" toggle/copy) that
 * spans the full card width, an optional full-width SQL panel below it, then the chart on the
 * left and "How Jev read this" on the right (interpretation chips from `outcome.slots`, the chart
 * switcher from `decision.ranking`, and the meta line), plus the primary "Pin to dashboard" pill.
 * Purely presentational — `AskPanel` owns all the state and wires the callbacks.
 */
import { useMemo, useState } from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react"
import { Link } from "wouter"
import { cn } from "cn"
import type { ChartType, ResultProfile, ResultSet } from "@shared/contract"
import type { Alternative, PlanOutcome, SlotView } from "@/lib/plan"
import type { AskResult } from "@/lib/ask/pipeline"
import { pageRows } from "@/lib/ask/pipeline"
import { modKeyLabel } from "@/lib/ask/platform"
import { logEvent } from "@/lib/telemetry"
import { ChartView, chartRegistry } from "@/components/charts"
import { LazySqlEditor } from "@/components/sql/LazySqlEditor"
import { displaySqlFor } from "@/components/sql/inline"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import "./ask.css"

function metaLine(askResult: AskResult): string {
  const meta = askResult.decision?.meta ?? askResult.outcome.meta
  const calls = askResult.decision ? 2 : 1
  const questions =
    askResult.outcome.meta.questionCount +
    (askResult.decision?.meta.questionCount ?? 0)
  if (meta.source === "offline") return "Offline planner"
  const latency = Math.round(askResult.timings.total)
  return `Jev · ${calls} call${calls === 1 ? "" : "s"} · ${questions} question${questions === 1 ? "" : "s"} · ${latency} ms · ${meta.model}`
}

/** A chip's body: label, value and the confidence bar — shared by the plain (non-actionable) and
 *  popover-trigger renderings below. */
function ChipBody({ slot }: { slot: SlotView }) {
  return (
    <div className="flex w-full flex-col gap-1 px-2 py-1.5 text-left">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {slot.label}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(slot.confidence * 100)}%
        </span>
      </div>
      <span className="truncate text-[13px] font-medium text-foreground">
        {slot.display}
      </span>
      <span className="ask-confidence-track">
        <span
          className="ask-confidence-fill"
          style={{ width: `${Math.round(slot.confidence * 100)}%` }}
        />
      </span>
    </div>
  )
}

function InterpretationChip({
  slot,
  onPick,
}: {
  slot: SlotView
  onPick: (optionKey: string) => void
}) {
  const [open, setOpen] = useState(false)
  // A slot with no real alternative (0 or 1 options — the same "nothing to fall back to" bar the
  // fallback ranker uses in src/lib/plan/index.ts) has nothing a picker could offer: render it as
  // a plain, non-interactive chip rather than a popover trigger with an empty menu.
  if (slot.options.length < 2) {
    return (
      <div className="rounded-lg border border-transparent">
        <ChipBody slot={slot} />
      </div>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full rounded-lg border border-transparent transition-colors hover:border-border hover:bg-secondary"
        >
          <ChipBody slot={slot} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {slot.options.map((option) => (
          <button
            key={option.key}
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-secondary"
            onClick={() => {
              setOpen(false)
              onPick(option.key)
            }}
          >
            <span className="truncate">{option.display}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(option.p * 100)}%
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** v0.2: "Next 50" pager for a rows answer's table — shown only when the current page is exactly
 *  `plan.limit` rows (there may be more) or a later page is already open (so "← Prev" has
 *  somewhere to go back to). Recompiles via `pageRows` (offset only, no new Jev call) and swaps
 *  the rows/profile the chart underneath reads; the original (offset-less) outcome is untouched,
 *  so a pin still cites the true, first-page query. */
function RowsPager({
  limit,
  offset,
  rowCount,
  onPage,
  loading,
}: {
  limit: number
  offset: number
  rowCount: number
  onPage: (offset: number) => void
  loading: boolean
}) {
  const canPrev = offset > 0
  const canNext = rowCount === limit
  if (!canPrev && !canNext) return null
  const start = offset + 1
  const end = offset + rowCount
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      {canPrev ? (
        <button
          type="button"
          disabled={loading}
          className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={() => onPage(Math.max(0, offset - limit))}
        >
          <ChevronLeftIcon className="size-3" /> Prev
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        disabled={!canNext || loading}
        className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
        onClick={() => canNext && onPage(offset + limit)}
      >
        {loading ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : null}
        Rows {start}–{end}
        {canNext && (
          <>
            {" "}
            · Next <ChevronRightIcon className="size-3" />
          </>
        )}
      </button>
    </div>
  )
}

export interface PreviewStageProps {
  askResult: AskResult
  outcome: PlanOutcome
  datasetId: string
  ghost: boolean
  /** The input text has moved on from this preview and a fresh answer is on its way (debouncing
   *  or already in flight) — a calm, unmissable "still here, refreshing" signal, never silent. */
  updating: boolean
  pinning: boolean
  applyingChoice: boolean
  onApplyChoice: (slot: SlotView["slot"], optionKey: string) => void
  onSwitchChart: (type: ChartType) => void
  onPin: () => void
  /** Swap a fallback answer back for the true (empty) one it stood in for. */
  onShowOriginal: () => void
  /** Runner-up interpretations, for the "Nothing matched" empty state's Did-you-mean chips (same
   *  list the ask box's own chip row reads, from `PlanOutcome.alternatives`). */
  alternatives: Alternative[]
  onPickAlternative: (alt: Alternative) => void
}

export function PreviewStage({
  askResult,
  outcome,
  datasetId,
  ghost,
  updating,
  pinning,
  applyingChoice,
  onApplyChoice,
  onSwitchChart,
  onPin,
  onShowOriginal,
  alternatives,
  onPickAlternative,
}: PreviewStageProps) {
  const mod = modKeyLabel()
  const { result, profile, spec, decision, error, fallback } = askResult
  const compiled = outcome.compiled
  const [sqlOpen, setSqlOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null)
  // A different answer is shown (a new question, a different fallback, ...): the "Was this
  // right?" prompt resets rather than carrying a stale "Thanks" over from a previous question.
  // Adjusting state during render (React's documented pattern, same as AskPanel's `foldedResult`)
  // rather than an effect, since this is a plain reset keyed off a prop change, not a sync with
  // an external system.
  const [feedbackFor, setFeedbackFor] = useState(compiled?.sql)
  if (compiled && feedbackFor !== compiled.sql) {
    setFeedbackFor(compiled.sql)
    setFeedback(null)
  }

  // v0.2: the rows-table pager's own state — which page is open, and the rows/profile it fetched
  // (offset 0 always reads straight off `askResult`, never re-fetched). A new answer resets back
  // to page 1 (same during-render reset pattern as `feedbackFor` above).
  const [pageOffset, setPageOffset] = useState(0)
  const [pageOverride, setPageOverride] = useState<{ result: ResultSet; profile: ResultProfile } | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  const [pagedFor, setPagedFor] = useState(compiled?.sql)
  if (compiled && pagedFor !== compiled.sql) {
    setPagedFor(compiled.sql)
    if (pageOffset !== 0) setPageOffset(0)
    if (pageOverride) setPageOverride(null)
  }
  const goToPage = (nextOffset: number) => {
    setPageLoading(true)
    pageRows(outcome, datasetId, nextOffset)
      .then((next) => {
        if (!next) return
        setPageOffset(nextOffset)
        setPageOverride(next)
      })
      .finally(() => setPageLoading(false))
  }

  const sendFeedback = (value: "up" | "down") => {
    if (feedback || !compiled) return
    setFeedback(value)
    logEvent({
      type: "feedback",
      datasetId,
      question: outcome.question,
      data: { value, title: compiled.title, chart: spec?.type, sql: compiled.sql },
    })
  }

  // CompiledQuery.displaySql (planner-provided, pre-formatted, must run unchanged) wins when
  // present; otherwise inline `params` into `sql` locally and pretty-print that.
  const displaySql = useMemo(
    () => (compiled ? displaySqlFor(compiled.sql, compiled.params, compiled.displaySql) : ""),
    [compiled]
  )

  if (error) {
    return (
      <div className="rounded-[20px] border border-border bg-card p-5 text-sm text-muted-foreground shadow-[var(--shadow-rest)]">
        That question could not be run. {error}
      </div>
    )
  }
  if (!result || !profile || !spec || !compiled) return null

  // No fallback candidate returned data either (or there was nothing to try): a friendly empty
  // state with Did-you-mean chips and an escape hatch, never a bare null/0 table or chart.
  const isEmpty = !fallback && (result.rows.length === 0 || (result.rows.length === 1 && result.rows[0]!.every((v) => v === null)))

  // A later page (when open) replaces what the chart reads; the original answer stays the one
  // `outcome`/`compiled` describe (title, subtitle, pin) — only the rendered rows change.
  const shownResult = pageOverride?.result ?? result
  const shownProfile = pageOverride?.profile ?? profile
  const rowsLimit = outcome.plan?.kind === "rows" ? outcome.plan.limit : undefined

  const consoleHref = `/explore/${datasetId}?tab=sql&sql=${encodeURIComponent(displaySql)}`
  const copySql = () =>
    void navigator.clipboard
      .writeText(displaySql)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})

  return (
    <div
      className="ask-fade-up grid grid-cols-1 gap-4 rounded-[20px] border border-border bg-card p-4 shadow-[var(--shadow-rest)] transition-opacity duration-200 md:grid-cols-[minmax(0,1fr)_320px]"
      style={{ opacity: ghost ? 0.55 : 1 }}
      aria-busy={applyingChoice || updating}
    >
      <div className="flex items-start justify-between gap-3 md:col-span-2">
        <div className="min-w-0">
          <h2 className="text-[17px] font-[550] text-balance text-foreground">
            {compiled.title}
          </h2>
          {compiled.subtitle && (
            <p className="text-[13px] text-muted-foreground">
              {compiled.subtitle}
            </p>
          )}
          {updating && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" aria-hidden />
              Updating…
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 text-muted-foreground data-[open=true]:text-brand"
            data-open={sqlOpen}
            aria-expanded={sqlOpen}
            onClick={() => setSqlOpen((v) => !v)}
          >
            <CodeIcon className="size-3.5" /> SQL
            <ChevronDownIcon className={cn("size-3 transition-transform", sqlOpen && "rotate-180")} />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Copy SQL" onClick={copySql}>
            <CopyIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {sqlOpen && (
        <div className="md:col-span-2">
          <LazySqlEditor value={displaySql} readOnly minHeight={90} maxHeight={280} className="text-[13px]" />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="outline" size="xs" onClick={copySql}>
              <CopyIcon /> {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="outline" size="xs" asChild>
              <Link href={consoleHref}>
                <ExternalLinkIcon /> Open in console
              </Link>
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-col gap-2">
        {fallback && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line-strong bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span>{fallback.reason}</span>
            <button
              type="button"
              className="shrink-0 underline underline-offset-2 hover:text-foreground"
              onClick={onShowOriginal}
            >
              Show original
            </button>
          </div>
        )}
        <div
          className="min-h-[280px] flex-1 transition-opacity duration-200 md:h-[380px]"
          style={{ opacity: updating ? 0.7 : 1 }}
        >
          {isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong p-5 text-center">
              <p className="text-sm text-muted-foreground">Nothing matched {compiled.title}.</p>
              {alternatives.length > 0 && (
                <div className="flex flex-wrap justify-center gap-1.5" role="group" aria-label="Did you mean">
                  {alternatives.map((alt) => (
                    <button
                      key={`${alt.slot}:${alt.key}`}
                      type="button"
                      className="ask-chip ask-chip-alt"
                      onClick={() => onPickAlternative(alt)}
                    >
                      {alt.text}
                    </button>
                  ))}
                </div>
              )}
              <Link
                href={`/explore/${datasetId}`}
                className="text-xs text-foreground underline underline-offset-2"
              >
                Explore the data →
              </Link>
            </div>
          ) : (
            <ChartView
              spec={spec}
              result={shownResult}
              profile={shownProfile}
              className="h-full"
              animate={!ghost}
            />
          )}
        </div>
        {!isEmpty && rowsLimit !== undefined && (
          <RowsPager
            limit={rowsLimit}
            offset={pageOffset}
            rowCount={shownResult.rows.length}
            onPage={goToPage}
            loading={pageLoading}
          />
        )}
      </div>

      <aside className="flex flex-col gap-4">
        {outcome.slots.length > 0 && (
          <div>
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              How Jev read this
            </p>
            <div className="flex flex-col gap-0.5">
              {outcome.slots.map((slot) => (
                <InterpretationChip
                  key={slot.slot}
                  slot={slot}
                  onPick={(key) => onApplyChoice(slot.slot, key)}
                />
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
            Was this right?
          </p>
          {feedback ? (
            <p className="px-2 text-[13px] text-muted-foreground">Thanks for the feedback.</p>
          ) : (
            <div className="flex items-center gap-1 px-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="This answer looks right"
                    onClick={() => sendFeedback("up")}
                  >
                    <ThumbsUpIcon className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Looks right</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="This answer looks wrong"
                    onClick={() => sendFeedback("down")}
                  >
                    <ThumbsDownIcon className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Looks wrong</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {decision && decision.ranking.length > 1 && (
          <div>
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              Show as
            </p>
            <div className="flex flex-wrap gap-1 px-2">
              {decision.ranking.slice(0, 6).map(({ type, p }) => {
                const entry = chartRegistry[type]
                const Icon = entry?.icon
                const active = type === spec.type
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => onSwitchChart(type)}
                    data-active={active}
                    className="ask-chip h-7 gap-1 px-2 text-xs data-[active=true]:border-brand/40 data-[active=true]:bg-brand-soft data-[active=true]:text-brand"
                  >
                    {Icon && <Icon className="size-3.5" />}
                    {entry?.label ?? type}
                    <span className="tabular-nums opacity-60">
                      {Math.round(p * 100)}%
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <p className="px-2 text-xs text-muted-foreground">
          {metaLine(askResult)}
        </p>

        <Button
          className="mt-auto w-full gap-1.5 rounded-full pr-2 pl-3"
          onClick={onPin}
          disabled={pinning}
          aria-keyshortcuts={`${mod === "⌘" ? "Meta" : "Control"}+Enter`}
        >
          Pin to dashboard
          <span className="inline-flex items-center gap-0.5 opacity-60">
            <Kbd className="h-4 min-w-4 border-0 bg-transparent px-0.5 text-current">
              {mod}
            </Kbd>
            <Kbd className="h-4 min-w-4 border-0 bg-transparent px-0.5 text-current">
              Enter
            </Kbd>
          </span>
        </Button>
      </aside>
    </div>
  )
}

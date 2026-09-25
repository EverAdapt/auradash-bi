/**
 * OWNER: ask-board. The ask box: a centred hero (shapeshift shell) with a cycling placeholder, a
 * chip row that switches between Try prompts / Did-you-mean / a stage hint, and the preview stage
 * that animates in once a question has something to show.
 * shapeshift-porting-guide.md §1.8-2.12 for the ported patterns; decide.ts holds the calm state
 * machine, pipeline.ts the query pipeline.
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { Link, useSearch } from "wouter"
import { toast } from "sonner"
import { cn } from "cn"
import { SparklesIcon } from "lucide-react"
import type { Catalog, ChartType, DatasetId } from "@shared/contract"
import { getCatalog } from "@/lib/catalog"
import { applyChoice, type Alternative, type SlotKey } from "@/lib/plan"
import { logEvent } from "@/lib/telemetry"
import {
  looksLikeAQuestion,
  rerunFromOutcome,
  switchChart,
  useAsk,
  type AskResult,
} from "@/lib/ask/pipeline"
import { modKeyLabel } from "@/lib/ask/platform"
import {
  decide,
  force,
  initialMemory,
  normalizeQuestion,
  promote,
  signatureOf,
  type DecideMemory,
} from "./decide"
import { PreviewStage } from "./PreviewStage"
import { CommandPalette } from "./CommandPalette"
import { Kbd } from "@/components/ui/kbd"
import { Button } from "@/components/ui/button"
import { useDatasets } from "@/state/datasets"
import { usePins, type NewPin } from "@/state/pins"
import { useUiStore } from "@/state/ui"
import "./ask.css"

function Suggestions({
  lead,
  examples,
  onPick,
}: {
  lead: string
  examples: string[]
  onPick: (text: string) => void
}) {
  if (examples.length === 0) return null
  return (
    <div className="ask-chip-row" role="group" aria-label="Suggestions">
      <span className="shrink-0 text-[13px] text-muted-foreground">{lead}</span>
      {examples.map((example) => (
        <button
          key={example}
          type="button"
          className="ask-chip"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(example)}
        >
          {example}
        </button>
      ))}
    </div>
  )
}

function DidYouMean({
  alternatives,
  active,
  onPick,
  onHighlight,
}: {
  alternatives: Alternative[]
  active: number
  onPick: (alt: Alternative) => void
  onHighlight: (i: number) => void
}) {
  return (
    <div className="ask-chip-row" role="group" aria-label="Did you mean">
      <span className="shrink-0 text-[13px] text-muted-foreground">
        Did you mean
      </span>
      {alternatives.map((alt, i) => (
        <button
          key={`${alt.slot}:${alt.key}`}
          type="button"
          className="ask-chip ask-chip-alt"
          data-active={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => onPick(alt)}
        >
          {alt.text}
          <span
            className="ask-chip-bar"
            style={{ transform: `scaleX(${Math.max(0.05, alt.p)})` }}
          />
        </button>
      ))}
      <span className="ask-hint shrink-0">← → to choose</span>
    </div>
  )
}

const CACHE_LIMIT = 8

export function AskPanel() {
  const datasetId = useDatasets((s) => s.currentId)
  const setCurrentDataset = useDatasets((s) => s.setCurrent)

  const [text, setText] = useState("")
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [chipIndex, setChipIndex] = useState(0)
  const [applyingChoice, setApplyingChoice] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [cacheTick, bumpCache] = useReducer((n: number) => n + 1, 0)

  const inputRef = useRef<HTMLInputElement>(null)
  const { status, stage, askResult, askedText, runNow, clear } = useAsk(
    text,
    datasetId
  )

  // Fold each new AskResult into the calm UI state during render (React's documented "adjusting
  // state when a prop changes" pattern: https://react.dev/learn/you-might-not-need-an-effect) —
  // `foldedResult` (state, not a ref) is what makes this legal to do outside an effect.
  const [mem, setMem] = useState<DecideMemory>(initialMemory)
  const [foldedResult, setFoldedResult] = useState<AskResult | null>(null)
  // A question the user explicitly ran (Try chip, Enter, a shared ?q= link) shows its answer in
  // full straight away; only live-typing previews go through the calm ghost/commit hysteresis.
  const [explicitText, setExplicitText] = useState<string | null>(null)
  if (foldedResult !== askResult) {
    setFoldedResult(askResult)
    const sig = askResult ? signatureOf(askResult.outcome) : null
    setMem(
      askResult && sig && explicitText !== null && explicitText.trim() === askedText
        ? force(sig, askedText)
        : askResult
          ? decide(mem, askResult.outcome, askedText)
          : initialMemory
    )
    setChipIndex(0)
  }

  // A tiny, purely-cosmetic acknowledgement for "Enter did nothing because the shown preview
  // already answers this exact question" — see `onEnter`.
  const [confirmPulse, setConfirmPulse] = useState(false)
  useEffect(() => {
    if (!confirmPulse) return
    const id = window.setTimeout(() => setConfirmPulse(false), 200)
    return () => window.clearTimeout(id)
  }, [confirmPulse])

  const paletteOpen = useUiStore((s) => s.paletteOpen)
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)

  // ── dataset catalog: tryPrompts, table count, cycling placeholder ──
  useEffect(() => {
    let cancelled = false
    getCatalog(datasetId)
      .then((c) => !cancelled && setCatalog(c))
      .catch(() => !cancelled && setCatalog(null))
    return () => {
      cancelled = true
    }
  }, [datasetId])

  const tryPromptTexts = catalog?.tryPrompts.map((p) => p.text) ?? []
  useEffect(() => {
    if (text || tryPromptTexts.length < 2) return
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return
    const id = window.setInterval(
      () => setPlaceholderIndex((n) => (n + 1) % tryPromptTexts.length),
      2800
    )
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text === "", tryPromptTexts.length])

  // ── a small cache of past AskResults, keyed by compiled-SQL signature, so a "held" committed
  //    preview (a challenger hasn't won yet) still has real data to show. ──
  const resultCacheRef = useRef(new Map<string, AskResult>())
  useEffect(() => {
    if (!askResult) return
    const sig = signatureOf(askResult.outcome)
    if (!sig) return
    const cache = resultCacheRef.current
    cache.set(sig, askResult)
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }, [askResult])

  const ui = mem.ui
  const activeKey =
    ui.kind === "ghost" || ui.kind === "committed" ? ui.key : null
  // Reading a Map cache during render (never mutated during render, only from effects/callbacks)
  // to resolve which past AskResult a "held" committed preview should show; `cacheTick` forces a
  // re-render after `onSwitchChart` mutates an entry in place.
  /* eslint-disable react-hooks/refs */
  const activeResult: AskResult | null = activeKey
    ? (resultCacheRef.current.get(activeKey) ??
      (askResult && signatureOf(askResult.outcome) === activeKey
        ? askResult
        : null))
    : null
  /* eslint-enable react-hooks/refs */
  void cacheTick

  const alternatives =
    askResult?.outcome.status === "ok"
      ? (askResult.outcome.alternatives ?? [])
      : []
  const hasAlternatives = alternatives.length > 0

  // Staleness: the live input has moved on from the text the shown preview (`mem.shownText`) was
  // computed for. Rather than hide the (still real, still useful) preview, this drives a calm
  // "Updating…" indicator while a fresh answer is on the way, or a quiet "Press Enter to update"
  // hint when the edit is too short to auto-run — see PreviewStage's `updating` prop and the chip
  // row below.
  const normalizedText = normalizeQuestion(text)
  const stale = mem.shownText !== null && normalizedText !== mem.shownText
  const willAutoRun = looksLikeAQuestion(text)
  const updating = stale && willAutoRun
  const pressEnterToUpdate = stale && !willAutoRun
  const mod = modKeyLabel()

  const focusInput = useCallback(
    () =>
      requestAnimationFrame(() =>
        inputRef.current?.focus({ preventScroll: true })
      ),
    []
  )

  const onClear = useCallback(() => {
    setText("")
    clear()
    setMem(initialMemory)
    focusInput()
  }, [clear, focusInput])

  const fillAndRun = useCallback(
    (example: string) => {
      logEvent({ type: "try_prompt", datasetId, question: example })
      setText(example)
      setExplicitText(example)
      runNow(example)
      focusInput()
    },
    [datasetId, runNow, focusInput]
  )

  const applyAndRerun = useCallback(
    async (slot: SlotKey, optionKey: string, source: "slot_change" | "did_you_mean" = "slot_change") => {
      if (!askResult) return
      logEvent({
        type: source,
        datasetId,
        question: askResult.outcome.question,
        data: { slot, optionKey },
      })
      setApplyingChoice(true)
      try {
        const freshCatalog = await getCatalog(datasetId)
        const newOutcome = applyChoice(
          askResult.outcome,
          slot,
          optionKey,
          freshCatalog
        )
        const rerun = await rerunFromOutcome(newOutcome, datasetId)
        const sig = signatureOf(rerun.outcome)
        if (sig) {
          resultCacheRef.current.set(sig, rerun)
          setMem(force(sig, askedText))
        }
      } finally {
        setApplyingChoice(false)
      }
    },
    [askResult, datasetId, askedText]
  )

  const onSwitchChart = useCallback(
    (type: ChartType) => {
      if (!activeResult || !activeKey) return
      logEvent({
        type: "chart_switch",
        datasetId,
        question: activeResult.outcome.question,
        data: { chart: type },
      })
      const switched = switchChart(activeResult, type)
      resultCacheRef.current.set(activeKey, switched)
      bumpCache()
    },
    [activeResult, activeKey, datasetId]
  )

  // "Show original": swap a fallback answer back for the true (empty) one it stood in for —
  // stored under the same cache key as the fallback (see resultCacheRef's doc comment), exactly
  // like `onSwitchChart` above.
  const onShowOriginal = useCallback(() => {
    if (!activeResult?.fallback || !activeKey) return
    resultCacheRef.current.set(activeKey, activeResult.fallback.original)
    bumpCache()
  }, [activeResult, activeKey])

  const pin = useCallback(() => {
    if (!activeResult?.result || !activeResult.profile || !activeResult.spec)
      return
    const compiled = activeResult.outcome.compiled
    if (!compiled) return
    setPinning(true)
    const newPin: NewPin = {
      datasetId,
      question: activeResult.outcome.question,
      title: compiled.title,
      subtitle: compiled.subtitle,
      plan: activeResult.outcome.plan,
      sql: compiled.sql,
      params: compiled.params,
      columns: compiled.columns,
      chart: activeResult.spec,
      chartRanking: activeResult.decision?.ranking,
    }
    usePins.getState().addPin(newPin)
    logEvent({
      type: "pin",
      datasetId,
      question: activeResult.outcome.question,
      data: { title: compiled.title, chart: activeResult.spec.type },
    })
    toast.success("Pinned to your board")
    setPinning(false)
    onClear()
  }, [activeResult, datasetId, onClear])

  // Enter runs the current text now — immediate, no debounce (`runNow` calls `execute`, which
  // aborts whatever's in flight before starting the new request). If the shown preview already
  // answers this exact question (nothing has changed since it was forced/committed), there is
  // nothing to run: Enter is a no-op that just keeps focus, with a tiny visual acknowledgement.
  // Pinning has moved to Ctrl/Cmd+Enter and the Pin button — see `onKeyDown` and `PreviewStage`.
  const onEnter = useCallback(() => {
    const normalized = normalizeQuestion(text)
    if (ui.kind !== "input" && normalized && mem.shownText === normalized) {
      setConfirmPulse(true)
      focusInput()
      return
    }
    setExplicitText(text)
    runNow()
  }, [ui, mem, text, runNow, focusInput])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "/" && text === "") {
      e.preventDefault()
      setPaletteOpen(true)
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      pin()
    } else if (e.key === "Enter") {
      e.preventDefault()
      onEnter()
    } else if (e.key === "Escape" && text) {
      e.preventDefault()
      onClear()
    } else if (e.key === "Tab" && !e.shiftKey && ui.kind === "ghost") {
      e.preventDefault()
      setMem(promote(mem))
    } else if (
      hasAlternatives &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight")
    ) {
      const atEnd =
        e.currentTarget.selectionStart === e.currentTarget.value.length
      if (!atEnd) return
      e.preventDefault()
      setChipIndex((i) => {
        const n = alternatives.length
        return e.key === "ArrowLeft" ? (i - 1 + n) % n : (i + 1) % n
      })
    }
  }

  // "/" anywhere on the page (outside a field or dialog) jumps to the ask box, and opens the
  // palette when the box is empty.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== "/" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.defaultPrevented
      )
        return
      const target = e.target
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]'
        )
      )
        return
      e.preventDefault()
      inputRef.current?.focus()
      if (!inputRef.current?.value) setPaletteOpen(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setPaletteOpen])

  // URL contract: ?d= switches dataset, ?q= fills and runs, once per distinct search string.
  // The dataset list may still be loading on a cold start, so ?d= is trusted as-is (an unknown
  // id simply fails to load its catalog); the question waits until the switch has taken effect,
  // otherwise it would run against the previous dataset.
  const search = useSearch()
  const appliedSearchRef = useRef<string | null>(null)
  const pendingRunRef = useRef<{ q: string; d: DatasetId } | null>(null)
  useEffect(() => {
    if (appliedSearchRef.current === search) return
    appliedSearchRef.current = search
    const params = new URLSearchParams(search)
    const d = params.get("d") as DatasetId | null
    const q = params.get("q")
    // Synchronizing from the URL (an external system) on load/navigation, guarded above against
    // re-firing for the same search string — the textbook useEffect case, not a derived-state one.
    if (d && d !== datasetId) {
      setCurrentDataset(d)
      if (q) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setText(q)
        setExplicitText(q)
        pendingRunRef.current = { q, d }
      }
      return
    }
    if (q) {
      setText(q)
      setExplicitText(q)
      runNow(q)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  useEffect(() => {
    const pending = pendingRunRef.current
    if (!pending || pending.d !== datasetId) return
    pendingRunRef.current = null
    runNow(pending.q)
  }, [datasetId, runNow])

  const stageLabel =
    stage === "plan"
      ? "Reading your question"
      : stage === "sql"
        ? "Running the query"
        : stage === "chart"
          ? "Choosing a chart"
          : "Finding the right chart…"

  let chipRow: ReactNode
  if (hasAlternatives) {
    chipRow = (
      <DidYouMean
        alternatives={alternatives}
        active={chipIndex}
        onPick={(alt) => void applyAndRerun(alt.slot, alt.key, "did_you_mean")}
        onHighlight={setChipIndex}
      />
    )
  } else if (text.trim().length < 2) {
    chipRow = (
      <Suggestions
        lead="Try"
        examples={tryPromptTexts.slice(0, 5)}
        onPick={fillAndRun}
      />
    )
  } else if (pressEnterToUpdate) {
    // The input has moved on from the shown preview, but the edit is too short to auto-run
    // (`looksLikeAQuestion`) — staleness must stay visible, never silent.
    chipRow = (
      <div className="ask-chip-row">
        <span className="ask-hint">
          Press <Kbd>Enter</Kbd> to update
        </span>
      </div>
    )
  } else if (updating) {
    chipRow = (
      <div className="ask-chip-row">
        <span className="ask-hint ask-shimmer">Updating…</span>
      </div>
    )
  } else if (ui.kind === "ghost") {
    chipRow = (
      <div className="ask-chip-row">
        <span className="ask-hint">
          Looks like a match. <Kbd>Tab</Kbd> accepts · <Kbd>{mod}</Kbd>
          <Kbd>Enter</Kbd> pins
        </span>
      </div>
    )
  } else if (ui.kind === "committed") {
    chipRow = (
      <div className="ask-chip-row">
        <span className="ask-hint">
          <Kbd>Enter</Kbd> runs · <Kbd>{mod}</Kbd>
          <Kbd>Enter</Kbd> pins · <Kbd>Esc</Kbd> clears
        </span>
      </div>
    )
  } else if (status === "error") {
    chipRow = (
      <Suggestions
        lead="That could not be read just now. Try"
        examples={tryPromptTexts.slice(0, 4)}
        onPick={fillAndRun}
      />
    )
  } else if (status === "thinking" || askedText !== text) {
    chipRow = (
      <div className="ask-chip-row">
        <span className="ask-hint ask-shimmer">{stageLabel}</span>
      </div>
    )
  } else {
    chipRow = (
      <Suggestions
        lead="No match yet. Try"
        examples={tryPromptTexts.slice(0, 4)}
        onPick={fillAndRun}
      />
    )
  }

  const showStage = text.trim().length > 0 || activeResult !== null

  let stageContent: ReactNode = null
  if (activeResult) {
    stageContent = (
      <PreviewStage
        askResult={activeResult}
        outcome={activeResult.outcome}
        datasetId={datasetId}
        ghost={ui.kind === "ghost"}
        updating={updating}
        pinning={pinning}
        applyingChoice={applyingChoice}
        onApplyChoice={(slot, key) => void applyAndRerun(slot, key)}
        onSwitchChart={onSwitchChart}
        onPin={pin}
        onShowOriginal={onShowOriginal}
        alternatives={
          activeResult?.outcome.status === "ok"
            ? (activeResult.outcome.alternatives ?? [])
            : []
        }
        onPickAlternative={(alt) =>
          void applyAndRerun(alt.slot, alt.key, "did_you_mean")
        }
      />
    )
  } else if (
    askResult &&
    (askResult.outcome.status === "out_of_scope" ||
      askResult.outcome.status === "no_match")
  ) {
    stageContent = (
      <div className="rounded-[20px] border border-dashed border-line-strong p-5 text-center">
        <p className="text-sm text-muted-foreground">
          {askResult.outcome.message ??
            "That doesn't look like it's in this dataset."}
        </p>
        <div className="mt-3">
          <Suggestions
            lead="Try"
            examples={tryPromptTexts.slice(0, 4)}
            onPick={fillAndRun}
          />
        </div>
        <Link
          href={`/explore/${datasetId}`}
          className="mt-2 inline-block text-xs text-foreground underline underline-offset-2"
        >
          Explore the data →
        </Link>
      </div>
    )
  } else if (askResult?.error) {
    stageContent = (
      <div className="rounded-[20px] border border-dashed border-line-strong p-5 text-center text-sm text-muted-foreground">
        That question could not be run right now. {askResult.error}
      </div>
    )
  } else if (showStage) {
    stageContent = (
      <div className="rounded-[20px] border border-dashed border-line-strong p-5 text-center text-sm text-muted-foreground">
        {status === "thinking" ? (
          "Finding the right chart…"
        ) : (
          <>
            Keep typing, or press <Kbd>/</Kbd> to browse prompts.
          </>
        )}
      </div>
    )
  }

  const modName = mod === "⌘" ? "Command" : "Control"
  const announcement = updating
    ? "Updating the preview."
    : ui.kind === "committed"
      ? `Showing a preview. ${modName} plus Enter pins it.`
      : hasAlternatives
        ? "Did you mean chips available. Use the left and right arrows to choose."
        : ""

  const floatShadow =
    ui.kind === "committed"
      ? "var(--shadow-float)"
      : ui.kind === "ghost"
        ? "var(--shadow-lift)"
        : "var(--shadow-rest)"

  return (
    <section
      className="mx-auto w-full max-w-[1240px] px-4 pt-[8vh] pb-8"
      aria-label="Ask a question"
    >
      <div
        className="relative overflow-hidden rounded-[28px] border border-border bg-card transition-shadow duration-200"
        style={{ boxShadow: floatShadow }}
      >
        <div className="relative flex h-16 items-center gap-3 px-5">
          <SparklesIcon
            className={cn(
              "size-5 shrink-0 text-brand transition-transform duration-150",
              confirmPulse && "scale-125"
            )}
            aria-hidden
          />
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => {
                const value = e.target.value
                setText(value)
                if (!value.trim()) {
                  clear()
                  setMem(initialMemory)
                }
              }}
              onKeyDown={onKeyDown}
              className="relative z-1 h-8 w-full bg-transparent text-[20px] leading-8 font-[450] tracking-[-0.01em] text-foreground caret-brand outline-none md:text-[22px]"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              maxLength={300}
              aria-label="Ask a question about the data"
              aria-describedby="ask-hint"
            />
            {text === "" && tryPromptTexts.length > 0 && (
              <span
                key={placeholderIndex}
                className="ask-placeholder pointer-events-none absolute inset-y-0 right-0 left-0 flex items-center truncate text-[20px] text-muted-foreground md:text-[22px]"
                aria-hidden
              >
                Try: {tryPromptTexts[placeholderIndex % tryPromptTexts.length]}
              </span>
            )}
          </div>
          {text ? (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-xs text-muted-foreground"
              onClick={onClear}
            >
              Esc
            </Button>
          ) : (
            <Kbd className="shrink-0" title="Browse every prompt">
              /
            </Kbd>
          )}
        </div>
      </div>

      <div className="mt-3">{chipRow}</div>

      {catalog && (
        <p className="mt-2 px-1 text-[13px] text-muted-foreground">
          Asking {catalog.title} ·{" "}
          {catalog.tables.filter((t) => !t.hidden).length} tables ·{" "}
          <Link
            href={`/explore/${datasetId}`}
            className="text-foreground underline underline-offset-2 hover:text-brand"
          >
            Explore the data →
          </Link>
        </p>
      )}

      {showStage && <div className="ask-fade-up mt-4">{stageContent}</div>}

      <p id="ask-hint" className="sr-only">
        Type a question. Enter runs it. {modName} plus Enter pins the preview.
        Escape clears. Tab accepts a faded preview. Slash browses every prompt.
      </p>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        currentDatasetId={datasetId}
        onPickPrompt={(question, id) => {
          if (id !== datasetId) setCurrentDataset(id)
          fillAndRun(question)
        }}
        onSwitchDataset={setCurrentDataset}
      />
    </section>
  )
}

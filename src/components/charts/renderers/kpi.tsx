/**
 * OWNER: charts. KPI: a hero number with a label, an optional second stat, and "as of <year>"
 * context when a time column rides along. When the result is exactly two rows over one time
 * column (a "population in 1986 vs 2025" shape — see eligible.ts/offline.ts), it switches to
 * comparison mode: the later value stays the hero, with a "vs <earlier year>: <value>" line, a
 * delta chip (absolute + %, with an up/down arrow) and a tiny two-bar comparison underneath.
 *
 * The delta chip is always drawn in a neutral ink, never green/red: ResultColumnMeta (unlike the
 * catalog's CatalogColumn) carries no `direction` today, so this renderer genuinely has no signal
 * for "is more of this good" — coloring it anyway would be a guess dressed up as a fact.
 */
import { formatCompact, formatValue, formatYear } from "@/lib/viz"
import { Hash, Minus, TrendingDown, TrendingUp } from "lucide-react"
import { cn } from "cn"
import { ChartEmptyState } from "../shared/EmptyState"
import { useCountUp, usePrefersReducedMotion } from "../shared/hooks"
import { findColumn } from "../shared/lookup"
import { toRows } from "../shared/rows"
import type { RendererProps } from "../shared/types"

export function KpiRenderer({ spec, result, profile, className, animate = true, compact }: RendererProps) {
  // Every hook runs before any early return: `numeric` falls back to 0 (animation disabled) when
  // there is nothing to show, so the empty state below never skips a hook call.
  const reducedMotion = usePrefersReducedMotion()
  const rows = toRows(result)
  const yCols = (spec.y ?? []).map((name) => findColumn(profile, name)).filter((c) => c !== undefined)
  const timeCol = findColumn(profile, spec.x)
  const primary = yCols[0]

  const isComparison = rows.length === 2 && yCols.length === 1 && Boolean(timeCol)
  // Chronological order regardless of how the query returned the two rows: "later" always means
  // the later time value.
  const sorted =
    isComparison && timeCol ? [...rows].sort((a, b) => Number(a[timeCol.name]) - Number(b[timeCol.name])) : rows
  const row = sorted[sorted.length - 1]

  const rawValue = primary && row ? row[primary.name] : undefined
  const numeric = typeof rawValue === "number" ? rawValue : undefined
  const isInt = numeric !== undefined && Number.isInteger(numeric)
  const enableCountUp = animate && !reducedMotion && isInt
  const animated = useCountUp(numeric ?? 0, enableCountUp)

  if (!row || !primary) {
    return <ChartEmptyState icon={Hash} title="No number" description="This result has nothing to lead with." />
  }

  const shown = numeric === undefined ? undefined : enableCountUp ? Math.round(animated) : numeric
  const text = shown === undefined ? String(rawValue ?? "—") : formatValue(shown, primary.format, primary.unit)

  const secondary = yCols[1]
  const secondaryValue = secondary ? row[secondary.name] : undefined
  const yearValue = timeCol ? row[timeCol.name] : undefined

  if (isComparison && timeCol) {
    const earlierRow = sorted[0]
    const earlierValue = earlierRow[primary.name]
    const earlierNumeric = typeof earlierValue === "number" ? earlierValue : undefined
    const earlierYear = earlierRow[timeCol.name]

    const delta = numeric !== undefined && earlierNumeric !== undefined ? numeric - earlierNumeric : undefined
    const percent = delta !== undefined && earlierNumeric ? (delta / Math.abs(earlierNumeric)) * 100 : undefined
    const TrendIcon = delta === undefined || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown

    const barMax = Math.max(Math.abs(numeric ?? 0), Math.abs(earlierNumeric ?? 0)) || 1
    const barBoxHeight = compact ? 14 : 36
    const barWidthClass = compact ? "w-3" : "w-6"

    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center overflow-hidden px-3 text-center",
          compact ? "min-h-0 gap-0.5 py-1" : "min-h-[120px] gap-1.5",
          className
        )}
      >
        <div
          className={cn(
            "font-sans leading-none font-medium tabular-nums text-foreground",
            compact ? "text-[34px]" : "text-[40px] sm:text-[48px]"
          )}
          style={{ fontWeight: 550 }}
        >
          {text}
        </div>
        <div className={cn("font-medium text-muted-foreground leading-tight", compact ? "text-[10px]" : "text-sm")}>
          {primary.label}
        </div>

        {delta !== undefined && earlierNumeric !== undefined && (
          <>
            <div className={cn("text-muted-foreground leading-tight", compact ? "text-[10px]" : "text-xs")}>
              vs {typeof earlierYear === "number" ? formatYear(earlierYear) : String(earlierYear)}:{" "}
              <span className="tabular-nums text-foreground">
                {formatValue(earlierNumeric, primary.format, primary.unit)}
              </span>
            </div>
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-full bg-secondary font-medium text-ink-2 tabular-nums",
                compact ? "px-1.5 py-px text-[10px]" : "px-2.5 py-1 text-xs"
              )}
            >
              <TrendIcon className={compact ? "size-2.5" : "size-3.5"} aria-hidden />
              <span>
                {delta > 0 ? "+" : ""}
                {formatCompact(delta)}
                {percent !== undefined && Number.isFinite(percent)
                  ? ` (${percent > 0 ? "+" : ""}${percent.toFixed(1)}%)`
                  : ""}
              </span>
            </div>
            {/* A tiny, axis-free comparison — decorative context, not a plot to hover. */}
            <div className={cn("flex shrink-0 items-end", compact ? "gap-1" : "mt-1 gap-1.5")} style={{ height: barBoxHeight }} aria-hidden>
              <div
                className={cn(barWidthClass, "rounded-t-sm bg-line-strong")}
                style={{ height: Math.max(2, (Math.abs(earlierNumeric) / barMax) * barBoxHeight) }}
              />
              <div
                className={cn(barWidthClass, "rounded-t-sm bg-brand")}
                style={{ height: Math.max(2, (Math.abs(numeric ?? 0) / barMax) * barBoxHeight) }}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className={cn("flex h-full min-h-[120px] w-full flex-col items-center justify-center gap-1.5 px-4 text-center", className)}>
      <div
        className="font-sans text-[44px] leading-none font-medium tabular-nums text-foreground sm:text-[52px]"
        style={{ fontWeight: 550 }}
      >
        {text}
      </div>
      <div className="text-sm font-medium text-muted-foreground">{primary.label}</div>
      {(secondary || yearValue !== undefined) && (
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          {yearValue !== undefined && yearValue !== null && (
            // "as of 2024" only reads right for a real time column; a category riding along (the
            // winning weekday, band or group of a single-row answer) is shown as itself.
            <span>
              {timeCol?.kind === "time" ? "as of " : ""}
              {typeof yearValue === "number" && timeCol?.kind === "time" ? formatYear(yearValue) : yearValue}
            </span>
          )}
          {secondary && secondaryValue !== undefined && (
            <span>
              {secondary.label}: <span className="tabular-nums text-foreground">{formatValue(secondaryValue, secondary.format, secondary.unit)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * OWNER: charts. Categorical + sequential color from the dataviz reference palette
 * (src/index.css). Never hardcode hex here — every value is a `--series-N` / `--seq-N` CSS
 * variable, so light/dark swap for free.
 */
export const OTHER_KEY = "__other__"

const SERIES_VARS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`)
export const OTHER_COLOR = "var(--series-other)"
export const SEQ_STEPS = [100, 200, 300, 400, 500, 600, 700].map((n) => `var(--seq-${n})`)
export const SEQ_EMPTY = "var(--seq-empty)"

export interface SeriesPlan {
  /** legend/series order: entity order as encountered, folded tail replaced by "Other" */
  keys: string[]
  colorOf: (key: string) => string
  /** entities folded into "Other" (only non-empty once there are more than 8) */
  folded: Set<string>
}

/**
 * Colour follows the entity, in the order it first appears — never re-sorted by value or rank.
 * More than 8 entities fold the tail into "Other" (top 7 keep their own slot, slot 8 is Other).
 */
export function planSeries(entities: string[]): SeriesPlan {
  if (entities.length <= 8) {
    const colors = new Map(entities.map((e, i) => [e, SERIES_VARS[i]]))
    return { keys: entities, colorOf: (k) => colors.get(k) ?? OTHER_COLOR, folded: new Set() }
  }
  const keep = entities.slice(0, 7)
  const folded = new Set(entities.slice(7))
  const colors = new Map(keep.map((e, i) => [e, SERIES_VARS[i]]))
  return {
    keys: [...keep, OTHER_KEY],
    colorOf: (k) => (folded.has(k) ? OTHER_COLOR : (colors.get(k) ?? OTHER_COLOR)),
    folded,
  }
}

/** Bucket a value into one of the 7 sequential steps (index 0-6), clamped to [min, max]. */
export function seqBucket(value: number, min: number, max: number): number {
  if (max <= min) return SEQ_STEPS.length - 1
  const ratio = (value - min) / (max - min)
  return Math.min(SEQ_STEPS.length - 1, Math.max(0, Math.floor(ratio * SEQ_STEPS.length)))
}

/** Sequential fill for a magnitude value; SEQ_EMPTY for null/NaN (the "no data" cell/feature). */
export function seqColor(value: number | null | undefined, min: number, max: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return SEQ_EMPTY
  return SEQ_STEPS[seqBucket(value, min, max)]
}

/**
 * Ascending breakpoints that split `values` into as many roughly-equal-count buckets as
 * `SEQ_STEPS`. A quantile scale keeps a skewed distribution (one huge outlier, a long tail of
 * small values — e.g. one country with 400 Nobel laureates and 90 with 1-5) legible: a plain
 * min-max scale collapses everything but the outlier into the single lightest step.
 */
export function quantileBreaks(values: number[]): number[] {
  const steps = SEQ_STEPS.length
  const sorted = [...values].sort((a, b) => a - b)
  const breaks: number[] = []
  for (let i = 1; i < steps && sorted.length > 0; i++) {
    breaks.push(sorted[Math.min(sorted.length - 1, Math.floor((i / steps) * sorted.length))])
  }
  return breaks
}

/** Sequential fill from quantile `breaks` (see `quantileBreaks`); SEQ_EMPTY for null/NaN. */
export function seqColorQuantile(value: number | null | undefined, breaks: number[]): string {
  if (value === null || value === undefined || Number.isNaN(value)) return SEQ_EMPTY
  let bucket = 0
  for (const b of breaks) {
    if (value > b) bucket++
  }
  return SEQ_STEPS[Math.min(SEQ_STEPS.length - 1, bucket)]
}

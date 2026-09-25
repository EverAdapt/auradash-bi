/**
 * OWNER: planner. Finds the filter candidates and numbers a question mentions, all by code
 * (regex + a value index) — Jev only ever decides how a candidate is USED (include/exclude/not a
 * filter), never extracts it. See docs/research/jev-nl2sql.md #4 "pre_parsed_value_extraction".
 */
import type { Catalog, CatalogValue, FilterCandidate, OrPair, PeriodUnit, PlanRequest, RankWindowCandidate, TextCandidate, ThresholdCandidate, ThresholdOp } from "@shared/contract"
import { MAX_V02_CANDIDATES } from "@shared/validate"
import { findCues } from "./cues"
import { fkRoleGroupFor, nearestTimeColumn, tableDistances } from "./graph"
import { editDistance, isStopword, normalizeText, singularize, tokenize } from "./normalize"

export interface Candidates {
  filters: FilterCandidate[]
  numbers: string[]
  thresholds: ThresholdCandidate[]
  texts: TextCandidate[]
  orPairs: OrPair[]
  rankWindows: RankWindowCandidate[]
  cues: NonNullable<PlanRequest["cues"]>
}

const MAX_FILTERS = 12
const MAX_SPAN = 5
const MIN_FUZZY_LEN = 5

const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
}

interface IndexEntry {
  column: string
  value: string // canonical stored value
  display: string
  isAlias: boolean
  isDimension: boolean
}

interface ValueIndex {
  /** normalized span text -> candidate matches (several when the same text names several things) */
  byText: Map<string, IndexEntry[]>
  /** normalized single tokens available for fuzzy matching, with their entries */
  fuzzyTokens: { norm: string; entries: IndexEntry[] }[]
}

const indexCache = new WeakMap<Catalog, ValueIndex>()

function columnMeta(catalog: Catalog, columnKey: string) {
  const table = columnKey.split(".")[0]!
  const t = catalog.tables.find((x) => x.name === table)
  const col = t?.columns.find((c) => c.key === columnKey)
  return { isDimension: col?.role === "dimension" }
}

/** Builds the value index once per catalog (cached by object identity). */
function buildValueIndex(catalog: Catalog): ValueIndex {
  const cached = indexCache.get(catalog)
  if (cached) return cached

  const byText = new Map<string, IndexEntry[]>()
  const push = (norm: string, entry: IndexEntry) => {
    if (!norm) return
    const list = byText.get(norm)
    if (list) list.push(entry)
    else byText.set(norm, [entry])
  }

  const addValue = (v: CatalogValue) => {
    // Metadata tables (World's `indicators`) are hidden in the semantic layer, so their values never
    // reach catalog.values; standalone fact tables (Swift's awards) keep theirs.
    const { isDimension } = columnMeta(catalog, v.column)
    const display = v.display ?? v.value
    const canonical: IndexEntry = { column: v.column, value: v.value, display, isAlias: false, isDimension }
    push(normalizeText(v.value), canonical)
    if (v.display) push(normalizeText(v.display), canonical)
    for (const alias of v.aliases) {
      push(normalizeText(alias), { ...canonical, isAlias: true })
    }
  }
  for (const v of catalog.values) addValue(v)

  const fuzzyTokens: { norm: string; entries: IndexEntry[] }[] = []
  for (const [norm, entries] of byText) {
    if (!norm.includes(" ") && norm.length >= MIN_FUZZY_LEN) fuzzyTokens.push({ norm, entries })
  }

  const index: ValueIndex = { byText, fuzzyTokens }
  indexCache.set(catalog, index)
  return index
}

/** Prefer a dimension-role column over a label-role one, then the column closest to the fact. */
/**
 * When the same words match several columns, prefer an entity's own name (its table's display
 * column: clubs.name for "Geelong") over an attribute of something else (venues.city), then a
 * dimension over a free-text label, then the table closest to the fact.
 */
function pickBest(entries: IndexEntry[], distances: Map<string, number>, displayColumns: Set<string>): IndexEntry {
  return entries.reduce((best, e) => {
    const bestIsName = displayColumns.has(best.column)
    const eIsName = displayColumns.has(e.column)
    if (bestIsName !== eIsName) return bestIsName ? best : e
    if (best.isDimension !== e.isDimension) return best.isDimension ? best : e
    const bestTable = best.column.split(".")[0]!
    const eTable = e.column.split(".")[0]!
    const bestD = distances.get(bestTable) ?? Infinity
    const eD = distances.get(eTable) ?? Infinity
    return eD < bestD ? e : best
  })
}

function findYears(question: string, usedChars: boolean[]): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = []
  const re = /\b(1[89]\d{2}|20\d{2}|21\d{2})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(question))) {
    out.push({ value: m[1]!, start: m.index, end: m.index + m[1]!.length })
  }
  return out.filter((y) => !usedChars.slice(y.start, y.end).some(Boolean))
}

// ─────────────────────────────── v0.2: year ranges ───────────────────────────────

const YEAR_SRC = "(1[89]\\d{2}|20\\d{2}|21\\d{2})"

/** "between 1990 and 2010", "from 1990 to 2010", "1990-2010", "1990–2010", "1990 to 2010" — ONE
 *  range candidate instead of two year candidates (see findCandidates). Marks `charUsed` itself
 *  (unlike the other find* helpers here) so the plain year scan below never re-detects the same
 *  digits, and multiple range patterns in one question never double-match the same span. */
function findYearRanges(question: string, charUsed: boolean[]): { value: string; value2: string; start: number; end: number }[] {
  const out: { value: string; value2: string; start: number; end: number }[] = []
  const patterns = [
    new RegExp(`\\bbetween\\s+${YEAR_SRC}\\s+and\\s+${YEAR_SRC}\\b`, "gi"),
    new RegExp(`\\bfrom\\s+${YEAR_SRC}\\s+to\\s+${YEAR_SRC}\\b`, "gi"),
    new RegExp(`\\b${YEAR_SRC}\\s*[-–—]\\s*${YEAR_SRC}\\b`, "g"),
    new RegExp(`\\b${YEAR_SRC}\\s+to\\s+${YEAR_SRC}\\b`, "gi"),
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(question))) {
      const start = m.index
      const end = start + m[0].length
      if (charUsed.slice(start, end).some(Boolean)) continue
      out.push({ value: m[1]!, value2: m[2]!, start, end })
      for (let i = start; i < end; i++) charUsed[i] = true
    }
  }
  return out
}

// Longest phrases first so the alternation prefers "right now" over a bare "now" it contains.
const RELATIVE_NOW_PHRASES = ["at the moment", "right now", "most recent", "this year", "currently", "current", "latest", "today", "now"]
const RELATIVE_NOW_RE = new RegExp(`\\b(${RELATIVE_NOW_PHRASES.map((p) => p.replace(/ /g, "\\s+")).join("|")})\\b`, "gi")

/** "now / right now / today / currently / current / latest / at the moment / this year / most
 *  recent" — a relative-time mention that means "the latest year in the data", found by code
 *  (never by Jev) exactly like a year digit — see docs/research/jev-nl2sql.md #4. */
function findRelativeNow(question: string, usedChars: boolean[]): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  RELATIVE_NOW_RE.lastIndex = 0
  while ((m = RELATIVE_NOW_RE.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!usedChars.slice(start, end).some(Boolean)) out.push({ value: m[0], start, end })
  }
  return out
}

// ─────────────────────────────── v0.2: relative periods ───────────────────────────────

const PERIOD_UNIT_WORDS: Record<string, PeriodUnit> = {
  year: "year",
  years: "year",
  month: "month",
  months: "month",
  week: "week",
  weeks: "week",
  day: "day",
  days: "day",
  quarter: "quarter",
  quarters: "quarter",
}

/** "last|past|previous N years/months/weeks/days/quarters", "the last decade" (N=10, unit year),
 *  "last year/month/week" (N=1), "year to date"/"ytd"/"so far this year" (unit ytd, N=1). Marks
 *  `charUsed` itself (like findYearRanges) so "this year" embedded in "so far this year" is
 *  already claimed before findRelativeNow runs, and later patterns never re-match an earlier one. */
function findRelativePeriods(question: string, charUsed: boolean[]): { value: string; unit: PeriodUnit; start: number; end: number }[] {
  const out: { value: string; unit: PeriodUnit; start: number; end: number }[] = []
  const claim = (start: number, end: number) => {
    if (charUsed.slice(start, end).some(Boolean)) return false
    for (let i = start; i < end; i++) charUsed[i] = true
    return true
  }
  let m: RegExpExecArray | null

  const ytdRe = /\b(year to date|ytd|so far this year|this year so far)\b/gi
  while ((m = ytdRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (claim(start, end)) out.push({ value: "1", unit: "ytd", start, end })
  }

  const decadeRe = /\bthe last decade\b/gi
  while ((m = decadeRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (claim(start, end)) out.push({ value: "10", unit: "year", start, end })
  }

  const numWordAlt = Object.keys(NUMBER_WORDS).join("|")
  const unitAlt = "years?|months?|weeks?|days?|quarters?"
  const numberedRe = new RegExp(`\\b(?:last|past|previous)\\s+(\\d+|${numWordAlt})\\s+(${unitAlt})\\b`, "gi")
  while ((m = numberedRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    const raw = m[1]!.toLowerCase()
    const value = /^\d+$/.test(raw) ? raw : NUMBER_WORDS[raw]!
    const unit = PERIOD_UNIT_WORDS[m[2]!.toLowerCase()]!
    out.push({ value, unit, start, end })
  }

  const singularRe = /\b(?:last|past|previous)\s+(year|month|week)\b/gi
  while ((m = singularRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (claim(start, end)) out.push({ value: "1", unit: m[1]!.toLowerCase() as PeriodUnit, start, end })
  }

  return out
}

/** The best role-'date' column reachable from `startTable` (nearest first) — the finer periods
 *  (month/week/day/quarter/ytd) need a real date, never an integer year column. */
function nearestDateColumn(catalog: Catalog, startTable: string): { key: string; label: string } | undefined {
  const dist = tableDistances(catalog, startTable)
  let best: { key: string; label: string; d: number } | undefined
  for (const t of catalog.tables) {
    if (t.hidden) continue
    const d = dist.get(t.name)
    if (d === undefined) continue
    for (const c of t.columns) {
      if (c.role !== "date") continue
      if (!best || d < best.d) best = { key: c.key, label: c.label, d }
    }
  }
  return best ? { key: best.key, label: best.label } : undefined
}

function periodDisplay(value: string, unit: PeriodUnit): string {
  if (unit === "ytd") return "year to date"
  const n = Number(value)
  return `last ${value} ${n === 1 ? unit : `${unit}s`}`
}

// ─────────────────────────────── v0.2: thresholds (comparator + number) ───────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Word phrases get `\b` boundaries (and collapse internal spacing to `\s+`); symbols (">", "<=")
 *  don't, since `\b` doesn't apply cleanly around non-word characters. */
function comparatorPattern(phrase: string): string {
  const esc = escapeRegExp(phrase).replace(/ /g, "\\s+")
  return /[a-z]/i.test(phrase) ? `\\b${esc}\\b` : esc
}

const MAG_ALT = "million|billion|trillion|thousand|mn|bn|m|b|k"
const NUMBER_WORD_ALT = Object.keys(NUMBER_WORDS).join("|")
/** number (digits w/ commas & decimals, or a word number) + optional magnitude word + optional
 *  %/percent (left as-is — see parseQuantity). Exactly 3 capture groups. */
const QTY_SRC = `(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|${NUMBER_WORD_ALT})(?:\\s*(${MAG_ALT})\\b)?(?:\\s*(%|percent)\\b)?`

function parseQuantity(raw: string, magRaw: string | undefined): number {
  const word = NUMBER_WORDS[raw.toLowerCase()]
  let n = word !== undefined ? Number(word) : Number(raw.replace(/,/g, ""))
  if (magRaw) {
    const mag = magRaw.toLowerCase()
    const mult = mag === "k" || mag === "thousand" ? 1e3 : mag === "m" || mag === "mn" || mag === "million" ? 1e6 : mag === "b" || mag === "bn" || mag === "billion" ? 1e9 : mag === "trillion" ? 1e12 : 1
    n *= mult
  }
  return n
}

const COMPARATOR_GROUPS: { op: Exclude<ThresholdOp, "between">; phrases: string[] }[] = [
  // gte/lte FIRST: "no less than"/"no more than" contain "less than"/"more than" as substrings —
  // claiming their chars here first stops the gt/lt scan below from re-matching the inner phrase.
  { op: "gte", phrases: ["at least", "no less than", "minimum of", ">="] },
  { op: "lte", phrases: ["at most", "no more than", "up to", "maximum of", "<="] },
  { op: "gt", phrases: ["more than", "greater than", "higher than", "bigger than", "longer than", "exceeding", "over", "above", ">"] },
  { op: "lt", phrases: ["less than", "fewer than", "lower than", "smaller than", "shorter than", "under", "below", "<"] },
  { op: "eq", phrases: ["exactly", "equal to"] },
]

/** A comparator word/phrase immediately followed by a quantity ("over 100 million", "at least 5"),
 *  "between N and M" for non-year numbers (year-shaped "between"s are already claimed by
 *  findYearRanges before this runs), and the reversed "N or more"/"N or less"/"N or fewer". "top
 *  10" (no comparator) and "over the years" (no number right after) never match, by construction. */
function findThresholds(question: string, charUsed: boolean[]): { op: ThresholdOp; values: number[]; start: number; end: number }[] {
  const out: { op: ThresholdOp; values: number[]; start: number; end: number }[] = []
  const claim = (start: number, end: number) => {
    if (charUsed.slice(start, end).some(Boolean)) return false
    for (let i = start; i < end; i++) charUsed[i] = true
    return true
  }
  let m: RegExpExecArray | null

  const betweenRe = new RegExp(`\\bbetween\\s+${QTY_SRC}\\s+and\\s+${QTY_SRC}\\b`, "gi")
  while ((m = betweenRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    out.push({ op: "between", values: [parseQuantity(m[1]!, m[2]), parseQuantity(m[4]!, m[5])], start, end })
  }

  for (const group of COMPARATOR_GROUPS) {
    for (const phrase of group.phrases) {
      const re = new RegExp(`${comparatorPattern(phrase)}\\s*${QTY_SRC}`, "gi")
      while ((m = re.exec(question))) {
        const start = m.index
        const end = start + m[0].length
        if (!claim(start, end)) continue
        out.push({ op: group.op, values: [parseQuantity(m[1]!, m[2])], start, end })
      }
    }
  }

  const orMoreRe = new RegExp(`${QTY_SRC}\\s+or\\s+more\\b`, "gi")
  while ((m = orMoreRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    out.push({ op: "gte", values: [parseQuantity(m[1]!, m[2])], start, end })
  }
  const orLessRe = new RegExp(`${QTY_SRC}\\s+or\\s+(?:less|fewer)\\b`, "gi")
  while ((m = orLessRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    out.push({ op: "lte", values: [parseQuantity(m[1]!, m[2])], start, end })
  }

  return out
}

const OP_SYMBOL: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" }

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)
}
function formatMagnitude(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${trimNum(n / 1e9)}B`
  if (abs >= 1e6) return `${trimNum(n / 1e6)}M`
  if (abs >= 1e3) return `${trimNum(n / 1e3)}K`
  return trimNum(n)
}
function thresholdDisplay(op: ThresholdOp, values: number[]): string {
  if (op === "between") return `${formatMagnitude(values[0]!)}–${formatMagnitude(values[1]!)}`
  return `${OP_SYMBOL[op] ?? op} ${formatMagnitude(values[0]!)}`
}

// ─────────────────────────────── v0.2: text fragments ───────────────────────────────

const FRAGMENT_STOPWORDS = ["and", "or", "but", "who", "which", "that", "in", "on", "at", "by", "for", "the", "a", "an", "with", "of", "to", "from", "since", "until", "before", "after", "its", "their", "his", "her", "whose", "this"]
const FRAGMENT_STOP_ALT = FRAGMENT_STOPWORDS.join("|")

/** X in "contains X" / "starting with X" / etc: a quoted phrase, or up to 4 words stopping at the
 *  next stopword/preposition/punctuation/end. `minLen` lets starts/ends accept a single letter
 *  ("Venues starting with M") while the looser "contains X" trigger keeps a 2-char floor. */
function captureFragment(question: string, startIdx: number, minLen: number): { text: string; end: number } | undefined {
  const rest = question.slice(startIdx)
  const qm = /^\s*(['"])([^'"]{1,60})\1/.exec(rest)
  if (qm && qm[2]!.trim().length >= minLen) return { text: qm[2]!.trim(), end: startIdx + qm[0].length }

  const re = new RegExp(`^\\s*([a-zA-Z0-9']+(?:\\s+[a-zA-Z0-9']+){0,3}?)(?=\\s+(?:${FRAGMENT_STOP_ALT})\\b|[.,;!?]|$)`, "i")
  const wm = re.exec(rest)
  if (!wm) return undefined
  const text = wm[1]!.trim()
  if (text.length < minLen) return undefined
  if (new RegExp(`^(?:${FRAGMENT_STOP_ALT})$`, "i").test(text)) return undefined
  return { text, end: startIdx + wm[0].length }
}

/** Quoted text ('x'/"x") -> contains (skipped if the value index already claimed that span); "with
 *  X in the/its/their <word>" and "contain(s|ing) X" -> contains; "starting|beginning with X" /
 *  "that start(s) with X" -> starts; "ending with X" / "that end(s) with X" -> ends. */
function findTextFragments(question: string, charUsed: boolean[]): { mode: TextCandidate["mode"]; value: string; start: number; end: number }[] {
  const out: { mode: TextCandidate["mode"]; value: string; start: number; end: number }[] = []
  const claim = (start: number, end: number) => {
    if (charUsed.slice(start, end).some(Boolean)) return false
    for (let i = start; i < end; i++) charUsed[i] = true
    return true
  }
  let m: RegExpExecArray | null

  const startsRe = /\b(?:starting|beginning)\s+with\s+|\bthat\s+starts?\s+with\s+/gi
  while ((m = startsRe.exec(question))) {
    const triggerEnd = m.index + m[0].length
    const frag = captureFragment(question, triggerEnd, 1)
    if (!frag) continue
    if (!claim(m.index, frag.end)) continue
    out.push({ mode: "starts", value: frag.text, start: m.index, end: frag.end })
  }

  const endsRe = /\bending\s+with\s+|\bthat\s+ends?\s+with\s+/gi
  while ((m = endsRe.exec(question))) {
    const triggerEnd = m.index + m[0].length
    const frag = captureFragment(question, triggerEnd, 1)
    if (!frag) continue
    if (!claim(m.index, frag.end)) continue
    out.push({ mode: "ends", value: frag.text, start: m.index, end: frag.end })
  }

  const containsRe = /\bcontain(?:s|ing)?\s+/gi
  while ((m = containsRe.exec(question))) {
    const triggerEnd = m.index + m[0].length
    const frag = captureFragment(question, triggerEnd, 2)
    if (!frag) continue
    if (!claim(m.index, frag.end)) continue
    out.push({ mode: "contains", value: frag.text, start: m.index, end: frag.end })
  }

  const withInRe = /\bwith\s+(['"][^'"]{2,60}['"]|[a-zA-Z0-9']+(?:\s+[a-zA-Z0-9']+){0,3}?)\s+in\s+(?:the|its|their)\s+\w+\b/gi
  while ((m = withInRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    const qm = /^['"](.+)['"]$/.exec(m[1]!)
    const val = (qm ? qm[1]! : m[1]!).trim()
    if (val.length < 2) continue
    if (!claim(start, end)) continue
    out.push({ mode: "contains", value: val, start, end })
  }

  const quotedRe = /'([^']{2,60})'|"([^"]{2,60})"/g
  while ((m = quotedRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue // already used by the value index or an earlier v0.2 candidate
    out.push({ mode: "contains", value: (m[1] ?? m[2])!, start, end })
  }

  return out
}

// ─────────────────────────────── v0.2: rank windows ───────────────────────────────

/** "ranked N to M", "ranks N-M", "positions N to M", "Nth to Mth" -> that window directly; "the
 *  next N" -> from 11 to 10+N, or K+1 to K+N after a stated "top K". */
function findRankWindows(question: string, charUsed: boolean[]): { from: number; to: number; start: number; end: number }[] {
  const out: { from: number; to: number; start: number; end: number }[] = []
  const claim = (start: number, end: number) => {
    if (charUsed.slice(start, end).some(Boolean)) return false
    for (let i = start; i < end; i++) charUsed[i] = true
    return true
  }
  let m: RegExpExecArray | null

  const rankRe = /\b(?:ranked|ranks|positions?)\s+(\d+)\s*(?:-|–|—|to)\s*(\d+)\b/gi
  while ((m = rankRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    out.push({ from: Number(m[1]), to: Number(m[2]), start, end })
  }

  const ordinalRe = /\b(\d+)(?:st|nd|rd|th)\s+to\s+(\d+)(?:st|nd|rd|th)\b/gi
  while ((m = ordinalRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    out.push({ from: Number(m[1]), to: Number(m[2]), start, end })
  }

  const topMatch = /\btop\s+(\d+)\b/i.exec(question)
  const nextRe = /\bthe\s+next\s+(\d+)\b/gi
  while ((m = nextRe.exec(question))) {
    const start = m.index
    const end = start + m[0].length
    if (!claim(start, end)) continue
    const n = Number(m[1])
    const k = topMatch ? Number(topMatch[1]) : 10
    out.push({ from: k + 1, to: k + n, start, end })
  }

  return out.slice(0, 2)
}

// ─────────────────────────────── v0.2: or-pairs ───────────────────────────────

/** Two kind-"value" candidates on DIFFERENT columns whose matched spans are joined by "or" with at
 *  most 3 other words between them ("physics laureates or women"). Same-column pairs already merge
 *  into one IN list (see filters.ts's buildFilters) and are not this. */
function findOrPairs(question: string, filters: FilterCandidate[]): OrPair[] {
  const values = filters.filter((f) => f.kind === "value")
  const lower = question.toLowerCase()
  const spanOf = (f: FilterCandidate) => {
    const idx = lower.indexOf(f.matched.toLowerCase())
    return idx === -1 ? undefined : { start: idx, end: idx + f.matched.length }
  }
  const pairs: OrPair[] = []
  for (const a of values) {
    const sa = spanOf(a)
    if (!sa) continue
    for (const b of values) {
      if (a === b || a.column === b.column) continue
      const sb = spanOf(b)
      if (!sb || sb.start <= sa.start) continue
      const between = question.slice(sa.end, sb.start)
      const words = between.trim().length ? between.trim().split(/\s+/) : []
      if (!words.some((w) => w.toLowerCase() === "or")) continue
      const extra = words.filter((w) => w.toLowerCase() !== "or")
      if (extra.length > 3) continue
      pairs.push({ id: `o${pairs.length}`, a: a.id, b: b.id })
    }
  }
  return pairs.slice(0, MAX_V02_CANDIDATES)
}

function findNumberWords(question: string): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = []
  const re = /\ba dozen\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(question))) out.push({ value: "12", start: m.index, end: m.index + m[0].length })
  const wordRe = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi")
  while ((m = wordRe.exec(question))) {
    const w = m[1]!.toLowerCase()
    out.push({ value: NUMBER_WORDS[w]!, start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * Finds filter candidates (values + years + v0.2 ranges/periods/now) and standalone numbers in
 * `question`, plus the v0.2 thresholds/texts/orPairs/rankWindows. Longest non-overlapping spans
 * win; matched character ranges cannot be reused by a shorter span or by a later detector — see
 * each find* helper's own comment for exactly what it claims.
 */
export function findCandidates(question: string, catalog: Catalog): Candidates {
  const index = buildValueIndex(catalog)
  const distances = tableDistances(catalog, catalog.defaultFact ?? catalog.tables.find((t) => !t.hidden)?.name ?? "")
  const displayColumns = new Set(catalog.tables.filter((t) => t.display).map((t) => `${t.name}.${t.display}`))
  const tokens = tokenize(question)
  const used = new Array<boolean>(tokens.length).fill(false)

  type Span = { start: number; end: number; len: number; entry: IndexEntry }
  const spans: Span[] = []

  for (let len = Math.min(MAX_SPAN, tokens.length); len >= 1; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      const end = start + len
      if (used.slice(start, end).some(Boolean)) continue
      const text = tokens.slice(start, end).join(" ")
      let entries = index.byText.get(text)
      if (!entries && len === 1) {
        // light fuzzy: edit distance 1, or a naive plural/singular match
        const word = text
        const sing = singularize(word)
        for (const ft of index.fuzzyTokens) {
          if (ft.norm === sing || ft.norm === word) {
            entries = ft.entries
            break
          }
          if (Math.abs(ft.norm.length - word.length) <= 1 && editDistance(ft.norm, word, 1) <= 1) {
            entries = ft.entries
            break
          }
        }
      }
      if (!entries || entries.length === 0) continue
      const isAliasOnly = entries.every((e) => e.isAlias)
      if ((isStopword(text) || text.length <= 2) && !isAliasOnly) continue
      const entry = pickBest(entries, distances, displayColumns)
      spans.push({ start, end, len, entry })
      for (let i = start; i < end; i++) used[i] = true
    }
  }

  // Map token spans back onto character offsets in the original question for the "matched" text
  // and to keep years/numbers from double-counting a span already claimed as a value.
  const charUsed = new Array<boolean>(question.length).fill(false)
  const lower = question.toLowerCase()
  const matchedText: string[] = []
  for (const s of spans) {
    const spanWords = tokens.slice(s.start, s.end)
    // best-effort locate: search for the first token's normalized text occurrence, then extend
    const first = spanWords[0]!
    let at = -1
    for (let searchFrom = 0; ; ) {
      const idx = lower.indexOf(first, searchFrom)
      if (idx === -1) break
      if (!charUsed[idx]) {
        at = idx
        break
      }
      searchFrom = idx + 1 // this occurrence is already claimed by an earlier (longer) span — try the next one
    }
    if (at === -1) {
      matchedText.push(spanWords.join(" "))
      continue
    }
    // Extend forward through the original text covering `len` words (best-effort width).
    let end = at + first.length
    let wordsLeft = spanWords.length - 1
    while (wordsLeft > 0 && end < question.length) {
      const rest = question.slice(end)
      const wm = /^[^a-zA-Z0-9]*([a-zA-Z0-9']+)/.exec(rest)
      if (!wm) break
      end += wm[0].length
      wordsLeft--
    }
    for (let i = at; i < end && i < charUsed.length; i++) charUsed[i] = true
    matchedText.push(question.slice(at, end))
  }

  const filters: FilterCandidate[] = []
  let fid = 0
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!
    const roles = fkRoleGroupFor(catalog, s.entry.column.split(".")[0]!)
    filters.push({
      id: `f${fid++}`,
      kind: "value",
      column: s.entry.column,
      field: fieldLabel(catalog, s.entry.column),
      value: s.entry.value,
      display: s.entry.display,
      matched: matchedText[i]!,
      ...(roles && roles.length ? { roles } : {}),
    })
  }

  // v0.2: year ranges BEFORE plain years, so "between 1990 and 2010" becomes one range candidate,
  // not two contradictory year candidates (findYears below skips its now-claimed digits).
  const timeCol = nearestTimeColumn(catalog, catalog.defaultFact ?? "")
  const ranges = findYearRanges(question, charUsed)
  for (const r of ranges) {
    filters.push({
      id: `f${fid++}`,
      kind: "range",
      column: timeCol?.key ?? "",
      field: "Year",
      value: r.value,
      value2: r.value2,
      display: `${r.value}–${r.value2}`,
      matched: question.slice(r.start, r.end),
    })
  }

  const years = findYears(question, charUsed)
  for (const y of years) {
    filters.push({
      id: `f${fid++}`,
      kind: "year",
      column: timeCol?.key ?? "",
      field: "Year",
      value: y.value,
      display: y.value,
      matched: y.value,
    })
    for (let i = y.start; i < y.end; i++) charUsed[i] = true
  }

  // v0.2: relative periods, before "now" so ytd's "this year" (inside "so far this year") is
  // already claimed and doesn't also get read as a bare "this year" -> kind "now".
  const periods = findRelativePeriods(question, charUsed)
  for (const p of periods) {
    if (p.unit === "year") {
      if (!timeCol) continue
      filters.push({
        id: `f${fid++}`,
        kind: "period",
        column: timeCol.key,
        field: "Year",
        value: p.value,
        unit: "year",
        display: periodDisplay(p.value, "year"),
        matched: question.slice(p.start, p.end),
      })
      continue
    }
    const dateCol = nearestDateColumn(catalog, catalog.defaultFact ?? "")
    if (!dateCol) continue // no reachable date column for a finer-than-year period — skip
    filters.push({
      id: `f${fid++}`,
      kind: "period",
      column: dateCol.key,
      field: dateCol.label,
      value: p.value,
      unit: p.unit,
      display: periodDisplay(p.value, p.unit),
      matched: question.slice(p.start, p.end),
    })
  }

  // At most one relative-time marker per question — "now" and "today" both appearing would only
  // ever mean the same single "latest year", never two different filters.
  const nowMatch = findRelativeNow(question, charUsed)[0]
  if (nowMatch) {
    filters.push({
      id: `f${fid}`,
      kind: "now",
      column: timeCol?.key ?? "",
      field: "Year",
      value: "latest",
      display: "latest year",
      matched: nowMatch.value,
    })
    for (let i = nowMatch.start; i < nowMatch.end; i++) charUsed[i] = true
    fid++
  }

  // v0.2: rank windows before thresholds/numbers, so "ranked 11 to 20"/"the next 10" never also
  // shows up as a plain limit number.
  const rankWindowsFound = findRankWindows(question, charUsed)
  const rankWindows: RankWindowCandidate[] = rankWindowsFound.map((w, i) => ({ id: `w${i}`, from: w.from, to: w.to, matched: question.slice(w.start, w.end) }))

  // v0.2: thresholds before the plain numbers/word-numbers scan, so a comparator's own number
  // ("over 100 million") is never also offered as a limit candidate.
  const thresholdsFound = findThresholds(question, charUsed).slice(0, MAX_V02_CANDIDATES)
  const thresholds: ThresholdCandidate[] = thresholdsFound.map((t, i) => ({
    id: `t${i}`,
    op: t.op,
    values: t.values,
    matched: question.slice(t.start, t.end),
    display: thresholdDisplay(t.op, t.values),
  }))

  // v0.2: text fragments (quoted spans not already claimed as a value, contains/starts/ends).
  const textsFound = findTextFragments(question, charUsed).slice(0, MAX_V02_CANDIDATES)
  const texts: TextCandidate[] = textsFound.map((t, i) => ({ id: `x${i}`, mode: t.mode, value: t.value, matched: question.slice(t.start, t.end) }))

  const numberWords = findNumberWords(question)
  const digitNumbers: string[] = []
  const digitRe = /\b\d{1,4}\b/g
  let m: RegExpExecArray | null
  while ((m = digitRe.exec(question))) {
    if (charUsed.slice(m.index, m.index + m[0].length).some(Boolean)) continue
    digitNumbers.push(m[0])
  }
  const numbers = [...new Set([...digitNumbers, ...numberWords.filter((n) => !charUsed.slice(n.start, n.end).some(Boolean)).map((n) => n.value)])]

  // v0.2: or-pairs, from the completed value-kind filters.
  const orPairs = findOrPairs(question, filters)

  return {
    filters: filters.slice(0, MAX_FILTERS),
    numbers: numbers.slice(0, 8),
    thresholds,
    texts,
    orPairs,
    rankWindows,
    cues: findCues(question),
  }
}

function fieldLabel(catalog: Catalog, columnKey: string): string {
  const table = columnKey.split(".")[0]!
  const t = catalog.tables.find((x) => x.name === table)
  const col = t?.columns.find((c) => c.key === columnKey)
  return col?.label ?? columnKey
}

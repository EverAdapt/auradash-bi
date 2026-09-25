/**
 * OWNER: planner. Text normalization shared by candidates.ts (value/year/number matching) and
 * offline.ts (keyword overlap scoring). Pure string functions, no catalog knowledge.
 */

/** Lowercase, strip diacritics and punctuation (keep letters, digits, spaces, apostrophes-as-space). */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents after NFKD decomposition
    .toLowerCase()
    .replace(/['’]/g, "") // "d'ivoire" -> "divoire" like "Cote d'Ivoire" alias matching expects
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Whitespace-split tokens of already-normalized text. */
export function tokenize(s: string): string[] {
  const n = normalizeText(s)
  return n.length ? n.split(" ") : []
}

/** Naive singular of an English plural (dogs -> dog, categories -> category, boxes -> box). */
export function singularize(word: string): string {
  if (word.length <= 3) return word
  if (/ies$/.test(word)) return word.slice(0, -3) + "y"
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2)
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1)
  return word
}

/** Nouns whose plural is spelled the same as their singular — common enough in business data
 *  (a "staff" table, "series"/"data" columns) that the naive `+s`/`+es` rule below would mangle
 *  them ("staffs", "seriess") if this exception list weren't checked first. */
const INVARIANT_PLURALS = new Set(["staff", "fish", "sheep", "deer", "series", "species", "data", "equipment", "information", "moose", "aircraft"])

/** Naive English pluralization, good enough for catalog table/dimension labels (used by
 *  compile.ts's "Top N <plural>" titles, catalog table labels and suggestPrompts). */
export function pluralize(label: string): string {
  if (INVARIANT_PLURALS.has(label.toLowerCase())) return label
  if (/(s|x|z|ch|sh)$/i.test(label)) return `${label}es`
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`
  return `${label}s`
}

/** Levenshtein edit distance, capped early once it exceeds `max` (returns max+1 in that case). */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const m = a.length
  const n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "to",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "when",
  "where",
  "many",
  "much",
  "most",
  "least",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "with",
  "from",
  "as",
  "it",
  "its",
  "their",
  "per",
  "each",
  "top",
  "show",
  "me",
  "list",
  "than",
  "more",
  "less",
])

export function isStopword(s: string): boolean {
  return STOPWORDS.has(s)
}

// ─────────────────────────────── display-column labels ───────────────────────────────

/** Column names that just mean "this row's own display name" — "name", "title", .... A table's
 *  display column is very often one of these, which makes it a poor STANDALONE dimension label:
 *  every such table would read as "by name". Shared by buildAutoCatalog (picking the display
 *  column), request.ts (wording the group_by option Jev reads) and suggestPrompts (the starter
 *  prompt text), so all three agree on when to fall back to the table's own concept instead. */
const GENERIC_DISPLAY_NAMES = new Set(["name", "title", "label", "fullname", "displayname"])
export function isGenericDisplayName(name: string): boolean {
  return GENERIC_DISPLAY_NAMES.has(name.toLowerCase().replace(/[^a-z0-9]/g, ""))
}

export function capitalizeFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** Singularizes just the last word of a label, e.g. "Stores" -> "store", "Playlist tracks" -> "playlist track". */
export function singularizeLabel(label: string): string {
  const words = label.split(" ")
  words[words.length - 1] = singularize(words[words.length - 1]!.toLowerCase())
  return words.join(" ")
}

#!/usr/bin/env bun
/**
 * OWNER: implementer C (agnostic). Guards the v0.2 rule "no code path, regex or wording names a
 * bundled dataset, one of its tables or columns, or its nouns" (docs/PLAN-v0.2.md section 2).
 * Exits 1 and prints every hit when either check fails, 0 (silently, beyond a summary line) when
 * clean. The lead wires this into an npm script at merge; run directly with:
 *
 *   bun scripts/check-agnostic.ts
 *
 * Checks:
 *   1. shared/jev/questions*.ts: none of a fixed list of bundled-dataset nouns (laureate, nobel,
 *      countr[y/ies], gdp, club, afl, song, swift, album, population, premiership, fremantle,
 *      collingwood, curie), case-insensitive, outside comments — the wording Jev actually reads
 *      must stay generic whatever dataset is loaded.
 *   2. src/lib/plan/** and src/lib/catalog/**: no string literal (comments excluded) that is
 *      exactly a bundled dataset id or one of its table names — those belong in data/<id>.semantic
 *      .json, read generically through the Catalog the compiler is handed at runtime.
 *
 * Both checks tokenize each file into (a) source with every comment's body blanked out, for a
 * plain substring scan, and (b) the file's own string-literal contents, for an exact-match scan —
 * a hand-rolled scanner rather than a real parser, but enough for a fixed, small codebase like
 * this one's planner.
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { bundledDatasetIds } from "./datasets"

const ROOT = path.resolve(import.meta.dir, "..")

// ─────────────────────────────── a tiny comment/string scanner ───────────────────────────────

interface ScanResult {
  /** original text, but every comment's body replaced with spaces (line breaks kept) — safe to
   *  substring-search without ever matching inside a `//` or `/* *\/` comment. */
  codeNoComments: string
  /** every string/template literal's own content, comments excluded, with its start line. */
  strings: { value: string; line: number }[]
}

function scanSource(text: string): ScanResult {
  let out = ""
  const strings: { value: string; line: number }[] = []
  let i = 0
  let line = 1
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    const next = text[i + 1]

    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (ch === "/" && next === "*") {
      out += "  "
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") {
          out += "\n"
          line++
        } else out += " "
        i++
      }
      if (i < n) {
        out += "  "
        i += 2
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch
      const startLine = line
      let value = ""
      i++
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) {
          value += text[i]! + text[i + 1]
          if (text[i + 1] === "\n") line++
          i += 2
          continue
        }
        if (text[i] === "\n") line++
        value += text[i]
        i++
      }
      i++ // closing quote (or EOF — malformed input, best-effort)
      strings.push({ value, line: startLine })
      out += quote + value + quote
      continue
    }
    if (ch === "\n") line++
    out += ch
    i++
  }
  return { codeNoComments: out, strings }
}

function lineOfIndex(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++
  return line
}

// ─────────────────────────────── file discovery ───────────────────────────────

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, exts))
    else if (exts.some((ext) => e.name.endsWith(ext))) out.push(full)
  }
  return out
}

// ─────────────────────────────── check 1: questions*.ts wording ───────────────────────────────

const BUNDLED_NOUNS = ["laureate", "nobel", "countr", "gdp", "club", "afl", "song", "swift", "album", "population", "premiership", "fremantle", "collingwood", "curie"]
const NOUN_RE = new RegExp(`\\b(${BUNDLED_NOUNS.join("|")})`, "gi")

interface Hit {
  file: string
  line: number
  detail: string
}

function checkQuestionWording(): Hit[] {
  const dir = path.join(ROOT, "shared", "jev")
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("questions") && f.endsWith(".ts"))
    .map((f) => path.join(dir, f))
  const hits: Hit[] = []
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const { codeNoComments } = scanSource(text)
    let m: RegExpExecArray | null
    NOUN_RE.lastIndex = 0
    while ((m = NOUN_RE.exec(codeNoComments))) {
      const line = lineOfIndex(codeNoComments, m.index)
      const snippet = codeNoComments.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, " ").trim()
      hits.push({ file: path.relative(ROOT, file), line, detail: `"${m[1]}" — …${snippet}…` })
    }
  }
  return hits
}

// ─────────────────────────────── check 2: no bundled id/table literal in plan/catalog code ───────────────────────────────

function bannedLiterals(): Set<string> {
  const ids = bundledDatasetIds(ROOT)
  const banned = new Set<string>(ids)
  for (const id of ids) {
    const sem = JSON.parse(readFileSync(path.join(ROOT, "data", `${id}.semantic.json`), "utf8")) as { tables: Record<string, unknown> }
    for (const table of Object.keys(sem.tables ?? {})) banned.add(table)
  }
  return banned
}

function checkPlanCatalogLiterals(): Hit[] {
  const banned = bannedLiterals()
  const files = [...walk(path.join(ROOT, "src", "lib", "plan"), [".ts", ".tsx"]), ...walk(path.join(ROOT, "src", "lib", "catalog"), [".ts", ".tsx"])]
  const hits: Hit[] = []
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const { strings } = scanSource(text)
    for (const s of strings) {
      const value = s.value.trim()
      if (banned.has(value)) hits.push({ file: path.relative(ROOT, file), line: s.line, detail: `string literal "${value}"` })
    }
  }
  return hits
}

// ─────────────────────────────── run ───────────────────────────────

const wordingHits = checkQuestionWording()
const literalHits = checkPlanCatalogLiterals()
const all = [...wordingHits, ...literalHits]

if (all.length === 0) {
  console.log("check-agnostic: OK — no bundled-dataset nouns in shared/jev/questions*.ts, no bundled id/table string literals in src/lib/plan|catalog/**")
  process.exit(0)
}

if (wordingHits.length) {
  console.log(`\nshared/jev/questions*.ts — bundled-dataset noun found (${wordingHits.length}):`)
  for (const h of wordingHits) console.log(`  ${h.file}:${h.line}  ${h.detail}`)
}
if (literalHits.length) {
  console.log(`\nsrc/lib/plan|catalog/** — bundled id/table string literal found (${literalHits.length}):`)
  for (const h of literalHits) console.log(`  ${h.file}:${h.line}  ${h.detail}`)
}
console.log(`\ncheck-agnostic: FAILED — ${all.length} hit(s)`)
process.exit(1)

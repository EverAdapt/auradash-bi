/**
 * OWNER: data-engine. Pure statement splitter + dump-dialect normalizer for `.sql` files and
 * pasted SQL text (importDataset). No DOM/React; runs in the DB worker and in bun scratch tests.
 *
 * Verified against SQLite 3.53 with docs/research/probes/dialect.mjs: MySQL's backtick
 * identifiers, `int(11)`, `INT UNSIGNED` and version comments (`/*!...*\/`) already work as-is in
 * SQLite (a comment-only statement becomes a harmless no-op) and Postgres's `serial`,
 * `character varying`, `timestamp with time zone` and `boolean DEFAULT true` do too, so this file
 * only rewrites or drops the constructs that are actually rejected: MySQL's `AUTO_INCREMENT`,
 * table options, `KEY`/`INDEX` lines, `ENUM`, `UNSIGNED`/`ZEROFILL`, `LOCK/UNLOCK TABLES`,
 * `SET ...`; Postgres's `public.` prefix, `::casts`, `nextval(...)` defaults, `CREATE SEQUENCE`,
 * `SET ...`, `pg_catalog` calls, `ALTER TABLE ... OWNER/ADD CONSTRAINT`, `E'...'` strings and
 * `COPY ... FROM stdin` blocks.
 */

export interface NormalizeResult {
  statements: string[]
  warnings: string[]
}

type CharClass = "code" | "squote" | "dquote" | "btick" | "line-comment" | "block-comment"

/**
 * One quote/comment-aware scan shared by the statement splitter and the escape fixer. Calls
 * `onChar(i, cls)` for every character with the class it belongs to (so callers can special-case
 * `squote` content) and `onBoundary(i)` right after a top-level (class `code`) semicolon.
 */
function scanSql(sql: string, onBoundary: (index: number) => void): void {
  let cls: CharClass = "code"
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    const next = sql[i + 1]
    if (cls === "line-comment") {
      if (c === "\n") cls = "code"
      continue
    }
    if (cls === "block-comment") {
      if (c === "*" && next === "/") {
        cls = "code"
        i++
      }
      continue
    }
    if (cls === "squote") {
      if (c === "\\" && next !== undefined) {
        i++ // backslash-escaped char (MySQL dumps); doesn't end the string
      } else if (c === "'") {
        if (next === "'") i++
        else cls = "code"
      }
      continue
    }
    if (cls === "dquote") {
      if (c === '"') {
        if (next === '"') i++
        else cls = "code"
      }
      continue
    }
    if (cls === "btick") {
      if (c === "`") cls = "code"
      continue
    }
    // cls === "code"
    if (c === "-" && next === "-") {
      cls = "line-comment"
    } else if (c === "/" && next === "*") {
      cls = "block-comment"
      i++
    } else if (c === "'") {
      cls = "squote"
    } else if (c === '"') {
      cls = "dquote"
    } else if (c === "`") {
      cls = "btick"
    } else if (c === ";") {
      onBoundary(i)
    }
  }
}

/** Splits SQL text on top-level `;` only (never inside a string, identifier or comment). */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let start = 0
  scanSql(sql, (i) => {
    out.push(sql.slice(start, i))
    start = i + 1
  })
  out.push(sql.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}

/** True once line/block comments are stripped — a statement that is only a comment is a no-op. */
function isBlankAfterComments(stmt: string): boolean {
  let out = ""
  let cls: CharClass = "code"
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i]
    const next = stmt[i + 1]
    if (cls === "line-comment") {
      if (c === "\n") cls = "code"
      continue
    }
    if (cls === "block-comment") {
      if (c === "*" && next === "/") {
        cls = "code"
        i++
      }
      continue
    }
    if (cls === "squote" || cls === "dquote" || cls === "btick") {
      out += c
      if ((cls === "squote" && c === "'") || (cls === "dquote" && c === '"') || (cls === "btick" && c === "`")) {
        if (next !== c) cls = "code"
      }
      continue
    }
    if (c === "-" && next === "-") {
      cls = "line-comment"
    } else if (c === "/" && next === "*") {
      cls = "block-comment"
      i++
    } else {
      if (c === "'") cls = "squote"
      else if (c === '"') cls = "dquote"
      else if (c === "`") cls = "btick"
      out += c
    }
  }
  return out.trim().length === 0
}

/** Finds the index of the `)` that matches the `(` at `openIndex` (quote-aware). */
function matchParen(sql: string, openIndex: number): number {
  let depth = 0
  let cls: CharClass = "code"
  for (let i = openIndex; i < sql.length; i++) {
    const c = sql[i]
    const next = sql[i + 1]
    if (cls === "squote") {
      if (c === "'") {
        if (next === "'") i++
        else cls = "code"
      }
      continue
    }
    if (cls === "dquote") {
      if (c === '"') {
        if (next === '"') i++
        else cls = "code"
      }
      continue
    }
    if (cls === "btick") {
      if (c === "`") cls = "code"
      continue
    }
    if (c === "'") {
      cls = "squote"
      continue
    }
    if (c === '"') {
      cls = "dquote"
      continue
    }
    if (c === "`") {
      cls = "btick"
      continue
    }
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Splits a CREATE TABLE column-list body on top-level commas (respecting parens/quotes). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cls: CharClass = "code"
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    const next = body[i + 1]
    if (cls === "squote") {
      if (c === "'") {
        if (next === "'") i++
        else cls = "code"
      }
      continue
    }
    if (cls === "dquote") {
      if (c === '"') {
        if (next === '"') i++
        else cls = "code"
      }
      continue
    }
    if (cls === "btick") {
      if (c === "`") cls = "code"
      continue
    }
    if (c === "'") cls = "squote"
    else if (c === '"') cls = "dquote"
    else if (c === "`") cls = "btick"
    else if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

const DROP_PATTERNS: RegExp[] = [
  /^LOCK\s+TABLES\b/i,
  /^UNLOCK\s+TABLES\b/i,
  /^SET\s+/i,
  /^CREATE\s+SEQUENCE\b/i,
  /^SELECT\s+pg_catalog\./i,
  /^ALTER\s+TABLE\s+\S+(\s+\S+)?\s+OWNER\s+TO\b/i,
  /^DROP\s+SEQUENCE\b/i,
  /^COMMENT\s+ON\b/i,
  /^GRANT\b/i,
  /^REVOKE\b/i,
]

const KEY_LINE = /^\s*(KEY|INDEX|UNIQUE\s+KEY|FULLTEXT\s+KEY|SPATIAL\s+KEY)\b/i

/** MySQL `\'`/`\\` escapes inside single-quoted strings, rewritten to valid SQL (`''`, `\`). */
function fixBackslashEscapes(sql: string): string {
  let out = ""
  let cls: CharClass = "code"
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    const next = sql[i + 1]
    if (cls === "squote") {
      if (c === "\\" && next !== undefined) {
        if (next === "'") out += "''"
        else if (next === "\\") out += "\\"
        else if (next === "n") out += "\n"
        else if (next === "t") out += "\t"
        else if (next === "r") out += "\r"
        else if (next === "0") out += ""
        else out += next
        i++
        continue
      }
      out += c
      if (c === "'") {
        if (next === "'") {
          out += next
          i++
        } else cls = "code"
      }
      continue
    }
    if (cls === "dquote") {
      out += c
      if (c === '"' && next !== '"') cls = "code"
      else if (c === '"') {
        out += next
        i++
      }
      continue
    }
    if (cls === "btick") {
      out += c
      if (c === "`") cls = "code"
      continue
    }
    if (cls === "line-comment") {
      out += c
      if (c === "\n") cls = "code"
      continue
    }
    if (cls === "block-comment") {
      out += c
      if (c === "*" && next === "/") {
        out += next
        i++
        cls = "code"
      }
      continue
    }
    if (c === "-" && next === "-") {
      cls = "line-comment"
      out += c
      continue
    }
    if (c === "/" && next === "*") {
      cls = "block-comment"
      out += c
      continue
    }
    if (c === "'") cls = "squote"
    else if (c === '"') cls = "dquote"
    else if (c === "`") cls = "btick"
    out += c
  }
  return out
}

/** Postgres `E'...'` strings: unescape, then re-emit as a plain, validly-quoted `'...'`. */
function rewritePgEscapeStrings(sql: string): string {
  return sql.replace(/\bE'((?:[^'\\]|\\.)*)'/g, (_m, body: string) => {
    let unescaped = ""
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      if (c === "\\") {
        const n = body[++i]
        if (n === "n") unescaped += "\n"
        else if (n === "t") unescaped += "\t"
        else if (n === "r") unescaped += "\r"
        else if (n === "\\") unescaped += "\\"
        else if (n === "'") unescaped += "'"
        else unescaped += n ?? ""
      } else unescaped += c
    }
    return `'${unescaped.replace(/'/g, "''")}'`
  })
}

/** Converts a `COPY <table> (<cols>) FROM stdin;` block + its data lines into INSERT statements. */
function preprocessCopyBlocks(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = []
  const lines = text.split("\n")
  const out: string[] = []
  const copyStart = /^\s*COPY\s+([^\s(]+)\s*(\(([^)]*)\))?\s+FROM\s+stdin\s*;?\s*$/i
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(copyStart)
    if (!m) {
      out.push(lines[i])
      continue
    }
    const table = m[1].replace(/\bpublic\./i, "").replace(/^"|"$/g, "")
    const cols = m[3]
      ?.split(",")
      .map((c) => c.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
    let j = i + 1
    let rows = 0
    while (j < lines.length && lines[j].trim() !== "\\.") {
      const line = lines[j]
      const fields = line.split("\t").map((f) => (f === "\\N" ? null : f.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\\\/g, "\\")))
      const colList = cols?.length ? ` (${cols.map((c) => `"${c}"`).join(", ")})` : ""
      const values = fields.map((f) => (f === null ? "NULL" : `'${f.replace(/'/g, "''")}'`)).join(", ")
      out.push(`INSERT INTO "${table}"${colList} VALUES (${values});`)
      rows++
      j++
    }
    if (j >= lines.length) warnings.push(`COPY block for "${table}" had no terminating "\\." line; ${rows} rows imported anyway.`)
    i = j // skip past the "\." terminator (loop's i++ advances past it)
  }
  return { text: out.join("\n"), warnings }
}

/** Strips the MySQL table-option tail (`ENGINE=... DEFAULT CHARSET=...`) after `CREATE TABLE (...)`. */
function stripTableOptions(stmt: string): string {
  const open = stmt.indexOf("(")
  if (open < 0) return stmt
  const close = matchParen(stmt, open)
  if (close < 0) return stmt
  return stmt.slice(0, close + 1)
}

/** Rewrites one CREATE TABLE statement's column list: ENUM, AUTO_INCREMENT, UNSIGNED, KEY lines. */
function rewriteCreateTable(stmt: string): string {
  const s = stripTableOptions(stmt)
  const open = s.indexOf("(")
  const close = matchParen(s, open)
  if (open < 0 || close < 0) return s
  const head = s.slice(0, open + 1)
  const tail = s.slice(close)
  let body = s.slice(open + 1, close)

  body = body.replace(/\benum\s*\([^)]*\)/gi, "TEXT")
  body = body.replace(
    /\b(?:tiny|small|medium|big)?int\w*\s*(?:\(\d+\))?\s*(?:unsigned\s*)?(?:zerofill\s*)?(not\s+null\s*)?auto_increment/gi,
    (_m, notNull?: string) => `INTEGER ${notNull ? "NOT NULL " : ""}PRIMARY KEY`.trim(),
  )
  body = body.replace(/\bunsigned\b/gi, "").replace(/\bzerofill\b/gi, "")
  body = body.replace(/\bCOMMENT\s+'(?:[^'\\]|\\.)*'/gi, "")

  let parts = splitTopLevel(body).filter((p) => !KEY_LINE.test(p))
  // AUTO_INCREMENT above may have inlined "col INTEGER PRIMARY KEY"; if a table-level
  // `PRIMARY KEY (...)` constraint also survived, SQLite rejects the resulting duplicate PK —
  // keep only the first PRIMARY KEY declaration and drop any later ones.
  let sawPk = false
  parts = parts.filter((p) => {
    if (!/\bPRIMARY\s+KEY\b/i.test(p)) return true
    if (sawPk) return false
    sawPk = true
    return true
  })
  return `${head}${parts.join(", ")}${tail}`
}

export interface HoistedConstraint {
  table: string
  clause: string // e.g. "FOREIGN KEY (a) REFERENCES b (id)"
}

/** Parses a simple `ALTER TABLE [ONLY] t ADD CONSTRAINT name <PRIMARY KEY|FOREIGN KEY|UNIQUE> (...)`. */
function parseAlterAddConstraint(stmt: string): HoistedConstraint | null {
  const m = stmt.match(
    /^ALTER\s+TABLE\s+(?:ONLY\s+)?"?([\w.]+)"?\s+ADD\s+CONSTRAINT\s+"?[\w.]+"?\s+(PRIMARY\s+KEY\s*\([^)]*\)|UNIQUE\s*\([^)]*\)|FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+"?[\w.]+"?\s*\([^)]*\))/i,
  )
  if (!m) return null
  const table = m[1].replace(/^public\./i, "")
  const clause = m[2].replace(/\bpublic\./gi, "")
  return { table, clause }
}

/** Injects `clause` into the CREATE TABLE statement for `table`, if one is found in `statements`. */
function hoistIntoCreateTable(statements: string[], table: string, clause: string): boolean {
  const re = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?\\s*\\(`, "i")
  const idx = statements.findIndex((s) => re.test(s))
  if (idx < 0) return false
  const s = statements[idx]
  const open = s.indexOf("(")
  const close = matchParen(s, open)
  if (close < 0) return false
  statements[idx] = `${s.slice(0, close)}, ${clause}${s.slice(close)}`
  return true
}

/**
 * Splits and normalizes a `.sql` dump (MySQL or Postgres dialect) into statements SQLite can run.
 * Statement-by-statement execution (with continue-past-failure) happens in the caller (the DB
 * worker); this stays pure so it can also be exercised from bun scratch tests.
 */
export function normalizeDump(input: string): NormalizeResult {
  const warnings: string[] = []
  const { text, warnings: copyWarnings } = preprocessCopyBlocks(input)
  warnings.push(...copyWarnings)

  const raw = splitStatements(text)
  const pending: string[] = []
  const deferredConstraints: HoistedConstraint[] = []

  for (const original of raw) {
    if (isBlankAfterComments(original)) continue
    if (DROP_PATTERNS.some((re) => re.test(original))) continue

    const alter = parseAlterAddConstraint(original)
    if (alter) {
      deferredConstraints.push(alter)
      continue
    }
    if (/^ALTER\s+TABLE\b/i.test(original)) continue // other ALTERs SQLite/pg_dump emits: unsupported, skip

    let s = original
    s = fixBackslashEscapes(s)
    s = rewritePgEscapeStrings(s)
    s = s.replace(/\bpublic\./gi, "")
    s = s.replace(/::\s*"?[\w. ]+"?(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?/g, "")
    s = s.replace(/\bDEFAULT\s+nextval\([^)]*\)/gi, "")
    if (/^CREATE\s+TABLE\b/i.test(s)) s = rewriteCreateTable(s)
    pending.push(s)
  }

  for (const { table, clause } of deferredConstraints) {
    if (!hoistIntoCreateTable(pending, table, clause)) {
      warnings.push(`Dropped a constraint on "${table}" that could not be attached: ${clause}`)
    }
  }

  return { statements: pending.filter((s) => !isBlankAfterComments(s)), warnings }
}

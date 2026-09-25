/**
 * OWNER: platform. The strict policy applied to SQL a person typed themselves (the explorer SQL
 * console today; any future user-typed SQL entry point should reuse this). Pure string checking —
 * no DB access — so it can run before a query ever reaches the worker.
 *
 * Trusted, code-generated SQL (the planner's compiled queries, the explorer's row/sort/filter
 * queries, catalog introspection's `PRAGMA table_xinfo`/`PRAGMA foreign_key_list`) never goes
 * through this: it keeps calling `query()` in ./index.ts. This policy exists for exactly the
 * SQL a human typed and might type maliciously or by mistake.
 */

export const MAX_USER_SQL_LENGTH = 20_000

const ALLOWED_LEADING_KEYWORDS = ["SELECT", "WITH", "VALUES", "EXPLAIN"] as const

/** Statements that write, change schema, change connection state, or reach outside the DB file. */
const BANNED_KEYWORDS = [
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "CREATE",
  "DROP",
  "ALTER",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "UPSERT",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "load_extension",
] as const

export interface SqlPolicyResult {
  ok: boolean
  /** Friendly, user-facing reason when ok is false. */
  reason?: string
}

/**
 * Strips string literals ('...', "...", `...`), bracket/backtick identifiers, blob literals
 * (x'...'), and comments (-- ... / * ... * /) from SQL text, replacing each with spaces of the
 * same length so keyword positions and statement-splitting (semicolons) elsewhere stay aligned.
 * This is a lexer, not a parser — good enough to keep banned keywords and stray semicolons that
 * are genuinely inside a literal or a comment from tripping the policy, without trying to
 * validate that the SQL is otherwise well-formed (SQLite's own parser does that).
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = ""
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = sql[i + 1]

    if (c === "-" && c2 === "-") {
      const end = sql.indexOf("\n", i)
      const stop = end === -1 ? n : end
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    if (c === "/" && c2 === "*") {
      const end = sql.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2 // escaped quote ('' inside a '...' literal, or "" / `` in an identifier)
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += " ".repeat(j - i)
      i = j
      continue
    }
    if (c === "[") {
      const end = sql.indexOf("]", i + 1)
      const stop = end === -1 ? n : end + 1
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    // Blob literal: x'...' or X'...'
    if ((c === "x" || c === "X") && c2 === "'") {
      let j = i + 2
      while (j < n && sql[j] !== "'") j++
      const stop = Math.min(j + 1, n)
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    out += c
    i++
  }
  return out
}

/** Splits on top-level `;` in already-stripped SQL, dropping empty/whitespace-only segments. */
function countStatements(stripped: string): number {
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length
}

/**
 * Checks SQL a person typed against the strict read-only policy: max length, exactly one
 * statement, must start with an allowed keyword, and none of the banned keywords appear outside
 * string literals/identifiers/comments. Does not check that the SQL is syntactically valid or
 * that it only touches tables that exist — SQLite itself reports those errors.
 */
export function checkUserSql(sql: string): SqlPolicyResult {
  if (sql.length > MAX_USER_SQL_LENGTH) {
    return { ok: false, reason: `That query is too long (max ${MAX_USER_SQL_LENGTH.toLocaleString()} characters).` }
  }

  const trimmed = sql.trim()
  if (trimmed.length === 0) return { ok: false, reason: "Empty query." }

  const stripped = stripLiteralsAndComments(sql)
  const strippedTrimmed = stripped.trim()

  const statementCount = countStatements(stripped)
  if (statementCount === 0) return { ok: false, reason: "Empty query." }
  if (statementCount > 1) return { ok: false, reason: "Only one SQL statement is allowed here." }

  const leadingWord = strippedTrimmed.match(/^[a-zA-Z]+/)?.[0]?.toUpperCase()
  if (!leadingWord || !(ALLOWED_LEADING_KEYWORDS as readonly string[]).includes(leadingWord)) {
    return { ok: false, reason: "Only SELECT, WITH, VALUES or EXPLAIN statements are allowed here." }
  }

  for (const kw of BANNED_KEYWORDS) {
    const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${kw}([^a-zA-Z0-9_]|$)`, "i")
    if (pattern.test(stripped)) {
      return { ok: false, reason: `"${kw}" is not allowed here — this console is read-only.` }
    }
  }

  return { ok: true }
}

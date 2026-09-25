/**
 * OWNER: ask-board (wave 4, UI workstream). Turns a parameterised query (`sql` + bound `?`
 * params) into SQL a person can read, copy and paste straight back into the console: every `?`
 * outside a string literal gets its bound value inlined, then the whole thing is pretty-printed.
 * The planner may already hand us this as `CompiledQuery.displaySql` — `displaySqlFor` prefers
 * that verbatim (per the contract, it must run unchanged) and only falls back to inlining locally
 * when it's absent, e.g. for a `Pin` (whose contract has no `displaySql` field) or in a worktree
 * where the planner hasn't wired it up yet.
 */
import { format } from "sql-formatter"
import type { Cell } from "@shared/contract"

/** One bound value rendered as a SQL literal: numbers as-is, strings single-quoted ('' escaped). */
function literal(value: Cell): string {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Walks `sql` once, tracking whether we're inside a `'...'` or `"..."` literal (SQL escapes a
 * quote by doubling it, which this loop naturally treats as "closed then immediately reopened" —
 * harmless, since either reading still keeps `?` inside the literal from being touched) so a `?`
 * that happens to appear inside a string is never mistaken for a placeholder.
 */
export function inlineParams(sql: string, params: readonly Cell[]): string {
  let out = ""
  let inSingle = false
  let inDouble = false
  let i = 0
  for (let idx = 0; idx < sql.length; idx++) {
    const ch = sql[idx]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      out += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      out += ch
      continue
    }
    if (ch === "?" && !inSingle && !inDouble) {
      out += literal(params[i])
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/** Count of `?` placeholders outside string literals — used to spot an unbound query before running it. */
export function countPlaceholders(sql: string): number {
  let count = 0
  let inSingle = false
  let inDouble = false
  for (let idx = 0; idx < sql.length; idx++) {
    const ch = sql[idx]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "?" && !inSingle && !inDouble) count += 1
  }
  return count
}

/** Pretty-prints SQL for display; never throws — falls back to the untouched input. */
export function formatSql(sql: string): string {
  try {
    return format(sql, { language: "sqlite", keywordCase: "upper" })
  } catch {
    return sql
  }
}

/**
 * The SQL to show a person: `displaySql` verbatim when the planner already computed it (it's
 * pre-formatted and must run unchanged), otherwise `sql` with `params` inlined and formatted here.
 */
export function displaySqlFor(sql: string, params: readonly Cell[], displaySql?: string): string {
  if (displaySql && displaySql.trim()) return displaySql
  return formatSql(inlineParams(sql, params))
}

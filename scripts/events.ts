/**
 * OWNER: platform. Short report over the public demo's anonymous interaction history (D1 database
 * `auradash-events`, table `events` — see migrations/0001_events.sql, worker/events.ts).
 *
 * Usage: `bun scripts/events.ts [--days 7]`
 *
 * Prints: questions per day, top questions, out-of-scope / empty-result rates, thumbs-down answers
 * with their questions, and the most-pinned questions. Reads with:
 *   wrangler d1 execute auradash-events --remote --env demo --json --command "<sql>"
 * (one process per query — this is a small, occasional report, not a hot path).
 */
import { execFileSync } from "node:child_process"

interface D1QueryResult {
  results?: Record<string, unknown>[]
  success?: boolean
  error?: string
}

function parseArgs(argv: string[]): { days: number } {
  const i = argv.indexOf("--days")
  const days = i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : 7
  return { days: Number.isFinite(days) && days > 0 ? days : 7 }
}

function run(sql: string): Record<string, unknown>[] {
  const raw = execFileSync("bunx", ["wrangler", "d1", "execute", "auradash-events", "--remote", "--env", "demo", "--json", "--command", sql], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  })
  // `wrangler d1 execute --json` prints one result object per statement, wrapped in an array;
  // some wrangler versions also print non-JSON progress lines to stdout before the JSON — take
  // only the last JSON value on the output.
  const jsonStart = raw.lastIndexOf("[")
  const jsonText = jsonStart === -1 ? raw : raw.slice(jsonStart)
  const parsed = JSON.parse(jsonText) as D1QueryResult[]
  const first = parsed[0]
  if (first?.success === false) throw new Error(first.error ?? "query failed")
  return first?.results ?? []
}

function fmtTable(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return "  (no data yet)"
  return rows.map((r) => `  ${columns.map((c) => String(r[c] ?? "")).join("  |  ")}`).join("\n")
}

function main(): void {
  const { days } = parseArgs(process.argv.slice(2))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  console.log(`auradash-events report — last ${days} day${days === 1 ? "" : "s"} (since ${since})\n`)

  const perDay = run(`SELECT substr(ts,1,10) AS day, COUNT(*) AS questions FROM events WHERE type='plan' AND ts >= '${since}' GROUP BY day ORDER BY day`)
  console.log("Questions per day:")
  console.log(fmtTable(perDay, ["day", "questions"]))

  const topQuestions = run(
    `SELECT question, COUNT(*) AS asked FROM events WHERE type='plan' AND ts >= '${since}' AND question IS NOT NULL GROUP BY question ORDER BY asked DESC LIMIT 10`,
  )
  console.log("\nTop questions:")
  console.log(fmtTable(topQuestions, ["asked", "question"]))

  const scope = run(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN CAST(json_extract(data,'$.inScope') AS REAL) < 0.5 THEN 1 ELSE 0 END) AS out_of_scope
     FROM events WHERE type='plan' AND ts >= '${since}'`,
  )
  const totalPlans = Number(scope[0]?.total ?? 0)
  const outOfScope = Number(scope[0]?.out_of_scope ?? 0)
  console.log(
    `\nOut-of-scope rate: ${totalPlans > 0 ? `${((outOfScope / totalPlans) * 100).toFixed(1)}% (${outOfScope}/${totalPlans})` : "(no data yet)"}`,
  )

  const results = run(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN CAST(json_extract(data,'$.rows') AS INTEGER) = 0 THEN 1 ELSE 0 END) AS empty
     FROM events WHERE type='result' AND ts >= '${since}'`,
  )
  const totalResults = Number(results[0]?.total ?? 0)
  const emptyResults = Number(results[0]?.empty ?? 0)
  console.log(
    `Empty-result rate: ${totalResults > 0 ? `${((emptyResults / totalResults) * 100).toFixed(1)}% (${emptyResults}/${totalResults})` : "(no data yet)"}`,
  )

  const thumbsDown = run(
    `SELECT ts, dataset, question FROM events
     WHERE type='feedback' AND json_extract(data,'$.value')='down' AND ts >= '${since}'
     ORDER BY ts DESC LIMIT 20`,
  )
  console.log("\nThumbs-down answers:")
  console.log(fmtTable(thumbsDown, ["ts", "dataset", "question"]))

  const mostPinned = run(
    `SELECT question, COUNT(*) AS pins FROM events WHERE type='pin' AND ts >= '${since}' AND question IS NOT NULL GROUP BY question ORDER BY pins DESC LIMIT 10`,
  )
  console.log("\nMost pinned:")
  console.log(fmtTable(mostPinned, ["pins", "question"]))
}

main()

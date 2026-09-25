/**
 * OWNER: ask-board (wave 4, UI workstream). SQL console: the shared CodeMirror `SqlEditor`
 * (Ctrl/Cmd+Enter runs, autocomplete from this dataset's catalog), results in the shared virtual
 * grid, error + elapsed ms/rows, "Chart it" (profileResult/eligibleCharts/decideChart/encodeChart +
 * <ChartView>) and "Pin" (usePins.addPin). A query with unbound `?` placeholders (e.g. SQL copied
 * from the stage/pins before that carried real values) is refused with a friendly notice instead
 * of silently binding them to NULL and returning nothing.
 */
import { useMemo, useState } from "react"
import { BarChart3, Pin as PinIcon, Play } from "lucide-react"
import type { Cell, Catalog, CatalogTable, DatasetId, ResultSet } from "@shared/contract"
import { queryUserSql } from "@/lib/db"
import { decideChart, encodeChart, eligibleCharts, profileResult } from "@/lib/viz"
import { ChartView } from "@/components/charts"
import { LazySqlEditor } from "@/components/sql/LazySqlEditor"
import { countPlaceholders } from "@/components/sql/inline"
import { usePins } from "@/state/pins"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataGrid } from "@/components/explorer/DataGrid"

function firstLine(sql: string): string {
  const line = sql.trim().split("\n")[0] ?? ""
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

export function SqlConsoleTab({
  datasetId,
  catalog,
  table,
  initialSql,
}: {
  datasetId: DatasetId
  catalog: Catalog
  table: CatalogTable
  initialSql?: string
}) {
  const [sql, setSql] = useState(initialSql?.trim() || `SELECT * FROM "${table.name}" LIMIT 50`)
  const [result, setResult] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [placeholderCount, setPlaceholderCount] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [charting, setCharting] = useState(false)
  const [chart, setChart] = useState<{ spec: ReturnType<typeof encodeChart>; ranking: { type: string; p: number }[] } | null>(null)
  const [pinned, setPinned] = useState(false)

  const schema = useMemo(() => {
    const s: Record<string, string[]> = {}
    for (const t of catalog.tables) s[t.name] = t.columns.map((c) => c.name)
    return s
  }, [catalog])

  const run = async () => {
    const placeholders = countPlaceholders(sql)
    if (placeholders > 0) {
      setPlaceholderCount(placeholders)
      setError(null)
      return
    }
    setPlaceholderCount(null)
    setRunning(true)
    setError(null)
    setChart(null)
    setPinned(false)
    try {
      const res = await queryUserSql(datasetId, sql)
      setResult(res)
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : "Query failed.")
    } finally {
      setRunning(false)
    }
  }

  const chartIt = async () => {
    if (!result) return
    setCharting(true)
    try {
      const profile = profileResult(result)
      const eligible = eligibleCharts(profile)
      const decision = await decideChart({ question: firstLine(sql), datasetId, profile })
      const type = eligible.includes(decision.type) ? decision.type : (eligible[0] ?? "table")
      setChart({ spec: encodeChart(type, profile), ranking: decision.ranking })
    } catch {
      // offline/Jev failure: fall back to the first eligible type with no ranking
      const profile = profileResult(result)
      const type = eligibleCharts(profile)[0] ?? "table"
      setChart({ spec: encodeChart(type, profile), ranking: [{ type, p: 1 }] })
    } finally {
      setCharting(false)
    }
  }

  const pin = () => {
    if (!result) return
    const profile = profileResult(result)
    const spec = chart?.spec ?? encodeChart(eligibleCharts(profile)[0] ?? "table", profile)
    usePins.getState().addPin({
      datasetId,
      question: firstLine(sql),
      title: firstLine(sql),
      plan: null,
      sql,
      params: [],
      columns: [],
      chart: spec,
      chartRanking: chart?.ranking as { type: typeof spec.type; p: number }[] | undefined,
    })
    setPinned(true)
  }

  return (
    <div className="flex flex-col gap-3">
      <LazySqlEditor
        value={sql}
        onChange={(value) => {
          setSql(value)
          if (placeholderCount !== null) setPlaceholderCount(null)
        }}
        onRun={() => void run()}
        schema={schema}
        lineNumbers
        minHeight={112}
        maxHeight={320}
        placeholder={`SELECT * FROM "${table.name}" LIMIT 50`}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void run()} disabled={running || !sql.trim()}>
          {running ? <Spinner /> : <Play />} Run <span className="ml-1 text-[10px] opacity-70">Ctrl/⌘+Enter</span>
        </Button>
        {result && (
          <>
            <Button size="sm" variant="outline" onClick={() => void chartIt()} disabled={charting}>
              {charting ? <Spinner /> : <BarChart3 />} Chart it
            </Button>
            <Button size="sm" variant="outline" onClick={pin} disabled={pinned}>
              <PinIcon /> {pinned ? "Pinned" : "Pin"}
            </Button>
          </>
        )}
        {result && (
          <span className="ml-auto text-xs text-muted-foreground">
            {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
            {result.truncated && " (truncated)"} · {result.elapsedMs} ms
          </span>
        )}
      </div>

      {placeholderCount !== null && (
        <div className="rounded-lg border border-line-strong bg-secondary px-3 py-3 text-xs text-muted-foreground">
          This query has {placeholderCount} placeholder{placeholderCount === 1 ? "" : "s"} (?). Replace{" "}
          {placeholderCount === 1 ? "it" : "them"} with a value{placeholderCount === 1 ? "" : "s"} — SQL copied from
          auradash-bi already has values filled in.
        </div>
      )}

      {error && <div className="rounded-lg bg-destructive/10 px-3 py-3 font-mono text-xs text-destructive">{error}</div>}

      {chart && result && (
        <div className="h-80 rounded-xl border border-border bg-card p-3">
          <ChartView spec={chart.spec} result={result} profile={profileResult(result)} />
        </div>
      )}

      {result && (
        <DataGrid
          columns={result.columns.map((c) => ({ name: c }))}
          rows={result.rows as Cell[][]}
          className="h-[calc(100svh-28rem)]"
        />
      )}
    </div>
  )
}

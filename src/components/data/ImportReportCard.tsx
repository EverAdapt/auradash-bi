/** OWNER: data-engine. Result of an import(): tables + row counts, skipped statements, warnings. */
import { useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, Compass, MessageCircleQuestion } from "lucide-react"
import type { ImportReport } from "@/lib/db"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { formatCount } from "@/lib/db/format"

export function ImportReportCard({
  report,
  onAsk,
  onExplore,
}: {
  report: ImportReport
  onAsk: () => void
  onExplore: () => void
}) {
  const [showSkipped, setShowSkipped] = useState(false)
  const hasIssues = report.skipped.length > 0 || report.warnings.length > 0

  return (
    <Card className="border-line-strong">
      <CardHeader>
        <CardTitle>"{report.dataset.title}" is ready</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5">
          {report.tables.map((t) => (
            <li key={t.name} className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-1.5 text-sm">
              <span className="font-mono text-xs text-foreground">{t.name}</span>
              <span className="tabular-nums text-muted-foreground">{formatCount(t.rows)} rows</span>
            </li>
          ))}
        </ul>

        {hasIssues && (
          <div className="mt-3 flex flex-col gap-2 rounded-lg bg-caution/10 p-3 text-sm text-caution-text">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-4" />
              {report.skipped.length > 0
                ? `${report.skipped.length} statement${report.skipped.length === 1 ? "" : "s"} skipped`
                : "A few notes"}
            </div>
            {report.warnings.map((w, i) => (
              <p key={i} className="text-xs opacity-90">
                {w}
              </p>
            ))}
            {report.skipped.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSkipped((v) => !v)}
                className="flex items-center gap-1 self-start text-xs font-medium underline-offset-2 hover:underline"
              >
                {showSkipped ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {showSkipped ? "Hide" : "Show"} skipped statements
              </button>
            )}
            {showSkipped && (
              <ul className="flex flex-col gap-2">
                {report.skipped.map((s, i) => (
                  <li key={i} className="rounded-md bg-background/60 p-2 font-mono text-[11px] leading-snug break-all">
                    <div className="text-foreground">{s.statement}</div>
                    <div className="mt-1 text-caution-text">{s.error}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={onAsk}>
            <MessageCircleQuestion /> Ask
          </Button>
          <Button size="sm" variant="outline" onClick={onExplore}>
            <Compass /> Explore
          </Button>
          <Badge variant="secondary" className="ml-auto">
            {report.executed} statement{report.executed === 1 ? "" : "s"} run
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * OWNER: data-engine. "Bring your own data": dropzone or pasted SQL, a name, Import, then the
 * ImportReportCard. Also offers "Try a sample" (the deterministic coffee-shop dump + CSV).
 */
import { useState } from "react"
import { useLocation } from "wouter"
import { Sparkles, UploadCloud } from "lucide-react"
import { importDataset, type ImportReport } from "@/lib/db"
import { useDatasets } from "@/state/datasets"
import { useDemo } from "@/lib/demo"
import { REPO_URL } from "@/lib/site"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { Dropzone } from "@/components/data/Dropzone"
import { ImportReportCard } from "@/components/data/ImportReportCard"
import { sampleCsvFile, sampleDump, sampleDumpFile } from "@/components/data/samples"

export function ImportPanel() {
  const [, navigate] = useLocation()
  const refresh = useDatasets((s) => s.refresh)
  const setCurrent = useDatasets((s) => s.setCurrent)
  const demo = useDemo((s) => s.demo)

  const [mode, setMode] = useState<"files" | "paste">("files")
  const [files, setFiles] = useState<File[]>([])
  const [sqlText, setSqlText] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)

  const canImport = !demo && !busy && (files.length > 0 || sqlText.trim().length > 0) && name.trim().length > 0

  const runImport = async (input: { name: string; files?: File[]; sqlText?: string }) => {
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const r = await importDataset(input)
      setReport(r)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.")
    } finally {
      setBusy(false)
    }
  }

  const handleImport = () => runImport({ name: name.trim(), files: mode === "files" ? files : undefined, sqlText: mode === "paste" ? sqlText : undefined })

  const loadSample = () => runImport({ name: sampleDump.datasetName, files: [sampleDumpFile(), sampleCsvFile()] })

  const goAsk = () => {
    if (!report) return
    setCurrent(report.dataset.id)
    navigate(`/?d=${report.dataset.id}`)
  }
  const goExplore = () => {
    if (!report) return
    setCurrent(report.dataset.id)
    navigate(`/explore/${report.dataset.id}`)
  }

  return (
    <div className="flex flex-col gap-4">
      {demo && (
        <p className="rounded-lg border border-dashed border-line-strong bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Bring-your-own-data is off in the public demo. Clone{" "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-2 hover:text-brand"
          >
            auradash-bi
          </a>{" "}
          on GitHub to use your own databases — it all runs in your browser.
        </p>
      )}

      <div
        aria-disabled={demo}
        className={cn("flex flex-col gap-4", demo && "pointer-events-none opacity-50")}
      >
        <Tabs value={mode} onValueChange={(v) => setMode(v as "files" | "paste")}>
          <div className="flex items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="files" disabled={demo}>
                Upload files
              </TabsTrigger>
              <TabsTrigger value="paste" disabled={demo}>
                Paste SQL
              </TabsTrigger>
            </TabsList>
            <Button type="button" variant="outline" size="sm" onClick={loadSample} disabled={demo || busy}>
              <Sparkles /> Try a sample
            </Button>
          </div>
          <TabsContent value="files" className="mt-3">
            <Dropzone files={files} onFilesChange={setFiles} disabled={demo} />
          </TabsContent>
          <TabsContent value="paste" className="mt-3">
            <Textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              placeholder="CREATE TABLE ...; INSERT INTO ...;"
              className="min-h-40 font-mono text-xs"
              disabled={demo}
            />
          </TabsContent>
        </Tabs>

        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dataset name, e.g. “Q3 orders”"
            className="max-w-xs"
            disabled={demo}
          />
          <Button onClick={handleImport} disabled={!canImport}>
            {busy ? <Spinner /> : <UploadCloud />}
            Import
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {report && <ImportReportCard report={report} onAsk={goAsk} onExplore={goExplore} />}
    </div>
  )
}

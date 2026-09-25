/**
 * OWNER: data-engine. Drag & drop + click file picker for "Bring your own data".
 * Accepts .sqlite/.db/.sqlite3, .sql and .csv, any combination, multiple files.
 */
import { useRef, useState } from "react"
import { FileSpreadsheet, FileUp, UploadCloud, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/db/format"

const ACCEPT = ".sqlite,.db,.sqlite3,.sql,.csv"

function iconFor(name: string) {
  return /\.csv$/i.test(name) ? FileSpreadsheet : FileUp
}

export function Dropzone({
  files,
  onFilesChange,
  disabled = false,
}: {
  files: File[]
  onFilesChange: (files: File[]) => void
  /** Public demo: greyed out, no pointer actions, but still reachable/announced for a11y. */
  disabled?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (incoming: FileList | File[]) => {
    const next = [...files]
    for (const f of Array.from(incoming)) {
      if (!next.some((existing) => existing.name === f.name && existing.size === f.size)) next.push(f)
    }
    onFilesChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          if (disabled) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          if (disabled) return
          setDragging(false)
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
          disabled
            ? "pointer-events-none border-line-strong opacity-50"
            : dragging
              ? "border-brand bg-brand-soft"
              : "border-line-strong hover:bg-muted/50",
        )}
      >
        <UploadCloud className="size-6 text-muted-foreground" />
        <div className="text-sm">
          <span className="font-medium text-foreground">Drop files here</span>{" "}
          <span className="text-muted-foreground">or click to choose</span>
        </div>
        <div className="text-xs text-muted-foreground">.sqlite, .db, .sql or .csv — multiple files OK</div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={disabled}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files)
            e.target.value = ""
          }}
        />
      </button>
      {!disabled && files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f) => {
            const Icon = iconFor(f.name)
            return (
              <li
                key={`${f.name}-${f.size}`}
                className="flex items-center gap-1.5 rounded-full bg-secondary py-1 pr-1 pl-2.5 text-xs text-secondary-foreground"
              >
                <Icon className="size-3.5 text-muted-foreground" />
                <span className="max-w-40 truncate">{f.name}</span>
                <span className="text-muted-foreground">{formatBytes(f.size)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-full"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => onFilesChange(files.filter((x) => x !== f))}
                >
                  <X />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

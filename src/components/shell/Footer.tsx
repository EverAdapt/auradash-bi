/**
 * OWNER: ask-board. App identity + credits: APP_NAME with GitHub/LinkedIn links, the current
 * dataset's attribution, the map source, the Jev credit, and (public demo only) the telemetry
 * notice. `/api/health`'s `telemetry` flag isn't part of the `useDemo` stub's tiny shape (owned by
 * platform), so this reads it with its own small, best-effort fetch — silent on failure, since a
 * missing/local Worker should never make the footer break or flash an error.
 */
import { useEffect, useState } from "react"
import { APP_NAME, LINKEDIN_URL, REPO_URL } from "@/lib/site"
import { TELEMETRY_NOTICE } from "@/lib/telemetry"
import { currentDataset, useDatasets } from "@/state/datasets"

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  )
}

function LinkedInMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden className={className}>
      <path d="M14.82 0H1.18C.53 0 0 .52 0 1.16v13.68C0 15.48.53 16 1.18 16h13.64c.65 0 1.18-.52 1.18-1.16V1.16C16 .52 15.47 0 14.82 0ZM4.75 13.63H2.4V6h2.35v7.63ZM3.58 4.97c-.75 0-1.36-.61-1.36-1.36 0-.75.61-1.36 1.36-1.36.75 0 1.36.61 1.36 1.36 0 .75-.6 1.36-1.36 1.36Zm10.05 8.66h-2.34V9.9c0-.86-.02-1.97-1.2-1.97-1.21 0-1.39.94-1.39 1.91v3.79H6.36V6h2.25v1.04h.03c.31-.59 1.08-1.21 2.22-1.21 2.37 0 2.81 1.56 2.81 3.59v4.21Z" />
    </svg>
  )
}

/** Best-effort check for whether interaction history is being recorded. Never throws, never
 *  retries — a footer credit line isn't worth a loading state or an error boundary. */
function useTelemetryEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { telemetry?: boolean } | null) => {
        if (alive && data?.telemetry) setEnabled(true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return enabled
}

export function Footer() {
  const current = useDatasets(currentDataset)
  const telemetryOn = useTelemetryEnabled()

  return (
    <footer className="mx-auto max-w-[1240px] px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-5">
        <span className="text-xs font-medium text-foreground">{APP_NAME}</span>
        <div className="flex items-center gap-3 text-muted-foreground">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={`${APP_NAME} on GitHub`}
            className="transition-colors hover:text-foreground"
          >
            <GithubMark />
          </a>
          {LINKEDIN_URL && (
            <a
              href={LINKEDIN_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={`${APP_NAME} on LinkedIn`}
              className="transition-colors hover:text-foreground"
            >
              <LinkedInMark />
            </a>
          )}
        </div>
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {current?.attribution && <span>{current.attribution}</span>}
        {current?.attribution && <span aria-hidden>·</span>}
        <span>Map: Natural Earth</span>
        <span aria-hidden>·</span>
        <span>Questions read by Jev (TypeSafe AI)</span>
      </p>

      {telemetryOn && <p className="mt-1.5 text-[11px] text-muted-foreground">{TELEMETRY_NOTICE}</p>}
    </footer>
  )
}

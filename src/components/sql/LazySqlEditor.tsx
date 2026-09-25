/**
 * OWNER: ask-board (wave 4, UI workstream). Every call site (stage SQL panel, pin "View SQL"
 * dialog, explorer console) imports this instead of `./SqlEditor` directly, so CodeMirror and its
 * language/autocomplete packages are code-split out of the main bundle and only fetched the first
 * time a SQL panel actually opens.
 */
import { Suspense, lazy } from "react"
import { cn } from "cn"
import type { SqlEditorProps } from "./SqlEditor"

const SqlEditor = lazy(() => import("./SqlEditor"))

function EditorFallback({ minHeight, className }: { minHeight?: number | string; className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-[12px] border border-border bg-secondary/60", className)}
      style={{ minHeight: minHeight ?? 80 }}
      aria-hidden
    />
  )
}

export function LazySqlEditor(props: SqlEditorProps) {
  return (
    <Suspense fallback={<EditorFallback minHeight={props.minHeight} className={props.className} />}>
      <SqlEditor {...props} />
    </Suspense>
  )
}

export type { SqlEditorProps, SqlSchema } from "./SqlEditor"

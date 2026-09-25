/**
 * OWNER: ask-board (wave 4, UI workstream). The one CodeMirror 6 SQL editor used everywhere SQL is
 * shown or edited: the stage SQL panel and the pin "View SQL" dialog (both read-only), and the
 * explorer console (editable, autocomplete from the dataset's catalog, Ctrl/Cmd+Enter runs). Fully
 * re-themed to the design system's tokens (Geist Mono, brand keywords, series-coded literals, soft
 * card surface, brand-soft selection) in both light and dark — no default CodeMirror look ships.
 * Always imported through `./LazySqlEditor`, never directly, so CodeMirror stays out of the main
 * bundle (this is the module `React.lazy` loads).
 */
import { useEffect, useRef } from "react"
import { EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers as lineNumbersExtension,
  placeholder as placeholderExtension,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language"
import { sql, SQLite, type SQLNamespace } from "@codemirror/lang-sql"
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
import { tags as t } from "@lezer/highlight"
import { cn } from "cn"

/** table name → its column names, for SQL autocomplete (SQLite dialect). */
export type SqlSchema = Record<string, string[]>

export interface SqlEditorProps {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  /** Ctrl/Cmd+Enter */
  onRun?: () => void
  schema?: SqlSchema
  minHeight?: number | string
  maxHeight?: number | string
  className?: string
  autoFocus?: boolean
  lineNumbers?: boolean
  placeholder?: string
}

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--brand)", fontWeight: 600 },
  { tag: [t.string, t.special(t.string)], color: "var(--series-3)" },
  { tag: [t.number, t.bool, t.null], color: "var(--series-2)" },
  { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--ink-2)" },
  { tag: t.operator, color: "var(--ink-2)" },
  { tag: [t.punctuation, t.paren, t.bracket], color: "var(--muted-foreground)" },
  { tag: [t.variableName, t.propertyName, t.typeName], color: "var(--foreground)" },
])

const editorTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "10px 12px",
    caretColor: "var(--brand)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 2px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-gutterElement": { paddingRight: "10px" },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--foreground) 5%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  "&.cm-editor.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--brand) 22%, transparent) !important",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--brand)" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--brand-soft)",
    outline: "1px solid color-mix(in oklch, var(--brand) 40%, transparent)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--popover)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-lift)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    padding: "4px",
  },
  ".cm-tooltip-autocomplete ul li": {
    borderRadius: "var(--radius-sm)",
    padding: "4px 8px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--brand-soft)",
    color: "var(--foreground)",
  },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
})

function schemaToNamespace(schema: SqlSchema | undefined): SQLNamespace | undefined {
  if (!schema) return undefined
  const ns: Record<string, string[]> = {}
  for (const [table, columns] of Object.entries(schema)) ns[table] = columns
  return ns
}

export default function SqlEditor({
  value,
  onChange,
  readOnly = false,
  onRun,
  schema,
  minHeight = 80,
  maxHeight,
  className,
  autoFocus = false,
  lineNumbers = false,
  placeholder,
}: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Callbacks read through refs so the editor is only ever rebuilt for the props that actually
  // change its behavior (readOnly, schema, lineNumbers) — a new inline `onRun` each render must
  // not tear down and recreate the CodeMirror instance (that would drop focus/selection/undo).
  // Updated during render (not an effect) so the very first CodeMirror callback after a prop
  // change already sees the latest closure, same pattern as AskPanel.tsx's `activeResult` cache.
  /* eslint-disable react-hooks/refs */
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const extensions: Extension[] = [
      history(),
      syntaxHighlighting(highlightStyle),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      editorTheme,
      sql({ dialect: SQLite, schema: schemaToNamespace(schema), upperCaseKeywords: true }),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            onRunRef.current?.()
            return true
          },
        },
        indentWithTab,
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
      }),
    ]
    if (lineNumbers) extensions.push(lineNumbersExtension())
    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true))
    } else {
      extensions.push(autocompletion({ activateOnTyping: true }))
    }
    if (placeholder) extensions.push(placeholderExtension(placeholder))

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host,
    })
    viewRef.current = view
    if (autoFocus && !readOnly) view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Rebuilt only when the editor's *shape* changes; `value` afterwards is synced by the effect
    // below so typing doesn't tear the instance down every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, lineNumbers, JSON.stringify(schema), placeholder])

  // Keep the document in sync when `value` changes from outside (e.g. "Open in console" filling a
  // new query, or a controlled reset) without fighting the user's own edits mid-keystroke.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[12px] border border-border bg-secondary/60 transition-shadow duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
        className
      )}
      style={{ minHeight, maxHeight, overflow: maxHeight ? "auto" : undefined }}
    >
      <div ref={hostRef} className="h-full [&_.cm-editor]:h-full" />
    </div>
  )
}

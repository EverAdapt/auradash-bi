/**
 * OWNER: data-engine. Tiny presentational formatters shared by the Data and Explorer pages.
 * Pure, no DOM — safe to use from any component.
 */

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

export function formatCount(n?: number): string {
  if (n === undefined) return "—"
  return n.toLocaleString("en-US")
}

export function formatDate(iso?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

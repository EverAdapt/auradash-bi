/**
 * Bundled datasets are discovered, not listed: every data/<id>.semantic.json with a matching
 * data/<id>.sqlite is one. Order: the showcase datasets first, then the rest alphabetically.
 * Used by build-catalog.ts, bake.ts and the CLIs.
 */
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

const PREFERRED_ORDER = ["nobel", "world", "afl", "swift"]

export function bundledDatasetIds(root: string): string[] {
  const dir = path.join(root, "data")
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".semantic.json"))
    .map((f) => f.replace(/\.semantic\.json$/, ""))
    .filter((id) => existsSync(path.join(dir, `${id}.sqlite`)))
  const rank = (id: string) => {
    const i = PREFERRED_ORDER.indexOf(id)
    return i === -1 ? PREFERRED_ORDER.length : i
  }
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

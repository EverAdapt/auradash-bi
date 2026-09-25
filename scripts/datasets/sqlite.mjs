// Tiny adapter so the build scripts run unchanged under Bun (bun:sqlite) or Node >= 22.13 (node:sqlite).
// Only the common subset is used: exec(), prepare().run/all/get(), close(). Positional "?" params only.
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const ensureDir = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };

export async function openDb(path) {
  path = resolve(path);
  ensureDir(dirname(path));
  if (existsSync(path)) rmSync(path);
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { create: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}

/** Insert many rows inside one transaction. rows: array of arrays (positional). */
export function insertMany(db, sql, rows) {
  const stmt = db.prepare(sql);
  db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(...r.map((v) => (v === undefined ? null : v)));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** fetch JSON with an on-disk cache (CACHE_DIR env) so re-runs are offline and polite to the APIs. */
export async function fetchJson(url, cacheName) {
  const cacheDir = process.env.CACHE_DIR && resolve(process.env.CACHE_DIR);
  const file = cacheDir && cacheName ? join(cacheDir, cacheName) : null;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "auradash-bi-dataset-builder" } });
    if (res.ok) {
      const text = await res.text();
      if (file) {
        ensureDir(cacheDir);
        writeFileSync(file, text);
      }
      return JSON.parse(text);
    }
    if (attempt >= 4) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

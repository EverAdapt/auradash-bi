# AGENTS.md

Working notes for coding agents and contributors. Read this before changing anything.

## What this is

auradash-bi turns a plain-English question into SQL and a chart over a relational dataset, all in the browser. It's one Vite SPA plus a small Cloudflare Worker (Hono) that talks to TypeSafe's **Jev** model.

**The core rule: Jev decides, code computes.** Jev only returns typed judgments: Choice, Noul (yes/no probability) and Score. It never writes SQL and never extracts values.

- Code builds the options from the schema: measures, dimensions, time grains, and filter candidates found in the question.
- Jev picks among them. Every Choice has an escape option (`none` / `not_stated` / `not_a_filter`).
- Code compiles parameterised SQL. Joins come from the foreign-key graph, identifiers only from the catalog, and values are always bound.

```
question ─► src/lib/plan (candidates, request) ─► POST /api/plan (Jev) ─► interpret ─► compile ─► SQL
        ─► src/lib/db (SQLite WASM worker) ─► src/lib/viz (profile, eligible charts) ─► POST /api/chart (Jev)
        ─► src/components/charts ─► pin to the dashboard (src/components/board)
```

## Commands (bun)

| Command | What it does |
|---|---|
| `bun install` | dependencies |
| `bun run dev` | Vite + the Worker on http://localhost:5310 (needs `.dev.vars` for real Jev; offline planner otherwise) |
| `bun run dev:v02` | the same on http://localhost:5320 (a second checkout side by side) |
| `bun run build` | `tsc -b` + Vite build (client and Worker). Must stay green. |
| `bun run deploy` | build and deploy the default Worker (uploads enabled) |
| `bun run deploy:demo` | build and deploy the public demo (`env.demo`: DEMO_MODE, custom domain, D1 history) |
| `bun scripts/build-catalog.ts` | `data/<id>.sqlite` + `data/<id>.semantic.json` produce `public/data/<id>.catalog.json`, `.sqlite.gz`, `datasets.json` and `src/fixtures/try-results.json` |
| `bun scripts/gen-bundled.ts` | writes `shared/bundled.ts` (bundled dataset ids + schema hashes the demo Worker accepts) |
| `bun scripts/bake.ts [ids]` | pre-computes Jev answers for every curated Try prompt into `public/data/<id>.baked.json` |
| `bun scripts/plan-cli.ts --all \| --extra \| --dataset <id> "q"` | runs the real planner against live Jev and bun:sqlite. This is the regression bar. |
| `bun scripts/upload-cli.ts --suite sample\|energy\|chinook` | the same, for uploaded-style databases (automatic catalog) |
| `bun scripts/plan-cli.ts --v02 [filters\|calc\|agnostic]` | feature questions (`scripts/questions/*.ts`); each must show its feature in the SQL (`expect` regexes) |
| `bun run check:agnostic` | fails if Jev wording names a bundled dataset's nouns, or planner code names a dataset id or table |
| `bun run events:report [--days 7]` | report from the demo's anonymous interaction history (D1) |

`.dev.vars` (gitignored) holds `TYPESAFE_API_KEY`. The key must only ever live in the Worker. Never print it, commit it or send it to the browser.

## Layout

| Path | Role |
|---|---|
| `shared/contract.ts` | **The contract** between client, Worker and scripts: Catalog, PlanRequest/Answers, QueryPlan, CompiledQuery, ChartSpec, Pin. Change it deliberately, and update every consumer. |
| `shared/jev/questions*.ts` | Every Jev question and its wording: `questions.ts` (plan + chart), `questions-filters.ts` (one question per thing found in the question), `questions-calc.ts` (cue-gated rate / change-over-time) |
| `shared/validate.ts` | zod request caps shared by the Worker |
| `worker/` | Hono Worker: `/api/health`, `/api/plan`, `/api/chart`, `/api/events`. Rate limits, cache, demo restrictions, security headers. |
| `src/lib/plan/` | candidates (values, years, ranges, periods, thresholds, text, or-pairs, rank windows) and `cues.ts`; request builder; offline planner; `filters.ts` (filter IR + chips) and `interpret.ts` (the rest of the plan); `compile.ts` (assembly), `where.ts` (WHERE/HAVING), `calc.ts` (share, rate, bands, cyclical time, window functions), `sql.ts` (shared SQL helpers); `rules.ts` (the generic engine for semantic-layer `planRules`) |
| `src/lib/catalog/` | the semantic layer: bundled catalogs, plus `buildAutoCatalog` for uploads |
| `src/lib/db/`, `src/workers/` | SQLite WASM engine, uploads (SQL-dump normaliser, CSV), and the read-only SQL policy |
| `src/lib/viz/`, `src/components/charts/` | result profiling, chart eligibility and encoding, 16 renderers (Recharts + custom SVG map and heatmap) |
| `src/components/{ask,board,explorer,data,shell,sql}/` | ask panel (calm preview state machine), dashboard (react-grid-layout), explorer, uploads, shell, SqlEditor (CodeMirror) |
| `data/` | dataset sources: `*.sqlite` + `*.semantic.json` (the semantic layer you edit) |
| `scripts/datasets/` | reproducible dataset builders (download, cache, SQLite) |

## Adding or changing a dataset

1. Write `scripts/datasets/build-<id>.mjs`. It must be reproducible: cached downloads, `PRAGMA foreign_key_check`, and an `_about` table with source, licence and attribution. Only use sources whose terms allow public redistribution.
2. Write `data/<id>.semantic.json`: column roles, labels, synonyms, value aliases, joins, metrics, `listColumns`, `rules`, and 8+ `tryPrompts` each with a reference `sql`. Dataset-specific compile behaviour goes in `planRules` (`require_filter`, `rollup`, `default_latest_year`), `relationship` (entity / size / colour) and `groupLabels`, never in code. Multi-role FK columns carry the words for their role as `synonyms` ("won", "beat" on a winner column).
3. `bun run build-catalog`, then iterate with `bun scripts/plan-cli.ts --dataset <id> "…"` until every Try prompt answers sensibly. Fix the semantic layer first, and the planner only in general ways (never special-case a prompt).
4. `bun scripts/bake.ts <id>`, then commit the source files and the regenerated `public/data` and `src/fixtures`.

## Rules

- **Regression bar:** `plan-cli --all` and `--extra` and `upload-cli --suite sample|energy` must keep passing with live Jev, and `bun run build` must stay green.
- **Agnostic by construction.** Every Jev question is driven by something code found in the question or derived from the schema, with a fixed option set and an escape option. No wording names a bundled dataset's nouns and no planner code names a dataset, table or column (`bun run check:agnostic`). Cue-gated questions (`cues.ts`) are only asked when their generic English cue is present.
- **Planner fixes must be general.** Tune question wording in `shared/jev/questions.ts` (keep an escape option on every Choice), candidates, request option text, interpret rules, or the semantic layer. Plan confidence is the *minimum* over the slots a plan uses.
- **SQL safety:**
  - Compiled SQL uses catalog identifiers and bound values only.
  - Every value that came from the question is bound (`?`), including LIKE fragments (escaped, `ESCAPE '\'`), thresholds and band edges; code constants may be inlined with `sqlLiteral`. Every division uses `NULLIF`.
  - User SQL (the explorer console) goes through the strict read-only policy in `src/lib/db`: a single SELECT/WITH/VALUES/EXPLAIN, no ATTACH/PRAGMA/DDL/DML, a 4 s interrupt and a row cap.
  - The catalog's introspection uses the separate trusted path.
- **Public demo** (`DEMO_MODE=true`): uploads are disabled, and the Worker only answers for bundled datasets (`shared/bundled.ts`). The repo default keeps everything on.
- **Privacy:** interaction history (demo only, D1 `EVENTS`) is anonymous: a random per-browser id and the country, with no IP and no user agent. Keep the footer notice in sync with what is logged.
- **Copyright:** no song lyrics or other copyrighted text in datasets. Facts are written in our own words, with sources.
- **UI:**
  - Use the design tokens in `src/index.css`: Geist, warm neutrals, one brand indigo, concentric radii, light and dark.
  - Charts use the validated `--series-*` / `--seq-*` palette in fixed order: no dual axes, and more than 8 series fold into "Other".
  - Product name, links and storage prefix come from `src/lib/site.ts`.
- **Style:** strict TypeScript, small modules, and header comments that explain intent. Match the surrounding code.

# Architecture

## Flow

```
browser (Vite SPA)                                                     Cloudflare Worker (Hono)
┌───────────────────────────────────────────────────────────────┐      ┌───────────────────────────┐
│ Ask box ─► lib/ask/pipeline                                    │      │ GET  /api/health          │
│   getCatalog ─► plan: candidates + request ─► postPlan ────────┼─────►│ POST /api/plan   (Jev)    │
│              ◄─ typed answers ◄────────────────────────────────┼──────│ POST /api/chart  (Jev)    │
│   interpret ─► compile ─► parameterised SQL                    │      │ POST /api/events (history)│
│   SQLite WASM worker (bundled .sqlite.gz or your upload)       │      │ rate limits, cache,       │
│   profile ─► eligible charts ─► postChart ─► render ─► pin     │      │ demo restrictions, CSP    │
└───────────────────────────────────────────────────────────────┘      └───────────────────────────┘
```

## Jev: two calls per question

**Plan** (one request, every question asked in parallel):
- `in_scope` (Noul)
- `answer_kind`: aggregate / rows / distribution / unanswerable
- `measure`, `measure2` (relationships), `group_by`, `time_grain`, `sort`
- `limit` (over the numbers found in the question)
- `row_table`, `sort_column`, `named_chart`
- one `filter:<id>` Choice per value found in the question: include / exclude / not a filter, or in / from / until for years, including "now"
- one `role:<id>` Choice when that value's table is linked several ways (home / away / winner / loser / any); the wording hints are that FK column's own synonyms
- v0.2, one Choice per thing found in the question: `threshold:<id>` ("over 100 million": the per-group total → HAVING, a field on each record → WHERE, or not a filter), `text:<id>` (which text field a fragment searches → LIKE), `combine:<id>` (both / either → OR), `window:<id>` ("ranked 11 to 20" → OFFSET); year ranges (between / separately) and relative periods ("last 10 years", anchored to the latest data)
- v0.2, cue-gated (asked only when a generic English cue is present): `missing` (which field is empty or recorded → IS NULL), `per` (divide by which amount → NULLIF), `time_calc` (change / % change / running total → LAG, SUM OVER)
- v0.2 schema-driven options: numeric fields in bands (CASE WHEN) for `group_by`; day of week, month of year and hour of day for `time_grain`; a value used as a `share` of the whole

**Chart:** code first works out which chart types can honestly show the result. Jev then picks one, and its ranking orders the chart switcher.

**Confidence** is the minimum over the slots a plan uses:
- A runner-up with p ≥ 0.15 becomes a "Did you mean" chip, with no extra call.
- An empty result tries deterministic fallbacks (`fallbackPlans`) before showing an empty state.

## Semantic layer

`data/<id>.semantic.json` is the hand-tuned layer, and `scripts/build-catalog.ts` turns it into `public/data/<id>.catalog.json`. Dataset-specific compile behaviour lives there too, as declarative `planRules`, `relationship` and `groupLabels` applied by the generic `src/lib/plan/rules.ts`:
- column roles (dimension, label, time, date, measure, geo_code, latitude/longitude, …), labels, units and aggregations
- synonyms and value aliases, joins, curated metrics, `listColumns`, `rules`
- Try prompts, each with a reference SQL

Uploads get the same shape from `buildAutoCatalog`: roles are inferred from types, names and values, joins from declared FKs and `<table>_id` naming, and it adds a small business thesaurus.

## Security model

- **API key:** the TypeSafe key is a Worker secret. The browser only ever calls `/api/*`.
- **Compiled SQL:** identifiers come from the catalog and values are bound parameters.
- **User SQL (console):**
  - one read-only SELECT / WITH / VALUES / EXPLAIN
  - no ATTACH / PRAGMA / DDL / DML
  - a 4 s interrupt and a row cap
  - `query_only` connections
- **Worker:** request caps (zod), per-IP and global rate limits, security headers and CSP.
- **Public demo** (`DEMO_MODE=true`): uploads are off, and only the bundled datasets are answered (`shared/bundled.ts`).
- **Interaction history** (demo only) is anonymous: a random per-browser id and the country. No IP or user agent is stored.

## UI principles

- Calm previews: the state machine follows the question's text, so edits always re-run. Enter runs; Ctrl/Cmd+Enter or the Pin button pins.
- Shapeshift-style tokens, light and dark. The dataviz palette is validated and used in a fixed order, with no dual axes.

# auradash-bi v0.2: a richer SQL builder that works on any schema

Branch `v0.2`, cut from `main` (v0.1). Two goals:

1. **The SQL builder learns the analytics features it was missing**: comparisons, text search, missing data, AND/OR, bands (CASE), NULL-safe labels (COALESCE), relative periods, day-of-week and hour-of-day patterns, rates with safe division (NULLIF), HAVING, window functions (LAG and running totals) and OFFSET.
2. **Every Jev question is agnostic.** Each question is either driven by something code *found in the question* or built from the schema, and it has a small fixed set of options. No wording, code path or hook names a bundled dataset, so a new dataset (or an upload) gets every feature without code changes. Dataset-specific behaviour moves out of code and into `data/<id>.semantic.json`.

The rule is unchanged: **Jev decides, code computes.** Jev never sees SQL and never extracts values. Code finds the value, number, phrase or column; Jev picks how it is used; code writes parameterised SQL. Every Choice has an escape option.

## 1. The question catalog

Rows marked **new** are v0.2. "Found by code" means a regex or the value index, never Jev.

| Found in the question (by code) | Jev question | Options (fixed) | SQL |
|---|---|---|---|
| A stored value ("Fremantle", "women") | How is `value` used? | include only · exclude · **share of** · not a filter | `IN` · `NOT IN` / `<>` (keeps NULL rows) · `100.0*SUM(CASE WHEN … THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0)` |
| A year or "now" ("2000", "today") | How is the year used? | in · from · until · **before** · **after** · not a filter | `=` · `>=` · `<=` · **`<`** · **`>`** |
| **new** A year range ("between 1990 and 2010", "1990–2010", "from 1990 to 2010") | How is the range used? | between · each year separately · not a filter | `BETWEEN ? AND ?` · `IN (?, ?)` |
| **new** A relative period ("last 10 years", "past 30 days", "this year so far", "previous month") | Does it restrict the rows? | within the period · not a filter | anchored to the **latest data**: `col > (SELECT MAX(col) …) - ?` / `col >= date((SELECT MAX(col) …), ?)` |
| **new** A comparison with a number ("over 100 million", "at least 5", "fewer than 3", "between 20 and 30") | What is compared with `number`? | the calculated amount per group · each record's ‹numeric field› (one option per field) · not a filter | **`HAVING agg > ?`** · `WHERE col > ?` (`<`, `>=`, `<=`, `=`, `BETWEEN`) |
| **new** A text fragment (quoted, "containing X", "starting with X", "ending with X", "with X in the name/title") | Which field is searched for `text`? | each text field · not a filter | `LIKE ? ESCAPE '\'` (contains / starts / ends; case-insensitive) |
| **new** "or" between values of two *different* fields ("physics laureates or women") | Must both hold, or either? | both · either | `(a OR b)`; everything else is ANDed |
| **new** A missing-data cue ("without", "unknown", "missing", "not yet", "still", "never", "no …") | Which field is empty or recorded? | ‹field› is missing · ‹field› is recorded (per nullable field) · none | **`IS NULL`** · `IS NOT NULL` |
| **new** A rank window ("ranked 11 to 20", "the next 10", "positions 21–30") | Is it a window of the ranking? | show ranks N–M · not a filter | `LIMIT ? OFFSET ?` |
| **new** A rate cue ("per", "rate", "ratio", "for every", "relative to") | Is one amount divided by another? | each measure (the denominator) · none | `m1 / NULLIF(m2, 0)` |
| **new** A change cue ("growth", "change", "grew", "cumulative", "running total", "year over year") plus a time axis | What is computed over time? | the amount itself · change vs the previous period · % change vs the previous period · running total | `x - LAG(x) OVER (…)` · `100.0*(x-LAG(x))/NULLIF(LAG(x),0)` · `SUM(x) OVER (… ROWS UNBOUNDED PRECEDING)` |
| Schema: dimensions | Group by which category? | each dimension · **each numeric field in bands** · none | `GROUP BY` · **`CASE WHEN x < ? THEN … END`** (edges from numbers in the question, else nice widths) |
| Schema: time column | Break down over time, at what step? | year · decade · quarter · month · day · **day of week** · **month of year** · **hour of day** · none | `strftime('%w' / '%m' / '%H', …)` (cyclical grains are categories ordered by their natural order) |
| (code only, no question) | | | **`COALESCE(label, '(none)')`** for NULL group labels |

Unchanged rows: `in_scope`, `answer_kind`, `measure`, `measure2` and relationship x/y, `sort`, `limit` (numbers found), `row_table`, `sort_column`, `named_chart`, and `role:<id>` (FK roles such as home / away / winner / loser / any).

**Cost control:** each cue-gated question is only asked when its cue is present, so ordinary questions send the same number of Jev questions as v0.1. The cues are generic English regexes in `src/lib/plan/cues.ts`. A cue only decides whether a question is *asked*; Jev still answers it, and there is always a "none" option.

## 2. Agnostic by construction

- **Wording:** `shared/jev/questions*.ts` contain no nouns from the bundled datasets. Examples use neutral placeholders ("items", "groups", "an amount", "a category"). As a check, grepping for `laureate|nobel|country|countries|gdp|club|afl|song|swift|album|population|premiership` there returns nothing.
- **FK role hints:** these come from the FK columns' own catalog synonyms (e.g. `matches.winner_club_id` has the synonyms won, beat, victor), carried on `FilterCandidate.roles[].synonyms`, not from a hard-coded English list.
- **Dataset hooks become declarative `planRules`** in `semantic.json`, compiled by one generic engine (`src/lib/plan/rules.ts`). `src/lib/plan/datasets/*.ts` is deleted.
  - `require_filter`: when a plan touches columns matching a pattern, add a filter. Nobel uses it for "people only" and "awarded prizes only".
  - `rollup`: group-level rows are read from a precomputed rollup table plus a discriminator. This is World's `aggregate_year`, `aggregates.kind` and its WLD total row.
  - `default_latest_year`: a plan with no time filter uses the measure's latest well-covered year. World uses this.
  - `relationship`: the entity, size and colour columns for relationship charts. This replaces the `/population/` and `/region/` regexes.
  - `groupLabels`: discriminator value → label (replaces `KIND_LABELS`).
- **Offline planner:** it has no dataset words ("children per woman", "richer" go). New answers are optional, and when absent they mean "none" / "not a filter".

## 3. Contract (`shared/contract.ts`, lead-owned)

The lead adds all of these in the setup commit; they are additive and optional so v0.1 pins and baked answers keep working. Implementers **must not** change the contract. They report a problem in their final report and write a local adapter instead.

- `FilterCandidate.kind` gains `range` (value = start, `value2` = end) and `period` (value = N, `unit` = year | month | week | day, or `ytd`).
- `PlanRequest` gains:
  - `thresholds: ThresholdCandidate[]` (`{id, op, values:number[], matched, display}`)
  - `texts: TextCandidate[]` (`{id, mode:"contains"|"starts"|"ends"|"exact", value, matched}`)
  - `orPairs: {id, a, b}[]`
  - `rankWindows: {id, from, to, matched}[]`
  - `cues: {missing, rate, change}`
  - `nullableColumns`
  - `textColumns`
- `PlanAnswers` gains optional `thresholds`, `texts`, `combine`, `rankWindows`, `missing`, `per` and `timeCalc`. `ValueFilterUse` adds `share`; `YearFilterUse` adds `before` and `after`; new `RangeUse` and `PeriodUse`.
- `FilterOp` adds `neq`, `gt`, `lt`, `between`, `like`, `is_null`, `not_null` and `within`. `PlanFilter` adds `group?` (the OR group), `pattern?` and `period?`.
- `QueryPlan` gains optional `having`, `share`, `per`, `timeCalc`, `bands` and `offset`.
- `TimeGrain` adds `weekday`, `month_of_year` and `hour`. `CatalogColumn` adds `hasTime?`.
- `Catalog` gains optional `planRules`, `relationship` and `groupLabels`.

## 4. Setup commit (lead, before any implementer starts)

This is a behaviour-preserving split so three people never edit the same file:

| New file | What moves into it | Owner |
|---|---|---|
| `shared/jev/questions-filters.ts` | the value, year and role question builders plus the new filter-kind questions and their normalisers | A |
| `shared/jev/questions-calc.ts` | the new calc questions (`per`, `time_calc`) and their normalisers | B |
| `src/lib/plan/filters.ts` | `buildFilters` and the filter chips from `interpret.ts` | A |
| `src/lib/plan/where.ts` | `opSql`, `buildViaClause` and `buildWhere` from `compile.ts`, plus a `buildHaving` stub | A |
| `src/lib/plan/calc.ts` | stubs for share, rate, window, band and cyclical SQL | B |
| `src/lib/plan/rules.ts` | the plan-rule engine; delegates to the old hooks for now | C |

`planQuestions` and `normalizePlanAnswers` spread in the per-file builders. `applyChoice` handles every slot prefix generically. `plan-cli --v02` runs the example questions in `scripts/questions/{filters,calc,agnostic}.ts`, one file per implementer.

## 5. Wave 1: three implementers in parallel, each in its own worktree

**A · Filters** (`v0.2-filters`): owns `candidates.ts`, `filters.ts`, `where.ts`, `questions-filters.ts`, `offline.ts` and `scripts/questions/filters.ts`.
- Candidates: thresholds (comparators, magnitude words k/thousand/million/billion/%), year ranges, relative periods, text fragments, "or" pairs, rank windows, missing-data cue.
- Questions and normalisers for those; `share`, `before` and `after` options.
- Filter IR and chips.
- WHERE: new ops, OR groups, exclude keeps NULLs, LIKE with escaping, `within` anchored to `MAX()`. HAVING via `buildHaving`. OFFSET from rank windows.

**B · Calculations** (`v0.2-calc`): owns `calc.ts`, `compile.ts` (aggregate/relationship/rows assembly), `interpret.ts` (non-filter parts), `request.ts`, `questions-calc.ts` and `scripts/questions/calc.ts`.
- Share (conditional aggregation), rate (NULLIF), time calcs (LAG, % change, running total with PARTITION BY series).
- Bands (`b:<col>` dimension options, CASE with bound edges).
- Cyclical grains (offered only for `date` columns, `hour` only when `hasTime`).
- COALESCE on nullable group labels; `offset` in the SQL; column meta (`percent` format for shares and % change).

**C · Agnostic + UI** (`v0.2-agnostic`): owns `rules.ts`, `data/*.semantic.json` (the rule sections), `scripts/build-catalog.ts`, `src/lib/catalog/*` (`hasTime`, rules passthrough), the wording in `shared/jev/questions.ts`, the UI (chips for the new slots, a "Next 50" pager on row tables) and `scripts/questions/agnostic.ts`.
- Declarative `planRules` reproduce the Nobel and World hooks exactly, then `datasets/*.ts` is deleted.
- Neutral wording, with iteration on the live regression.
- FK role hints come from column synonyms.

**Everyone:** keep `bun run build` green. Keep the regression bar live: `plan-cli --all` 46/46, `--extra` 78/78, and `upload-cli --suite sample` and `--suite energy` 10/10. Planner fixes stay general, never special-case a prompt. No new test suites (per the working rules, tests come after visual approval).

## 6. Merge, show, then harden

1. The lead merges A → B → C into `v0.2`, fixes the integration, re-runs the full bar plus `--v02`, then runs `build-catalog`, `gen-bundled` and `bake`.
2. The lead serves locally on http://localhost:5320 (`bun run dev:v02`) and reports with example questions per feature.
3. After visual approval: consolidate, write proper tests, review, then decide whether v0.2 goes to the public demo.

## Decisions (defaults taken; easy to flip)

- **Relative periods** are anchored to the latest data in the column, not today's date. The datasets are historical: "last 10 years" of World is 2015–2024. The chip says which years.
- **Exclude keeps NULL rows** ("excluding literature" keeps rows with no category). This is more correct, but some v0.1 counts change slightly.
- **LIKE is case-insensitive** (SQLite's ASCII default). No ILIKE is needed.
- **AND/OR** is one level deep: values joined by "or" across fields form OR groups; everything else is ANDed.
- **Hour of day** is only offered when the date column really has times. None of the bundled datasets do, but uploads may.
- **User-derived values** (numbers, text, dates) are always bound as `?`. Code constants such as `'(none)'` and band labels may be inlined through `sqlLiteral()`.

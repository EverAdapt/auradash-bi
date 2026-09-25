# Jev (TypeSafe System One) for auradash-bi: NL -> typed plan -> SQL -> chart

Research notes from the design phase, based on the TypeSafe docs, the `@typesafe-ai/sdk` source, and a few live API probes:
- limit probes;
- two rounds of the NL->SQL decomposition over 10 to 12 prompts on a Chinook-style catalog;
- one chart-selection round over 8 result profiles.

**There is no text-to-SQL cookbook.** The design below combines five cookbooks: function_calling, pre_parsed_value_extraction, semantic_find, skill_suggestion and hierarchical_classification.

---

## 1. Hard limits

| Limit | Value | Source |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | api.md |
| Models | `jev-latest` and `jev-preview` both point to `jev-1.13.0`. The response `model` field reports the versioned id. Pin `jev-1.13.0` if you tune thresholds. | models.md; live `GET /v1/models` |
| Options per Choice | **255 maximum**. 256 returned **HTTP 400** `{"detail":"Too many choices. Must have at most 255 choices."}` (docs say 422). | api.md; probed |
| Score levels | 2 to **10**. 11 returned HTTP 400 `Too many score levels. Must have at most 10 levels.` | api.md; probed |
| Questions per request | **Not documented; bounded only by tokens.** Probed: 100 Nouls took 322 ms (1,963 input tokens), 300 took 408 ms (5,563), **600 took 487 ms (10,963), all HTTP 200**. The function-calling cookbook uses 54 questions per call. | probed |
| Context | 64k tokens per request (state plus all questions). 32k for state plus the single longest question. | models.md |
| Input | Text only: a string, JSON object, or array of text values | models.md |
| Rate limits | 250,000 tokens/s and 1,200 requests/min per account. Over either limit returns 429. **"Limits are adjusting dynamically… can change without notice."** | models.md |
| Pricing | **$0.042 per million input tokens. Output tokens are free.** | models.md; parallel_questions uses `PRICE=(0.042, 0.00)` |
| Latency (docs) | "Most queries complete in about 100 ms". The consistency cookbook measured a 114 ms mean round trip. | how-to-build, consistency_choice |
| Latency (measured here, Windows dev box) | Plan call (7 to 11 questions): **306 to 678 ms** run sequentially, **780 to 985 ms** with 12 calls concurrent. Chart call: **320 to 390 ms**. A 255-option Choice took 696 ms; output tokens grow roughly with option count. | probed |
| Errors | 401 bad key, 422 validation (400 observed), 429 rate limit, 529 overloaded. Retry with backoff and honour `retry-after`. | api.md |
| Cost per NL question | Plan call is about 1.4k to 1.9k input tokens; chart call about 0.5k to 0.7k. That is about **$0.0001 per question**. | probed |

## 2. JS SDK and raw HTTP

**SDK: `@typesafe-ai/sdk` 0.6.0** (MIT). v0.6.0 made a breaking change: Score criteria are now an ordered array, not a dict. The SDK **runs in Cloudflare Workers**:
- `dist/index.mjs` has **no imports at all**. It uses only `globalThis.fetch`, `AbortController`, `setTimeout`, `Response.clone().body.getReader()` and `Headers`.
- It detects Workers explicitly: `index.mjs:383` `if (g.navigator?.userAgent === "Cloudflare-Workers") return "cloudflare-workers";`.
- `engines.node >= 20` is advisory only.
- It reads `process.env` only behind a `typeof process === "undefined"` guard (`index.mjs:65-68`), so in a Worker **pass `apiKey` explicitly** from `env`.
- It refuses to run in a browser unless `dangerouslyAllowBrowser` is set (`index.mjs:376`, `refuseBrowser`). Keep all calls in the Worker.
- **Defaults** (`index.mjs:73-88`, `:518`): timeout 10,000 ms per attempt and `maxRetries: 2` on 408, 429 and 5xx. Backoff starts at 500 ms, caps at 5 s, and honours `retry-after`/`retry-after-ms` up to 60 s. These are too slow for an interactive UI. shapeshift uses `timeout: 2500, retry: { maxRetries: 0 }` (`shapeshift/src/lib/jev/client.ts:33-40`).

Signatures (`index.d.mts`):
```ts
new TypeSafeClient({ apiKey?, baseURL?, defaultModel?, logLevel?, logger?, retry?: Partial<RetryPolicy>, timeout?, defaultHeaders?, dangerouslyAllowBrowser?, fetch? })
client.systemOne<const Q extends Questions>({ state: EntryType, questions: Q, model?: string }, { signal?, timeout?, retry?, headers? }): APIPromise<SystemOneResult<Q>>  // .withResponse() gives requestId
choice(instructions: EntryType, criteria: Record<string, EntryType>)   // throws if criteria is an array
noul(instructions?: EntryType, criteria?: { true?: EntryType; false?: EntryType } | null)
score(instructions: EntryType, criteria: readonly [EntryType, EntryType, ...EntryType[]]) // dynamic string[] needs `as unknown as ScoreCriteria`
// EntryType = string | object | array | null  (instructions and option descriptions may be structured JSON)
```
Error classes exported: `APIError` (`.status`, `.body`, `.requestId`), `RateLimitError` (`.retryAfterMs`), `APITimeoutError`, `APIConnectionError`, `APIUserAbortError`, `UnprocessableEntityError`.

Worker usage:
```ts
import { TypeSafeClient, APIUserAbortError } from "@typesafe-ai/sdk";
let jev: TypeSafeClient | undefined;
const getJev = (env: Env) => (jev ??= new TypeSafeClient({
  apiKey: env.TYPESAFE_API_KEY, defaultModel: env.JEV_MODEL ?? "jev-latest",
  timeout: 4000, retry: { maxRetries: 1 }, logLevel: "warn" }));
const res = await getJev(env).systemOne({ state, questions }, { signal: request.signal });
```
Raw HTTP, with no dependency. I verified the SDK's exact wire body using a stub fetch: an undefined Noul `criteria` is simply omitted.
```ts
async function systemOne(env: Env, body: { state: unknown; questions: Record<string, unknown> }, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model: env.JEV_MODEL ?? "jev-latest", ...body }), signal });
    if (res.ok) return (await res.json()) as { model: string; answers: Record<string, any>; usage: { input_tokens: number; output_tokens: number } };
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500; // 529 = overloaded
    if (!retryable || attempt >= 1) throw new Error(`jev ${res.status}: ${await res.text()}`);
    const ra = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400));
  }
}
```
Request JSON shape: `{ state, model, questions: { id: { type: "choice", instructions, criteria: {opt: desc|null} } | { type: "noul", instructions, criteria?: {true, false} } | { type: "score", instructions, criteria: [lvl0, lvl1, ...] } } }`. `GET /v1/models` returns `{ models: [{ name, description, release_date }] }`.

**Reuse from shapeshift:**
- `src/lib/jev/client.ts:18-22` `classifierMode()`: offline mode when there is no real key, via the `looksLikeKey` heuristic at lines 11-15.
- `src/lib/jev/client.ts:44-46` `answer()`: normalises a Choice into `{value, confidence, probabilities}`.
- `src/lib/jev/client.ts:49-77`: one call with every question, plus latency logging.
- `src/app/api/intent/route.ts:8-40`: LRU cache, abort returns 499, any failure falls back without flashing the UI.
- `src/lib/jev/questions.ts:1-102`: all questions in one constants file, each with an escape option. This matches the agent-skill doc: "Put the constants (questions and thresholds) in a single place."

## 3. Answer shapes

- **Choice**:
  - `{ type:"choice", choice, probabilities: {opt: p}, confidence }`.
  - Probabilities sum to 1, so **some option always wins**. Add a `none`/`not_stated` escape option.
  - `confidence` measures how peaked the distribution is: 1.0 when all mass is on one option, and low when it is split. For example, 0.61/0.35/0.04 gives confidence 0.42.
- **Score**: `{ type:"score", score (probability-weighted, can fall between levels), legend: {"0": desc}, probabilities: {"0": p}, confidence }`. Do not interpolate numbers from `score` (jaggedness doc).
- **Noul**: `{ type:"noul", noul: P(yes) }`. It has no confidence field; 0.5 means undecided.
- **Envelope**: `{ model: "jev-1.13.0", answers: {id: ...}, usage: { input_tokens, output_tokens } }`.
- Question ids are **not** sent to the model. **Choice option keys and their descriptions are both sent**, so make keys readable (for example `revenue` or `tracks.milliseconds`).
- Questions are independent and run in parallel. Answers do not see each other.
- Do not assume consistency between different questions: a Noul and a yes/no Choice asking the same thing are not comparable (jaggedness section 8).

## 4. Recommended decomposition for NL -> SQL -> chart

**Principle: Jev never sees or writes SQL.** Code builds catalogs from the schema, and each catalog becomes a Choice whose options are allow-listed query parts. Jev picks the parts. Code then:
- validates the combination;
- resolves joins over the FK graph with a BFS shortest path;
- emits parameterised SQL;
- runs it;
- calls Jev once more to pick a chart from the chart types code considers valid for the result.

This is the "segments of SQL" idea from the user request.

Cookbook basis:
- **function_calling**: a `__tool__` Choice plus one Choice per closed-set argument, a `stated?` Noul or `not_stated` option for optional arguments, and one Noul per member for set arguments. The call's confidence is the **minimum** over the judgments it used. This maps to measure, group_by, time_grain, sort and limit.
- **pre_parsed_value_extraction**: a regex or value index finds candidates, Jev picks one, code copies the value verbatim, and every pick has a `none` escape. This covers filter values and limit numbers.
- **fan-out / primitives**: ask every question, including speculative ones, in one call and let code ignore the irrelevant ones. In the parallel_questions cookbook this was 12.2x cheaper and 10x faster than one call per question.
- **semantic_find**: a Choice always picks something, so pair it with a Noul existence check. Here that is `in_scope`.
- **skill_suggestion**: two requests (rank wide, then re-check the shortlist with richer evidence), gated by Nouls at a 0.30 threshold. This is the pattern for big uploaded schemas.
- **hierarchical_classification / primitives_advanced "Walking a taxonomy"**: route table first, then column, with beam search K=3 over Choice probabilities (beam matched 4/4 cases, greedy 2/4). Option values can embed the subtree, for example a table's columns.
- **date_extraction**: date parts are Choices over enumerated values with a "not stated" option, and arithmetic stays in code. Use this for year filters and relative periods.
- **jaggedness doc**: no math, counting or date comparison in Jev, and send small, relevant state. Numeric thresholds are pre-parsed and compared in code.

### Call 1: plan (one request, 9 to 12 questions)
State (keep it small; candidates go in the criteria): `{ question, dataset: { name, about, contains: [...] } }`.

| id | primitive | options (all derived from schema or code) | used when |
|---|---|---|---|
| `in_scope` | Noul | "Is `question` asking for information that is recorded in `dataset`?" | always (gate) |
| `answer_kind` | Choice | `aggregate` / `rows` / `unanswerable` | always |
| `measure` | Choice | Catalog of measures (curated for bundled datasets, `{what, examples}`) plus `none` | aggregate |
| `group_by` | Choice | Dimensions (≤255) plus `none` ("…a value used only as a filter does not count as grouping") | aggregate |
| `time_grain` | Choice | `none/year/quarter/month/weekday` | aggregate (x = time) |
| `sort` | Choice | `desc/asc/chronological/none` | always |
| `limit` | Choice | `n<k>` for each number found by regex or number words, plus `one` and `not_stated` | ranking |
| `row_table` | Choice | Tables plus `none` | rows |
| `sort_column` | Choice | Sortable columns (numeric or date) plus `none` | rows |
| `filter:<id>` | Choice, one per pre-parsed value | `include_only` / `exclude` / `not_a_filter` | always |
| (optional) `named_chart` | Choice | `none/bar/line/pie/table/scatter` | chart override |

Filter candidates come from code. For bundled datasets, build a value index of distinct values in low-cardinality text columns (for example genres, countries, media types and artists). Match 1- to 4-gram tokens of the question against it case-insensitively, with light fuzziness. Add regex hits for years (`\b(19|20)\d\d\b`), numbers and number words. For each hit, create one `filter:<id>` Choice that carries the value and field label in structured instructions. This handles multiple values (Jazz and Metal become an IN list) and negation ("excluding rock" came back as `exclude` at 1.00).

**Live results with the final wording** (`probe2.mjs`). All 12 prompts produced the correct plan:
- "total sales of rock music in Brazil" → aggregate/revenue, group_by `none` 0.98, Rock=include_only 0.99, Brazil=include_only 0.98.
- "monthly revenue in 2012" → revenue, time=month, 2012=include_only 1.00.
- "show me the longest tracks" → rows 1.00, row_table=tracks 1.00, sort_column=tracks.milliseconds 1.00, sort=desc.
- "list albums by AC/DC" → rows 0.99, albums 0.99, AC/DC=include_only 0.99.
- "which customers spent the most" → aggregate 0.84 (rows 0.16), revenue, group_by=customer 0.79.
- "top ten artists by tracks sold" → units_sold 1.00, artist 0.93, limit n10 1.00.
- "compare jazz and metal sales by year" (round 1 wording) → revenue, genre, year, Jazz and Metal both include_only.
- "what's the weather in Paris tomorrow?" and "who is the president of France" → in_scope 0.01, unanswerable 1.00; the France filter came back as not_a_filter 0.95.

Lessons from round 1 (the old wording):
1. A 7-way "shape" Choice was unreliable. "monthly revenue in 2012" came back single_value 0.67 against trend 0.27. **Derive the chart shape in code** from `time_grain`, `group_by` and row count; keep only the 3-way `answer_kind`.
2. "Which category should the answer be grouped by?" confused filters with grouping (genre 0.45 against country 0.34). The explicit "separate result for each value… a filter does not count" wording fixed it (none 0.98).
3. The in-scope Noul was weak as "Can `question` be answered using only the data described in `dataset`?" with a string dataset (0.49 to 0.61 on valid questions). Rewording it to "Is `question` asking for information that is recorded in `dataset`?", with a structured `{name, about, contains[]}`, raised valid questions to 0.69 to 0.98 and kept out-of-scope at 0.01.
4. Running round 1 twice gave nearly identical probabilities (self-consistent).

Code composition after call 1 (deterministic):
- aggregate → `SELECT dims, <measure sql> ... GROUP BY`.
- Drop `group_by` when its column is also a single-value `include_only` filter.
- `time_grain` ≠ none → x = time bucket (strftime or date_trunc); `group_by` then becomes the series, limited to the top 6.
- `limit`: `n<k>` → k; `one` → 1; `not_stated` → 10 for rankings, otherwise a 500-row cap.
- `sort` defaults: measure desc for categories, chronological for time.
- rows → `SELECT` the catalog's display columns of `row_table`, `ORDER BY sort_column`, default limit 50.
- Ignore answers on branches that are not in use; that is the fan-out pattern.
- Identifiers come only from the catalog; values are always bound parameters.
- Save the typed plan JSON (not only the SQL) on every pinned dashboard card. A refresh re-runs SQL without asking Jev again.

### Big or uploaded schemas: two stages
Stay single-call while every Choice fits in 255 options and state plus the longest question stays well under 32k tokens (about 20 tables and 150 columns). For uploads:
- **Measures**: split the measure into `measure_column` (numeric columns plus `rows_of:<table>` count options) and `aggregation` (`sum/avg/min/max/count/count_distinct`). Code rejects invalid pairs such as SUM of an id. Auto-describe options as `{what: humanised name, table, examples: 3 sample values}`.
- **Stage A (route)**: a `subject_table` Choice over tables, with each option value `{what, columns:[first ~15], rows}` (the "walking a taxonomy" pattern). Add a speculative `needs:<table>` Noul per table, plus `in_scope` and `answer_kind`.
- **Stage B (plan)**: the call-1 plan, restricted to columns of the top K (2 to 3) subject tables and tables within 2 FK hops. Run the K candidates **in parallel** as a beam (hierarchical cookbook) and keep the plan with the highest minimum used-slot confidence (or geometric mean).
- Stage A is justified as a second request because its answer decides the next call's options (primitives.md "When one question depends on another").

### Call 2: chart choice (after SQL runs)
State: `{ question, result: { row_count, columns: [{name, kind: time|category|series|amount|text, distinct?, unit?, grain?}], first_rows: ≤8 } }`.

**Code first computes the eligible chart types** from the hard rules below; Jev then only ranks among those. A separate call is justified because the state (the result profile) exists only after SQL runs.
- kpi: 1 row, 1 amount.
- line, area, bar: time x; multi_line and grouped_bar when there are 2 or more series.
- bar and hbar: category x.
- donut: 8 rows or fewer, with an additive, non-negative amount.
- scatter: 2 or more amounts.
- histogram: 1 amount over more than 20 rows.
- table: always.
- Suggested addition: hbar for rows that have one label and one amount.

Live results: all 8 cases were sensible:
- "how many tracks" → kpi 0.99.
- "monthly revenue 2012" → line 0.95.
- "genres most money" (24 rows) → hbar 0.95.
- "share of sales by media type" → donut 1.00.
- "pie chart of revenue by genre" → donut 1.00, named_chart=pie 1.00.
- "jazz vs metal by year" → multi_line 0.71 against grouped_bar 0.28.
- "customers per country" (24 rows) → hbar 0.83.
- "longest tracks" → table (the only eligible type).

Order the UI's chart-switcher by these probabilities.

### Example question definitions (exact SDK format)
```ts
import { choice, noul } from "@typesafe-ai/sdk";

export const inScope = noul("Is `question` asking for information that is recorded in `dataset`?", {
  true: "It asks about sales, customers, employees, or the music catalog described in `dataset`",
  false: "It asks about something `dataset` does not record, or it is not a question about data",
});

export const measure = (catalog: Record<string, string | { what: string; examples?: string[] }>) =>
  choice("Which amount does `question` ask to calculate?", { ...catalog, none: "No amount is calculated" });
// e.g. { revenue: { what: "Money earned from sales", examples: ["most money","sales","revenue","earnings"] },
//        invoice_count: "Number of invoices, orders or purchases", units_sold: { what: "Number of track copies sold", examples: ["tracks sold","units","downloads"] }, ... }

export const groupBy = (dims: Record<string, string>) =>
  choice("Does `question` ask for a separate result for each value of a category (by, per, each, which, top N)? If so, which category?",
    { ...dims, none: "One combined result for everything; a value used only as a filter does not count as grouping" });

export const filterUse = (c: { value: string; label: string }) =>
  choice({ value: c.value, field: c.label, question: "How does `question` use `value`?" }, {
    include_only: `Only rows where the ${c.label} is ${c.value} should be counted`,
    exclude: `Rows where the ${c.label} is ${c.value} should be left out`,
    not_a_filter: `${c.value} is mentioned but should not restrict the rows`,
  });

export const limit = (nums: string[]) => choice("How many results does `question` ask to show?", {
  ...Object.fromEntries(nums.map((n) => [`n${n}`, `The number ${n} as written in the question`])),
  one: "Only the single top or bottom item, e.g. which genre sells the most",
  not_stated: "The question does not say how many",
});

export const chart = (eligible: Record<string, string>) =>
  choice("Which chart best answers `question` using `result`?", eligible);
// CHARTS = { kpi: "One big number with a label", bar: "Vertical bars comparing one amount across a few categories",
//   hbar: "Horizontal bars ranking categories, good for many categories or long names", line: "A line showing how an amount changes over time",
//   area: "A filled area showing a running or cumulative amount over time", donut: "A ring split into slices showing each category's share of a whole, for up to about 6 categories",
//   grouped_bar: "Bars for two or more series side by side within each category or period", multi_line: "One line per series over time, to compare trends",
//   scatter: "Dots placing each item by two different amounts, to show a relationship", histogram: "Bars counting how many items fall in each range of one amount",
//   table: "A plain table of individual records with several fields" }

// call: const res = await jev.systemOne({ state: { question, dataset }, questions: { in_scope: inScope, measure: measure(M), group_by: groupBy(D), limit: limit(nums), ...filters } });
```
Also in the final set: `answer_kind` (aggregate / rows / unanswerable), `time_grain`, `sort`, `row_table` and `sort_column`.

## 5. "Did you mean" and "unanswerable"

**Plan confidence**: the minimum confidence over the slots the compiled plan actually uses (function_calling cookbook). Ignore unused speculative slots, per the skill guidance: "Ignore uncertainty on unused branches."

**Did you mean** (the typed plan is already in hand, so these need no extra Jev call):
- For each used slot (measure, group_by, time_grain, answer_kind, each filter), take the runner-up option.
- If its probability is at least 0.15 (or runner-up/top is at least 0.25), build an alternative plan with that one slot swapped.
- Rank alternatives by runner-up probability and show up to 2 chips, labelled from the catalog, for example "Revenue by country instead of genre".
- Clicking a chip compiles and runs the alternative directly.

Observed candidates:
- group_by genre 0.43 / country 0.37 (round 1);
- answer_kind aggregate 0.84 / rows 0.16 ("which customers spent the most" → "show individual invoices");
- measure none 0.81 / track_minutes 0.19;
- chart multi_line 0.71 / grouped_bar 0.28, which becomes the chart toggle.

Charts are low-stakes and reversible. Use a 0.5 confidence floor for the "Jev wasn't sure" badge (confidence.md). The consistency cookbook treats a top probability below 0.60 as `uncertain`.

**Unanswerable**, following semantic_find (Choice plus existence Noul) and skill_suggestion (a Noul gate at 0.30):
- **Out of scope**: `in_scope.noul < 0.3` **or** `answer_kind.probabilities.unanswerable ≥ 0.5`. Show "That isn't in this dataset", the Try chips, and a link to the explorer. Probed: 0.01 for out-of-scope prompts, 0.69 or more for valid ones.
- **Grey zone** (in_scope between 0.3 and 0.6): run the query, but show the low-confidence badge and the chips.
- **No catalog match**: `answer_kind=aggregate` but `measure=none` with p ≥ 0.6. Fall back to `COUNT(*)` of `row_table` (or a rows view) and offer the top 2 non-none measures as "Did you mean".
- **Empty result**: code handles this, not Jev, for example "No rows for Rock in Brazil".
- **Service failure** (429, timeout): use the cached plan for Try prompts or an offline heuristic, as in shapeshift's `mockClassify` fallback.
- Never compare `in_scope` and `answer_kind` numerically as if they were the same quantity (jaggedness section 8). Threshold each on its own.

## 6. Delivery notes
- Precompute plans and charts for every Try prompt at build time, so the demo chips cost 0 calls and still work if Jev is down. Cache live plans by `(dataset_id, normalised question)` in the Cache API or KV.
- Add per-IP rate limiting in the Worker. One shared key has a 1,200 RPM account limit, and that limit is dynamic.
- Uploaded data values go into the criteria and can at most sway which option wins; the SQL is still built only from allow-listed parts. Still use bound parameters and a read-only SQL engine with a row cap and a timeout.
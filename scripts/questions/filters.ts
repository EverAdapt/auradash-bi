/**
 * OWNER: implementer A (filters). v0.2 feature questions for `bun scripts/plan-cli.ts --v02
 * filters`. At least 3 questions per feature, across at least two datasets, each with an `expect`
 * regex proving the feature fired in the compiled SQL. Plus plain questions with `reject` proving
 * nothing fires spuriously. Every question here was hand-verified live against Jev while building
 * the feature (see the final report) — Jev is slightly non-deterministic, so an occasional single
 * flake here is expected; re-run it before assuming a regression.
 */
import type { V02Question } from "./types"

export const QUESTIONS: V02Question[] = [
  // ─────────────────────────── year before / after (strict, unlike from/until) ───────────────────────────
  { dataset: "nobel", q: "Nobel prizes awarded before 1950", expect: [/ < \?/] },
  { dataset: "afl", q: "Grand finals before 1990", expect: [/ < \?/] },
  { dataset: "afl", q: "The Grand Final after 2010", expect: [/ > \?/] },

  // ─────────────────────────── year range: "between A and B" (continuous span) ───────────────────────────
  { dataset: "nobel", q: "Prizes awarded between 1950 and 1970", expect: [/BETWEEN \? AND \?/] },
  { dataset: "world", q: "GDP per person between 1990 and 2000", expect: [/BETWEEN \? AND \?/] },
  { dataset: "afl", q: "Grand finals between 1990 and 2000", expect: [/BETWEEN \? AND \?/] },

  // ─────────────────────────── relative period: "within", anchored to the data's own latest value ───────────────────────────
  { dataset: "world", q: "Life expectancy in the last 10 years", expect: [/> \(SELECT MAX/] },
  { dataset: "nobel", q: "Prizes awarded in the last 20 years", expect: [/> \(SELECT MAX/] },
  { dataset: "swift", q: "Songs released in the last 5 years", expect: [/> \(SELECT MAX/] },

  // ─────────────────────────── threshold -> WHERE (a record field, not the aggregate) ───────────────────────────
  { dataset: "world", q: "Countries with a population over 100 million", expect: [/ > \?/] },
  { dataset: "swift", q: "Songs longer than 5 minutes", expect: [/ > \?/] },
  { dataset: "afl", q: "Matches with a margin over 100 points", expect: [/ > \?/] },

  // ─────────────────────────── threshold -> HAVING (the calculated amount per group) ───────────────────────────
  { dataset: "nobel", q: "Which categories have more than 200 laureates?", expect: [/HAVING/] },
  { dataset: "nobel", q: "Which countries have won more than 50 prizes in total?", expect: [/HAVING/] },
  { dataset: "world", q: "Which income groups have more than 3 billion people?", expect: [/HAVING/] },
  { dataset: "afl", q: "Which decades had more than 300 matches with a margin over 50?", expect: [/HAVING/, / > \?/] },

  // ─────────────────────────── text search (quoted contains, "starting with") ───────────────────────────
  { dataset: "nobel", q: "Laureates with 'Curie' in their name", expect: [/LIKE \? ESCAPE/] },
  { dataset: "afl", q: "Venues starting with M", expect: [/LIKE \? ESCAPE/] },
  { dataset: "swift", q: "Songs containing 'story' in the title", expect: [/LIKE \? ESCAPE/] },

  // ─────────────────────────── missing data -> IS NULL ───────────────────────────
  { dataset: "nobel", q: "Laureates with no birth country recorded", expect: [/IS NULL/] },
  { dataset: "world", q: "Countries with no internet usage data recorded", expect: [/IS NULL/] },
  { dataset: "afl", q: "Which clubs have no retirement year recorded?", expect: [/IS NULL/] },

  // ─────────────────────────── rank window -> OFFSET ───────────────────────────
  { dataset: "world", q: "Countries ranked 11 to 20 by population", expect: [/OFFSET 10/] },
  { dataset: "nobel", q: "Countries ranked 11 to 20 by laureates born there", expect: [/OFFSET 10/] },
  { dataset: "world", q: "Top 10 countries by population, then the next 10", expect: [/OFFSET 10/] },

  // ─────────────────────────── combine "either" -> one OR-ed WHERE clause ───────────────────────────
  { dataset: "nobel", q: "Physics laureates or women", expect: [/ OR /] },
  { dataset: "nobel", q: "Laureates who are either from France or won a peace prize", expect: [/ OR /] },
  { dataset: "afl", q: "Matches involving Richmond or played at the MCG", expect: [/ OR /] },

  // ─────────────────────────── exclude keeps NULL rows (v0.1 SQL intentionally changes — see the final report) ───────────────────────────
  { dataset: "nobel", q: "Prizes by category excluding literature", expect: [/<> \? OR/] },
  { dataset: "nobel", q: "Prizes excluding physics and chemistry", expect: [/NOT IN \(\?, \?\) OR/] },

  // ─────────────────────────── share (the plan's `share` spec; B's compile.ts turns it into SQL) ───────────────────────────
  { dataset: "nobel", q: "What share of laureates are women?" },

  // ─────────────────────────── plain questions: no v0.2 feature should fire spuriously ───────────────────────────
  { dataset: "nobel", q: "Physics laureates by decade", reject: [/HAVING/, /LIKE \? ESCAPE/, /IS NULL/, / OR /, /OFFSET/] },
  { dataset: "world", q: "Population of Nigeria", reject: [/HAVING/, /LIKE \? ESCAPE/, /IS NULL/, / OR /, /OFFSET/] },
  { dataset: "afl", q: "Which clubs have played in a grand final?", reject: [/HAVING/, /LIKE \? ESCAPE/, /IS NULL/, / OR /, /OFFSET/] },
  { dataset: "swift", q: "Which album has the most tracks?", reject: [/HAVING/, /LIKE \? ESCAPE/, /IS NULL/, / OR /, /OFFSET/] },
]

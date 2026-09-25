/**
 * OWNER: implementer C (agnostic). v0.2 feature questions for `bun scripts/plan-cli.ts --v02
 * agnostic`, proving the generic plan-rule engine (src/lib/plan/rules.ts) reproduces the old
 * per-dataset hooks from data — and that FK-role questions resolve through the column synonyms
 * now carried in the semantic layer (src/lib/plan/graph.ts's `fkRoleGroupFor`), not a hard-coded
 * English list. `expect` regexes match against the compiled, PARAMETERISED sql (compile.ts's
 * `CompiledQuery.sql`, `?` placeholders — not `displaySql`), so they only ever assert on column /
 * table names, never on a bound value.
 */
import type { V02Question } from "./types"

export const QUESTIONS: V02Question[] = [
  // ── Nobel: require_filter "people only" (laureates.kind = 'person') ──
  {
    dataset: "nobel",
    q: "How many laureates are there by gender?",
    // groupBy = laureates.gender (PERSON_ONLY's first alternative) -> requires kind='person'
    expect: [/"kind" = \?/],
  },
  {
    dataset: "nobel",
    q: "Which countries were the most laureates born in?",
    // groupBy = laureates.birth_country_code (PERSON_ONLY's "birth_" alternative) -> requires
    // kind='person', whichever of the "laureates"/"prizes won" measures Jev happens to pick
    expect: [/"kind" = \?/],
  },
  {
    dataset: "nobel",
    q: "List the laureates who won in physics",
    // rowTable = "laureates" (a bare table name, never itself a PERSON_ONLY match) -> no person filter
    reject: [/"kind" = \?/],
  },

  // ── Nobel: require_filter "awarded prizes only" (prizes.is_awarded = 1) ──
  {
    dataset: "nobel",
    q: "List every prize awarded in physics",
    // rowTable = "prizes" -> requires is_awarded = 1
    expect: [/"is_awarded" = \?/],
  },
  {
    dataset: "nobel",
    q: "How many laureates are there in total?",
    // measure counts laureates, not prizes -> no is_awarded filter
    reject: [/"is_awarded" = \?/],
  },

  // ── World: region / income grouping reads aggregate_year (never averages country_year) ──
  {
    dataset: "world",
    q: "Which region has the highest life expectancy?",
    // "kind" may bind via this rule's own filter (= ?) or a value candidate Jev matched directly
    // on "region" (IN (?)) — either way proves the region breakdown reads aggregate_year/aggregates,
    // never an average over country_year.
    expect: [/aggregate_year/, /"kind"/],
  },
  {
    dataset: "world",
    q: "Fertility rate by income group",
    expect: [/aggregate_year/, /"kind"/],
  },
  {
    dataset: "world",
    q: "Population of Australia",
    // a single-country lookup never reroutes to the rollup table
    reject: [/aggregate_year/],
  },

  // ── World: a plain total reads the World row (aggregate_year.aggregate_code = 'WLD') ──
  {
    dataset: "world",
    q: "What's the world population right now?",
    expect: [/aggregate_year/, /"aggregate_code" = \?/],
  },

  // ── World: no year stated -> default to the measure's latest well-covered year ──
  {
    dataset: "world",
    q: "Which countries have the highest life expectancy?",
    expect: [/"year" = \?/],
    reject: [/aggregate_year/],
  },
  {
    dataset: "world",
    q: "Top 5 countries by internet users",
    expect: [/"year" = \?/],
  },

  // ── World: relationship chart adds bubble size (population) and colour (region) ──
  {
    dataset: "world",
    q: "Is there a relationship between income and life expectancy across countries?",
    expect: [/AS "population"/, /AS "region"/],
  },
  {
    dataset: "world",
    q: "Does more internet access go with lower infant mortality?",
    expect: [/AS "population"/, /AS "region"/],
  },

  // ── AFL: FK-role resolution relies on the FK columns' own catalog synonyms, not a hard-coded list ──
  {
    dataset: "afl",
    q: "When did Fremantle last win a grand final?",
    // Fremantle has never won a grand final (0 rows is the correct answer for the WINNER role
    // specifically — the UI's fallback widens to "any role" and finds the 2013 loss, but that's
    // a separate, later query); the point here is that "win" resolves through winner_club_id
    // and not some other role.
    expect: [/winner_club_id/],
    minRows: 0,
  },
  {
    dataset: "afl",
    q: "When was Fremantle last a grand final runner-up?",
    expect: [/loser_club_id/],
  },
  {
    dataset: "afl",
    q: "How many home games has Richmond played?",
    expect: [/home_club_id/],
  },
  {
    dataset: "afl",
    q: "How many away games has Essendon played?",
    expect: [/away_club_id/],
  },
  {
    dataset: "afl",
    q: "How many venues have hosted a grand final?",
    // no named club value at all -> no role/FK-column resolution of any kind
    reject: [/winner_club_id/, /loser_club_id/, /home_club_id/, /away_club_id/],
  },
]

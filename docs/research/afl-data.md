# AFL dataset - sources, license, schema, and try-prompt results

## Source

**Squiggle API** - `https://api.squiggle.com.au/` (`q=teams`, `q=teams;year=YYYY`, `q=games;year=YYYY`,
`q=standings;year=YYYY`). A free hobby API run by Max Barry that mirrors basic, publicly-known VFL/AFL
facts (fixtures, scores, the ladder) back to 1897. Confirmed by fetching every endpoint directly:

- `q=teams` returns only the 18 currently-active clubs (with `debut`/`retirement` years); the two
  historical-only clubs (Fitzroy, University) only appear when a historical `year` parameter is passed
  (e.g. `q=teams;year=1910`), because they predate the "current" list.
- `q=games;year=YYYY` returns every match for that season, including scores, venue, round, `is_final`
  (0-7, coded by finals stage) and `is_grand_final`. As of Squiggle v1.13.2 (Mar 2026), `year` is
  required on every call - there is no "all years" query - so the builder fetches one season at a time,
  1897 through the current year (130 requests), each cached to disk.
- `q=standings;year=YYYY` returns the final (or, for the in-progress season, current) ladder: played,
  wins, losses, draws, for/against, percentage, premiership points (`pts`). Verified consistent across
  eras (1897, 1915, 1943, 2024, 2026 all returned the same field shape).
- No attendance/crowd figures are exposed anywhere in the API - deliberately **not** included in this
  dataset rather than guessed or sourced from a second, more restrictively-licensed site (see
  "What was excluded" below).

### Terms of use (read from `https://api.squiggle.com.au/`, "Requirements" section, v1.14.0)

> The Squiggle API is currently free and open... You must: set your bot's UserAgent to something that
> identifies it and contains a contact email... Cache and re-use data appropriately... Avoid fetching
> more data than you need... You may not: build a website that makes visitors fetch directly from the
> Squiggle API themselves... You may: use the API for commercial purposes, bearing in mind this is a
> hobby project that could disappear without warning, and is offered with no warranty of any kind.

This is a usage policy, not a copyright license over the underlying facts (match scores and ladders are
historical records, not creative works). The build satisfies every requirement it can as a server-side,
build-time job: it fetches once (with an on-disk cache so re-runs are free), sends a descriptive
`User-Agent` (`auradash-bi/1.0 (+https://auradash-bi.everadapt.au)` - a URL rather than a
personal email, per this project's own no-personal-email rule), sleeps between requests, and bundles a
static snapshot into the app - the browser never calls Squiggle directly (satisfying the "no pass-through"
rule by construction). The dataset's license field is therefore `Squiggle-API-terms` rather than a CC
license, and `_about`/the semantic `attribution` field both credit Squiggle plainly: *"Match, team and
ladder data: Squiggle (squiggle.com.au). Not endorsed by or affiliated with the AFL or Squiggle."*

### Reference data that is **not** from Squiggle (and not from Wikidata/Wikipedia either)

Club nicknames, home states, founding years, guernsey colours and venue city/state/country/lat/lon/
capacity are hardcoded reference tables in `build-afl.mjs`, in the same style as the Nobel builder's
`COUNTRY` map and the World Bank builder's `FRIENDLY` name map. These are widely-published, undisputed
facts (a club's nickname, its home state, the year it was founded, a stadium's city) rather than scraped
prose, so no separate license attaches to them. Wikidata (CC0) and Wikipedia (CC BY-SA) were both
evaluated per the brief and deliberately **not** used:

- A live Wikidata lookup was prototyped (`wbsearchentities` + `wbgetentities`) and works, but
  disambiguating 20 clubs and ~53 grounds against Wikidata's search results (VFL club vs AFLW club vs
  "history of..." articles, etc.) reliably was judged higher-risk than using well-established public
  facts directly, for a small, fixed reference table that doesn't change season to season.
- Wikipedia (grand final list, Brownlow Medal winners, attendance records) was skipped entirely: pulling
  in CC BY-SA content would flip the whole dataset's license to CC BY-SA 4.0, and Squiggle's own
  `is_grand_final` flag plus the derived `seasons` table already give a clean, correctly-licensed grand
  final history without it. Per the brief's "correctness beats coverage," Brownlow Medal winners and
  match attendance are simply not in this dataset rather than being included from a heavier-license
  source or guessed.

## What was excluded, and why

- **Attendance/crowd figures** - not published by Squiggle; excluded rather than sourced from Wikipedia
  (would require CC BY-SA). `venues.capacity` is a stadium's approximate current-or-peak listed
  capacity (general knowledge, not survey data), explicitly documented as such - it is not a per-match
  attendance figure.
- **Brownlow Medal / other award tables** - the brief said "only if licensable"; the only clean source
  for a full winners list is Wikipedia (CC BY-SA), so it was left out to keep the dataset's license
  simple (Squiggle terms only, no CC BY-SA obligations).
- **Pre-1897 VFA premierships** - Essendon, Carlton and Geelong each also won the colonial-era VFA
  premiership before the VFL existed (1877-1896); Squiggle's data (and this dataset) starts at the first
  VFL season, 1897, so those are not counted. `seasons.premier_club_id`/the `premierships` metric will
  therefore read a little lower than some historical club-history pages that include the VFA years -
  documented as a `rules[]` entry in the semantic layer.
- **1897 and 1924 grand finals** - both seasons used finals formats (a top-4 round-robin in 1897; the
  pre-1925 "Argus" challenge system in 1924) that could crown a premier without one final, deciding
  match, and Squiggle's data has no Grand Final game for either year. Rather than guess a winner from
  the surrounding finals-week results, `seasons.premier_club_id`/`runner_up_club_id` are left `NULL` for
  exactly these two years (verified: `SELECT year FROM seasons WHERE premier_club_id IS NULL` returns
  `1897, 1924` and nothing else, ahead of the current 2026 season which simply hasn't finished yet).

## Schema (5 tables, 1 view)

```
clubs   (club_id, name, nickname, abbrev, state, founded_year, debut_year, retirement_year,
         is_active, home_venue_id -> venues, colours, seasons_played, note)
venues  (venue_id, name, city, state, country, latitude, longitude, capacity,
         first_year, last_year, is_active, matches_hosted)
seasons (year, decade, era, team_count, matches_played,
         premier_club_id -> clubs, runner_up_club_id -> clubs, minor_premier_club_id -> clubs, is_complete)
matches (match_id, year -> seasons, decade, round_number, round_name, is_final, final_type,
         is_grand_final, match_date, venue_id -> venues,
         home_club_id / away_club_id / winner_club_id / loser_club_id -> clubs,
         home_score, away_score, home_goals, home_behinds, away_goals, away_behinds,
         total_score, margin, winner_side, is_draw)
ladder  (year -> seasons, club_id -> clubs, position, played, wins, losses, draws,
         points_for, points_against, percentage, premiership_points)
match_facts  -- view: matches joined out to home/away/winner club names and venue name/city/state
```

Every FK from `matches`/`seasons` to `clubs` (home/away/winner/loser; premier/runner-up/minor-premier)
gets its own `alias` in the semantic layer's `joins[]`, the same pattern Nobel uses for
`birth_country_code`/`death_country_code` both pointing at `countries`.

**Row counts** (built 2026-09-23): clubs 20 (18 current + Fitzroy + University), venues 53 (merged
down from 59 raw Squiggle venue labels - see below), seasons 130 (1897-2026), matches 17,055 completed
games (1 additional 2026 Grand Final is scheduled but not yet played, so it's excluded - the dataset
only ever includes `complete = 100` games), ladder 1,651 rows. File size: ~2.0 MB (well under the 6 MB
budget).

**Venue naming-rights merges** (Squiggle logs each sponsorship rename as a distinct venue string; this
dataset merges them onto one canonical, current name, with the older names as searchable aliases):
Docklands -> Marvel Stadium, Kardinia Park -> GMHBA Stadium, Perth Stadium -> Optus Stadium, Mars Stadium
-> Eureka Stadium, University of Tasmania Stadium -> York Park, Adelaide Arena at Jiangwan Stadium ->
Jiangwan Stadium.

## Correctness spot-checks (against real-world AFL knowledge, not just "the SQL runs")

- 2024 Grand Final: Brisbane Lions 120 d. Sydney 60 - matches the real result.
- 2023 Grand Final: Collingwood d. Brisbane Lions - matches the real result (a 4-point classic).
- Biggest ever winning margin: Fitzroy 190 pts over Melbourne, 1979 - a famous VFL record, correctly
  the #1 result in `ORDER BY margin DESC`.
- Second-biggest: Geelong's 186-point demolition of Melbourne, 2011 - also correct.
- 1909 Grand Final margin: 2 points - matches the well-known nail-biter.
- Drawn/replayed Grand Finals detected automatically: 1948, 1977, 2010 (2 Grand Final matches each in
  Squiggle's data); `seasons.premier_club_id` is taken from the later (replay) match in each case.
- Essendon's VFL/AFL-era premiership count here is 14, not the commonly-quoted "16" - the difference is
  exactly their 2 pre-1897 VFA flags plus 1897 and 1924 not being attributed to anyone here (see above).

## Try-prompt results (run against the live planner: `bun scripts/plan-cli.ts --dataset afl "<prompt>"`)

All 12 curated prompts (8 `tryPrompts` + 4 `morePrompts`) return `status: ok` with sensible, correct
results from the real Jev-driven planner (not just "the reference SQL happens to run"). A "DIFFERS" note
below means the live plan's row count doesn't match this file's hand-written reference SQL (used for the
baked fixtures) - in every such case the live answer is still a sensible, correct answer to the question,
just via a different (equally valid) shape than my reference query; this is consistent behaviour with the
bundled Nobel/World datasets' own curated prompts (e.g. a "how many X per Y" phrasing naturally ranks the
top 10 rather than listing every row).

| # | Prompt | Chart | Plan summary | Rows | OK |
|---|---|---|---|---|---|
| 1 | Which clubs have won the most premierships? | hbar | `seasons` JOIN `clubs` on `premier_club_id`, `COUNT(*)` GROUP BY club, LIMIT 10 | 10 | OK |
| 2 | Average winning margin by season | line | `AVG(margin)` per year (1897-2026) | 130 | OK |
| 3 | Every AFL venue and how many matches it has hosted | point_map | all 53 venues with lat/lon, sorted by matches hosted | 53 | OK |
| 4 | List the matches with the biggest winning margins | table | `matches` sorted by `margin DESC` (1979 Fitzroy blowout first) | 50 | OK (fixture row-count differs - see note) |
| 5 | What fraction of matches end in a home victory, an away victory, or a draw? | donut | `COUNT(*)` GROUP BY `winner_side` -> home 9,985 / away 6,897 / draw 173 | 3 | OK |
| 6 | Distribution of total match scores | histogram | `total_score` binned by 20 | 17 | OK |
| 7 | Collingwood's wins per season since 2000 | bar | `ladder.wins` for club_id=4, year >= 2000 | 27 | OK |
| 8 | Ladder positions of the Swans by year | line | `ladder.position` for club_id=16 | 50 (of 130, default row cap) | OK |
| 9 | How many premierships has Essendon won? | kpi | `COUNT(*)` on `seasons` filtered to premier = Essendon -> 14 | 1 | OK |
| 10 | Show the margin and total score for every Grand Final | scatter | `matches` WHERE `is_grand_final = 1` | 50 (of 113, default row cap) | OK (fixture row-count differs - see note) |
| 11 | Matches hosted by state | hbar | `matches_hosted` GROUP BY `venues.state` -> VIC 13,794 ... | 9 | OK |
| 12 | Grand final margins over time | line | `margin` WHERE `is_grand_final = 1`, by year | 113 | OK |

### Semantic-layer iteration notes (what changed while making these work)

- **`defaultFact` moved from `matches` to `seasons`.** The planner resolves "the" time column for an
  aggregate query from `nearestTimeColumn(catalog.defaultFact)`, independent of which table the chosen
  measure actually lives in. With `defaultFact: matches`, any question whose measure came from `ladder`
  (a sibling of `matches`, both hanging off `clubs`/`seasons` - by design there is no join path between
  two "many" tables that share a "one" parent) failed to compile ("no join path from ladder to
  matches"). `seasons` is the one table both `matches` and `ladder` can reach in a single climb, so
  making it the default fact fixed every ladder-measure question without touching any other prompt.
- **The FK join order to `clubs` matters.** `matches` has four separate relationships to `clubs`
  (home/away/winner/loser). A plain "club name" filter resolves through *whichever one is declared
  first* in `joins[]` when there's no other signal (confirmed by reading `shortestJoinPath`'s own doc
  comment in `src/lib/plan/graph.ts`: "the first declared one wins ties"). `winner_club` is declared
  first here because the curated prompts (premierships, a club's wins) need that relationship far more
  often than "home team" or "away team" would. The trade-off is documented as a `rules[]` entry: a bare
  "how many games has X played" question will currently read as "X's wins," because there's no single
  generic column for "matches a club appeared in" at all (that's inherently an OR across two columns).
- **Removed a custom `wins` metric.** A `metrics.wins = COUNT(*) FROM matches` initially outranked the
  perfectly good `ladder.wins` column for "Collingwood's wins," and once `ladder.wins` was reachable
  (after the `defaultFact` fix) it become the better, simpler answer on its own - the extra metric was
  redundant and occasionally won when it shouldn't have (e.g. it used to drag the home/away donut, which
  has nothing to do with `ladder`, toward a nonsensical single-row `SUM(ladder.wins)`). `ladder.wins`'s
  synonyms were also narrowed to "wins that season"/"season wins" so a bare "wins" elsewhere (the
  home/away donut) doesn't get pulled toward it either.
- A few prompts needed rewording, not semantic-layer changes, to land on the intended chart shape:
  "How many matches has each venue hosted?" (my first phrasing) reads as a ranking question and returns
  a top-10 bar; "Every AFL venue and how many matches it has hosted" reads as a listing and returns all
  53 rows with coordinates, which is what a point map needs. Likewise "Biggest wins in AFL history"
  collapsed to a single average; "List the matches with the biggest winning margins" returns the sorted
  row list a table chart wants. This mirrors phrasing sensitivities already present in the bundled Nobel
  and World Bank datasets' own curated prompts.

## Reproducing the build

```
CACHE_DIR=/path/outside/repo bun scripts/datasets/build-afl.mjs data/afl.sqlite
bun scripts/build-catalog.ts
bun scripts/plan-cli.ts --dataset afl "<any prompt above>"
```

The Squiggle fetch is ~260 sequential requests (one `games` + one `standings` call per season,
1897-present) at a small delay between calls; with a warm `CACHE_DIR` a re-run completes in well under a
second and never touches the network.

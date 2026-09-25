# swift dataset — Taylor Swift discography, credits, awards and tours

Built by `scripts/datasets/build-swift.mjs` (`bun scripts/datasets/build-swift.mjs data/swift.sqlite`,
`CACHE_DIR` recommended). Fresh build: ~2 minutes, almost all of it MusicBrainz's and Nominatim's
1 request/second rate limits (about 55 s of geocoding, ~35 s of MusicBrainz calls). From a warm
cache it's a couple of seconds.

## Sources, licences and what was fetched

| Source | What | Licence | Terms |
|---|---|---|---|
| **MusicBrainz** `musicbrainz.org/ws/2` | Artist lookup; release-groups/releases for the 16 albums (tracklists, durations, disc/track numbers, labels, artist-credits for featured artists); `work` entities with `artist-rels` for songwriting credits | **CC0** | [MusicBrainz data licensing](https://musicbrainz.org/doc/About/Data_License) — core data is CC0. A descriptive User-Agent and ≤1 req/s were used throughout, per the [API rate-limiting guide](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting). |
| **Wikidata** `query.wikidata.org/sparql` | Awards received (P166) and nominated for (P1411), with year (P585), work (P1686) and ceremony (P361); the six concert tours (P175 performer + P31 "concert tour" Q1573906) with start/end dates (P580/P582) | **CC0** | [Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) — CC0, no attribution legally required. |
| **Wikipedia** `en.wikipedia.org` (raw wikitext) | The Eras Tour's full "Tour dates" table (date/city/country/venue/attendance, 149 shows across the 2023 and 2024 legs); the five earlier tours' infobox totals (shows/attendance/gross); a handful of Easter-egg facts, each written in this script's own words and cited to the article it came from | **CC BY-SA 4.0** | [Wikipedia:Reusing Wikipedia content](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content) — reuse is free with attribution and share-alike. **This is why the whole dataset is licensed CC BY-SA 4.0**, not CC0: mixing in even a small amount of CC BY-SA content makes the combined work CC BY-SA under the licence's share-alike term. |
| **OpenStreetMap Nominatim** `nominatim.openstreetmap.org` | Geocoding only (lat/lon) for the 50 distinct Eras Tour cities | ODbL (coordinates only, not redistributing OSM's own database) | [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) — descriptive User-Agent, ≤1 req/s, both honoured. |

Every fetch sends `User-Agent: auradash-bi/1.0 (+https://auradash-bi.everadapt.au)` and is
cached on disk (`CACHE_DIR`) so a rerun is instant and offline. `_about` in the built `.sqlite`
carries the same source/licence/attribution/built_at row the other two datasets use.

## Albums: which 16, and which release each tracklist came from

Taylor Swift's MusicBrainz release-groups were listed and filtered to the ones with **no secondary
type** (i.e. a plain studio album or "Taylor's Version" re-recording, not a live album, compilation,
remix or demo) — 17 came back, and one, "The Vault (deluxe)" (2021), was a fan-made bootleg
compilation mislabelled the same way; it was dropped. The remaining 16 are hand-verified against the
real discography and hardcoded by MBID in `ALBUM_DEFS` (same approach as `build-nobel.mjs`'s country
map): the 12 studio albums (*Taylor Swift* through *The Life of a Showgirl*, released 2025-10-03) and
the 4 "Taylor's Version" re-recordings, each linked to its `original_album_id`.

For each album, every release variant was fetched (`release?release-group=<id>&inc=recordings+
labels+artist-credits`) and one was picked to supply the tracklist:

1. Prefer an **Official**, **Digital Media** release (worldwide code `XW` beats `US` beats anything
   else), taking whichever track count is the *mode* among those — this is what a fan finds on
   streaming today.
2. Otherwise, the *mode* track count among all **Official** releases of any format (this is how the
   original 2008 *Fearless* — whose only tagged digital releases are all `Withdrawn` — still resolves
   to its correct 13-track edition instead of the rare 19-track *Platinum Edition*).

One bonus track, a spoken "Taylor Swift Interview" present on one regional digital edition of the
debut album, was dropped — it is not a song and was skewing duration questions.

This is a deliberate, reproducible rule, not a hand-curated tracklist, so a couple of albums land on
a richer edition than the "classic" one fans think of by default: *Fearless* resolves to the 19-track
*Platinum Edition* (its only tagged Official Digital release) and *Red* to the 22-track deluxe (no
Official Digital release is tagged for it, so the tool falls back to the Official-format mode, which
is the deluxe CD). *THE TORTURED POETS DEPARTMENT* correctly resolves to all 31 tracks of *The
Anthology*, released simultaneously with the album, not as a later reissue. Every other album lands on
the count fans would expect. Track counts and per-album totals are in the table below.

**Featured artists** come from each track's MusicBrainz `artist-credit` (not the title text, which
usually doesn't spell out "feat. X" — e.g. "Everything Has Changed" on *Red* carries Ed Sheeran only
in its artist-credit). **Vault tracks** are detected from the literal "(From The Vault)" suffix
MusicBrainz/streaming platforms use for a Taylor's Version's previously-unreleased songs. **Singles**
are cross-referenced against every MusicBrainz single/promotional-single release-group for the artist
(225 of them; some are vault-track radio pushes rather than a "real" single, so treat this as
approximate).

## Songwriting credits

`GET work?artist=<mbid>&inc=artist-rels`, paginated (347 works, 4 pages of 100). Each work's `writer`/
`composer`/`lyricist` artist-relations are kept (756 raw pairs; 737 after exact-duplicate removal) and
matched onto every song whose title normalizes the same way (stripping "(Taylor's Version)", "(From
The Vault)", "(feat. …)" and punctuation) — so a credit on the original applies to its re-recording
too. **Producer credits are not included**: MusicBrainz models those as recording-level relations,
which would need a separate lookup per recording (hundreds of extra rate-limited calls) rather than
the four bulk `work` pages used here; out of scope for this pass.

## Awards and tours (Wikidata)

**Awards**: every `award received` (P166) and `nominated for` (P1411) statement on Taylor Swift's
Wikidata item (Q26876) with a year, minus one mislabelled statement pointing at the *list of awards
and nominations* Wikipedia article rather than an actual award. This is **57 rows (55 won, 2
nominated)** — Wikidata's own recorded history, not an exhaustive list of every award Taylor Swift has
actually won; her real tally runs into the hundreds. `ceremony` is resolved from each award's "part of"
(P361) property where present (e.g. American Music Awards' individual category items correctly link
back to the ceremony) and otherwise from a small set of label patterns ("Grammy Award for X" ->
ceremony "Grammy Awards", category "X").

**Tours**: every item that is `instance of` "concert tour" (Q1573906) with Taylor Swift as performer
(P175) and a start date — 6 of the 7 candidates (the cancelled 2020 "Lover Fest" festival has neither
a start date nor any shows, so it was excluded). Wikidata does **not** carry attendance/gross for any
of them, so those two figures come from each tour's Wikipedia infobox (`attendance`/`gross` fields,
parsed for the leading number and million/billion suffix, dropping the inflation-adjusted
parenthetical) for the five completed tours, and from the Eras Tour article's own lead paragraph for
the Eras Tour (Wikipedia's infobox omits it; the article cites Ben Sisario, *The New York Times*,
December 2024: "the tour grossed $2.07 billion with an attendance of 10.1 million").

## The Eras Tour's 149 shows (Wikipedia)

Wikidata only has 15 individual per-show items for the Eras Tour (the ones with a dedicated Commons
photo category) — nowhere near complete. The full list lives in a wikitable on the "The Eras Tour"
Wikipedia article itself, under "Tour dates" (two sub-tables, "2023 shows" and "2024 shows"; a third,
"Cancelled shows", was correctly excluded — those never happened). It's a real MediaWiki table with
heavy `rowspan`/`colspan` use (one cell can cover a 3-night stand's city, venue and combined
attendance), so `build-swift.mjs` includes a small rowspan/colspan-aware wikitable parser rather than
scraping a rendered page. Result: exactly 149 shows, matching the infobox's `number_of_shows = 149`.

Cities were geocoded with Nominatim, using **Wikipedia's own disambiguated wikilink target** (e.g.
`[[Glendale, Arizona|Glendale]]`) rather than the bare display text — several US stadium cities share
a name with a much more prominent namesake elsewhere (Glendale AZ vs. Glendale CA; Santa Clara CA;
Arlington TX; East Rutherford NJ; Inglewood CA), and geocoding the bare city name alone silently
resolved four of those to the wrong city on the first pass. All 50 distinct city/country pairs
geocoded successfully. "Paradise" (the town Allegiant Stadium is actually in) is stored as "Las Vegas"
per the table's own footnote ("labelled as Las Vegas in promotional material").

**Caveat carried into the semantic layer**: a multi-night stand's `attendance` is sometimes a single
combined figure repeated on every one of those nights (e.g. Wembley's eight nights all show the same
753,112 combined total) — summing `tour_shows.attendance` over a tour will overcount; `tours.
total_attendance` is the real per-tour total. Only the Eras Tour has `tour_shows` rows; the five
earlier tours only have their `tours`-level totals.

## Easter eggs — no lyrics, own words, cited

14 rows, each ≤30 words, written from a Wikipedia article actually fetched for this dataset (listed in
`EASTER_EGGS` in the build script, with its `source_url`). **No lyric text or lyric-derived data is
stored anywhere** — song titles only. Categories used: `liner_notes`, `music`, `social_media`,
`album_art`, `lyrics` (the last describing what a lyric is *about* — e.g. two characters sharing the
names of the songwriter's friends' children — never quoting it).

## Schema

```
albums (album_id, title, release_date, year, era, is_taylors_version, original_album_id -> albums,
        album_type studio|re-recording, track_count, total_minutes, label)
songs (song_id, album_id -> albums, title, track_number, disc_number, duration_s, is_vault_track,
       is_single, featured_artists, year)
people (person_id, name)                                    -- songwriters
credits (song_id -> songs, person_id -> people, role writer|composer|lyricist)
awards (award_id, year, ceremony, category, work, result won|nominated)
tours (tour_id, name, start_date, end_date, shows, total_attendance, gross_usd)
tour_shows (show_id, tour_id -> tours, date, city, country_code, venue, attendance, latitude, longitude)
easter_eggs (egg_id, album_id -> albums, song_id -> songs, category, description, source_url)
```

Two hidden convenience views ride along for single-table queries: `song_facts` (song + its album's
era/type/flags) and `credit_facts` (credit + song + album + person names), the same pattern as
nobel's `award_facts` and world's `country_year_facts`.

**Row counts** (built 2026-09-24): albums 16, songs 300 (26 vault tracks, 127 tagged as singles/promo
singles, 24 with a featured artist), people 60, credits 737 (426 writer / 156 composer / 155
lyricist), awards 57, tours 6, tour_shows 149 (50 distinct cities, 19 countries), easter_eggs 14.
Built file: 228 KB (47 KB gzipped) — well under the 6 MB budget.

## Try prompts — validated against the live planner

Every prompt below was run through `bun scripts/plan-cli.ts --dataset swift "<question>"` with a live
Jev key, iterating the wording and the semantic layer (metrics, synonyms, a column rename) until each
one came back `status=ok` with no compile error. Two real bugs were found and fixed on the data side
(see "Planner issues found" below); the rest is honest live behaviour.

| # | Prompt | Chart | Live plan (table/grouping) | Rows | OK |
|---|---|---|---|---|---|
| 1 | How many songs are on each album? | hbar | `albums` grouped by title, avg track_count | 16 | Yes |
| 2 | Album lengths over time | bar | `albums` x `songs` grouped by year + title | 16 | Yes |
| 3 | Share of vault tracks by album | donut | `songs` x `albums` grouped by title, sum is_vault_track (top 10, incl. zeros) | 10 | Yes* |
| 4 | How many awards has Taylor Swift won? | kpi | `awards`, SUM(result='won') | 1 | Yes |
| 5 | Top 10 songwriters by songs co-written with Taylor Swift | hbar | `credits` x `people` grouped by name, filtered to role=writer (includes Taylor herself at #1) | 10 | Yes* |
| 6 | Where did the Eras Tour play? | point_map | `tour_shows` x `tours`, filtered to The Eras Tour | 149 | Yes |
| 7 | Eras Tour shows by country | choropleth | `tour_shows` grouped by country_code (all tours; in practice only Eras has rows) | 19 | Yes |
| 8 | Distribution of song lengths | histogram | `songs`, 30-second buckets | 11 | Yes |
| 9 | How many Easter eggs are there per album? | bar | `easter_eggs` x `albums` grouped by title | 9 | Yes |
| 10 | Longest songs | table | `songs`, sorted by duration (planner collapsed to a single average rather than the top 10 rows) | 1 | Partial |
| 11 | Top tours by total attendance | hbar | `tours` grouped by name, sorted by total_attendance | 6 | Yes |
| 12 | Awards won compared to awards nominated | donut | `awards`, SUM(won) and SUM(nominated) side by side (one row of two measures, not two grouped rows) | 1 | Partial |

\* Rows 3 and 5 land on a superset of the intended answer (row 3 includes the 12 albums with zero
vault tracks instead of just the 4 that have any; row 5 includes Taylor Swift herself, who is
trivially the top result) rather than being wrong — both are still correct, sensible answers to a
slightly broader reading of the question. 10/12 are exact; all 12 are non-error, sensible results.

### Planner issues found (not fixable from the semantic layer — filed for the planner/lead)

Investigating why several natural "which X had the most Y" / "X by year" questions on `awards` kept
collapsing to a single ungrouped number surfaced two bugs in the shared planner
(`src/lib/plan/{graph,request,interpret}.ts`, owned by the *planner* workstream, not touched here):

1. **A table with no foreign keys is treated as an irrelevant lookup table and entirely excluded from
   both group-by and filter-value candidates** (`isIsolatedTable` in `graph.ts`, used by
   `buildDimensions` in `request.ts` and `buildValueIndex` in `candidates.ts`). This is correct for a
   genuine metadata table (World's `indicators`), but `awards` here is a real, standalone fact table —
   an award can't be reliably foreign-keyed to one song or album row (most are artist-level: "Artist
   of the Year" has no work at all) — and the same blanket rule silently hides `awards.ceremony`,
   `awards.category` and `awards.result` from ever being offered to Jev at all. **A question like
   "How many Grammys has Taylor Swift won?" or "Awards by ceremony" can never work until this is
   addressed**, no matter how the semantic layer or the question is phrased (verified: even with
   `awards.ceremony`'s value "Grammy Awards" and alias "Grammys" present in the built catalog's
   `values[]`, "How many Grammys has Taylor Swift won?" matched no filter candidate at all and just
   summed every award). Suggested fix: only exclude a table when it has no measure/dimension worth
   surfacing, not merely because it has no join edges - or add a per-table opt-out in the catalog for
   a standalone table that should still expose its own columns.
2. **The "nearest time column" used for both `timeGrain` options and year-filter candidates is always
   resolved from the dataset's single global `defaultFact`** (`nearestTimeColumn(catalog,
   catalog.defaultFact)` in `interpret.ts`/`request.ts`/`candidates.ts`), never from whatever table the
   current question's measure/groupBy actually touches. With `defaultFact: "songs"`, asking "Grammy
   wins by year" makes Jev correctly pick `timeGrain=year`, but the compiler then tries to reach
   `songs.year` from the unrelated `awards` table and throws `no join path from "awards" to "songs"`
   (a hard compile error, not a bad answer) — reproduced with `bun scripts/plan-cli.ts --dataset swift
   "Grammy wins by year"`. Any dataset with more than one independent fact table (discography vs.
   awards vs. touring, here) will hit this for every "by year" question outside the defaultFact's own
   component. Suggested fix: resolve the nearest time column relative to the table(s) the plan's
   measure/groupBy already touch, falling back to `defaultFact` only when that table has none.

Both are demonstrated with `bun scripts/plan-cli.ts --dataset swift "<question>"` in this worktree.
Prompts 4, 5, 9, 11 above were reworded specifically to route around bug 1 (nothing groups or filters
by `awards.ceremony`/`category`); bug 2 is why "Grammy wins by year" was dropped from the try-prompt
list entirely rather than reworded — there's no phrasing that avoids the compiler reaching for
`songs.year`.

## What was excluded and why

- **Deluxe/alternate editions beyond the one picked per album** — MusicBrainz has 20-100+ release
  variants per album (country and format reissues); only one tracklist per album is stored (see
  "Albums" above for the exact rule), not every regional variant.
- **Producer credits** — recording-level MusicBrainz relations, would need one extra lookup per
  recording (hundreds of additional rate-limited calls); only writer/composer/lyricist credits
  (work-level, fetched in bulk) are included.
- **Per-show tour_shows rows for the five earlier tours** — Wikipedia doesn't maintain a table as
  complete as the Eras Tour's for them; only tour-level totals are included for those five.
- **Lover Fest** — a cancelled 2020 festival with no start date and no shows on Wikidata; excluded
  from `tours`.
- **Any award or nomination Wikidata doesn't record** — the real award count is far higher than 57;
  this reflects Wikidata's coverage, not the true total, and no unverified figure was added.
- **Lyrics, lyric excerpts and anything lyric-derived** (word counts, rhyme data) — a hard rule for
  this dataset; not stored anywhere, including in the Easter-egg descriptions.
- **"The Vault (deluxe)" release-group** — a fan-made bootleg compilation mislabelled as a real album
  in MusicBrainz (see "Albums" above).

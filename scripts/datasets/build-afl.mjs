// Build afl.sqlite from the Squiggle API (https://api.squiggle.com.au/, free/open, usage terms
// require: identifying UserAgent, build-time fetch + caching, no live pass-through to browsers -
// see docs/research/afl-data.md). Club nicknames/states/founding years and venue geography are
// well-known public facts (club and ground names, locations, founding years), not scraped text.
// Usage: bun build-afl.mjs [out.sqlite]   |   node build-afl.mjs [out.sqlite]
import { openDb, insertMany, fetchJson } from "./sqlite.mjs";

const OUT = process.argv[2] ?? "data/afl.sqlite";
const API = "https://api.squiggle.com.au";
const FIRST_SEASON = 1897; // first VFL season
const LAST_SEASON = new Date().getFullYear();

// -------------------------------------------------------------------------------------------
// Reference data (hardcoded, like the nobel/worldbank builders' COUNTRY/FRIENDLY maps): these
// are widely-published facts (club nicknames, home states, founding years, ground locations),
// not scraped copyrighted text. debut/retirement years come from the Squiggle API itself.
// -------------------------------------------------------------------------------------------

// club_id (= Squiggle team id, stable across renames) -> reference facts.
const CLUB_META = {
  1: { nickname: "Crows", state: "SA", founded: 1990, colours: "Navy blue, red and gold", venue: "Adelaide Oval" },
  2: { nickname: "Lions", state: "QLD", founded: 1986, colours: "Maroon, blue and gold", venue: "Gabba",
    note: "Formed as Brisbane Bears (1986); merged with Fitzroy in 1996 to become Brisbane Lions." },
  3: { nickname: "Blues", state: "VIC", founded: 1864, colours: "Navy blue and white", venue: "Marvel Stadium" },
  4: { nickname: "Magpies", state: "VIC", founded: 1892, colours: "Black and white", venue: "M.C.G." },
  5: { nickname: "Bombers", state: "VIC", founded: 1872, colours: "Red and black", venue: "M.C.G." },
  6: { nickname: "Dockers", state: "WA", founded: 1994, colours: "Purple, white and green", venue: "Optus Stadium" },
  7: { nickname: "Cats", state: "VIC", founded: 1859, colours: "Navy blue, white and hoops", venue: "GMHBA Stadium" },
  8: { nickname: "Suns", state: "QLD", founded: 2009, colours: "Red, gold and blue", venue: "Carrara" },
  9: { nickname: "Giants", state: "NSW", founded: 2009, colours: "Orange, charcoal and white", venue: "Sydney Showground" },
  10: { nickname: "Hawks", state: "VIC", founded: 1902, colours: "Brown and gold", venue: "M.C.G." },
  11: { nickname: "Demons", state: "VIC", founded: 1858, colours: "Navy blue and red", venue: "M.C.G.",
    note: "The oldest football club in the world still playing Australian football." },
  12: { nickname: "Kangaroos", state: "VIC", founded: 1869, colours: "Royal blue and white", venue: "Marvel Stadium" },
  13: { nickname: "Power", state: "SA", founded: 1870, colours: "Teal, black and white", venue: "Adelaide Oval" },
  14: { nickname: "Tigers", state: "VIC", founded: 1885, colours: "Yellow and black", venue: "M.C.G." },
  15: { nickname: "Saints", state: "VIC", founded: 1873, colours: "Red, white and black", venue: "Marvel Stadium" },
  16: { nickname: "Swans", state: "NSW", founded: 1874, colours: "Red and white", venue: "S.C.G.",
    note: "Founded as South Melbourne; relocated to Sydney in 1982." },
  17: { nickname: "Eagles", state: "WA", founded: 1986, colours: "Blue and gold", venue: "Optus Stadium" },
  18: { nickname: "Bulldogs", state: "VIC", founded: 1877, colours: "Red, white and blue", venue: "Marvel Stadium",
    note: "Founded as Footscray; renamed Western Bulldogs in 1997." },
  19: { nickname: "Roys", state: "VIC", founded: 1883, colours: "Maroon and blue", venue: "Brunswick St",
    note: "Merged with the Brisbane Bears in 1996 to form the Brisbane Lions; did not return." },
  20: { nickname: "Students", state: "VIC", founded: 1908, colours: "Navy blue and white", venue: null,
    note: "University of Melbourne team; withdrew from the VFL after the 1914 season, never fielding a home ground." },
};
// Canonical venue (current/most recognisable name) <- raw Squiggle venue label, where a ground was
// renamed under different sponsorship deals over the years but is the same physical stadium.
const VENUE_ALIAS = {
  Docklands: "Marvel Stadium",
  "Kardinia Park": "GMHBA Stadium",
  "Mars Stadium": "Eureka Stadium",
  "Perth Stadium": "Optus Stadium",
  "University of Tasmania Stadium": "York Park",
  "Adelaide Arena at Jiangwan Stadium": "Jiangwan Stadium",
};
// Older/alternate names shown to Jev as synonyms for the canonical venue.
const VENUE_NAME_ALIASES = {
  "Marvel Stadium": ["docklands", "etihad stadium", "telstra dome", "colonial stadium"],
  "GMHBA Stadium": ["kardinia park", "skilled stadium", "simonds stadium"],
  "Eureka Stadium": ["mars stadium"],
  "Optus Stadium": ["perth stadium"],
  "York Park": ["university of tasmania stadium", "utas stadium"],
  "Jiangwan Stadium": ["adelaide arena", "shanghai stadium"],
  Gabba: ["the gabba", "brisbane cricket ground"],
  "M.C.G.": ["mcg", "the mcg", "melbourne cricket ground"],
  "S.C.G.": ["scg", "the scg", "sydney cricket ground"],
  "W.A.C.A.": ["waca", "the waca"],
};
// name, city, state (null for overseas), country, lat, lon, capacity (approximate; current/peak
// listed capacity from public knowledge - fine for a demo point map, not survey-grade).
const VENUE_META = {
  "Adelaide Hills": ["Adelaide Hills", "SA", "Australia", -35.06, 138.86, null],
  "Adelaide Oval": ["Adelaide", "SA", "Australia", -34.9156, 138.5961, 53500],
  Albury: ["Albury", "NSW", "Australia", -36.0737, 146.9135, null],
  "Arden St": ["Melbourne", "VIC", "Australia", -37.7963, 144.9391, 30000],
  "Barossa Park": ["Barossa Valley", "SA", "Australia", -34.47, 138.995, null],
  "Bellerive Oval": ["Hobart", "TAS", "Australia", -42.8756, 147.3672, 20000],
  Blacktown: ["Sydney", "NSW", "Australia", -33.7688, 150.8631, 20000],
  "Brisbane Exhibition": ["Brisbane", "QLD", "Australia", -27.453, 153.035, null],
  "Bruce Stadium": ["Canberra", "ACT", "Australia", -35.2494, 149.1028, 25011],
  "Brunswick St": ["Melbourne", "VIC", "Australia", -37.7997, 144.9784, 20000],
  Carrara: ["Gold Coast", "QLD", "Australia", -28.0055, 153.3654, 25000],
  "Cazaly's Stadium": ["Cairns", "QLD", "Australia", -16.9235, 145.753, 10000],
  "Coburg Oval": ["Melbourne", "VIC", "Australia", -37.7397, 144.9646, 15000],
  "Corio Oval": ["Geelong", "VIC", "Australia", -38.135, 144.355, 15000],
  "East Melbourne": ["Melbourne", "VIC", "Australia", -37.8136, 144.985, 20000],
  "Eureka Stadium": ["Ballarat", "VIC", "Australia", -37.5333, 143.8267, 11000],
  Euroa: ["Euroa", "VIC", "Australia", -36.75, 145.5667, null],
  "Football Park": ["Adelaide", "SA", "Australia", -34.8756, 138.5119, 51240],
  Gabba: ["Brisbane", "QLD", "Australia", -27.4858, 153.0381, 36000],
  "GMHBA Stadium": ["Geelong", "VIC", "Australia", -38.158, 144.3548, 40000],
  "Glenferrie Oval": ["Melbourne", "VIC", "Australia", -37.8267, 145.0333, 25000],
  "Hands Oval": ["Bunbury", "WA", "Australia", -33.3283, 115.6383, 12000],
  "Jiangwan Stadium": ["Shanghai", null, "China", 31.32, 121.501, 15000],
  "Junction Oval": ["Melbourne", "VIC", "Australia", -37.8567, 144.9764, 35000],
  "Lake Oval": ["Melbourne", "VIC", "Australia", -37.8447, 144.9636, 35000],
  "M.C.G.": ["Melbourne", "VIC", "Australia", -37.8199, 144.9834, 100024],
  "Manuka Oval": ["Canberra", "ACT", "Australia", -35.3181, 149.1372, 13550],
  "Marrara Oval": ["Darwin", "NT", "Australia", -12.3986, 130.8811, 12500],
  "Marvel Stadium": ["Melbourne", "VIC", "Australia", -37.8164, 144.9475, 53359],
  "Moorabbin Oval": ["Melbourne", "VIC", "Australia", -37.9425, 145.0525, 45000],
  "North Hobart": ["Hobart", "TAS", "Australia", -42.8667, 147.3167, 16000],
  "Norwood Oval": ["Adelaide", "SA", "Australia", -34.9167, 138.6333, 15000],
  "Olympic Park": ["Melbourne", "VIC", "Australia", -37.825, 144.982, 26000],
  "Optus Stadium": ["Perth", "WA", "Australia", -31.9513, 115.8892, 61266],
  "Princes Park": ["Melbourne", "VIC", "Australia", -37.7864, 144.9614, 24800],
  "Punt Rd": ["Melbourne", "VIC", "Australia", -37.8236, 144.9906, 30000],
  "Riverway Stadium": ["Townsville", "QLD", "Australia", -19.2725, 146.7378, 10000],
  "S.C.G.": ["Sydney", "NSW", "Australia", -33.8916, 151.2247, 48000],
  "Stadium Australia": ["Sydney", "NSW", "Australia", -33.847, 151.0634, 83500],
  Subiaco: ["Perth", "WA", "Australia", -31.9439, 115.8264, 42922],
  "Sydney Showground": ["Sydney", "NSW", "Australia", -33.8464, 151.0684, 24000],
  "Toorak Park": ["Melbourne", "VIC", "Australia", -37.8608, 145.0367, 15000],
  "Traeger Park": ["Alice Springs", "NT", "Australia", -23.705, 133.88, 10500],
  "UNSW Canberra Oval": ["Canberra", "ACT", "Australia", -35.315, 149.165, 5000],
  "Victoria Park": ["Melbourne", "VIC", "Australia", -37.7986, 144.995, 41113],
  "W.A.C.A.": ["Perth", "WA", "Australia", -31.96, 115.8756, 20000],
  "Waverley Park": ["Melbourne", "VIC", "Australia", -37.9002, 145.1706, 72000],
  Wellington: ["Wellington", null, "New Zealand", -41.2731, 174.7861, 34500],
  "Western Oval": ["Melbourne", "VIC", "Australia", -37.7994, 144.8919, 25000],
  "Windy Hill": ["Melbourne", "VIC", "Australia", -37.7561, 144.9161, 30000],
  Yallourn: ["Yallourn", "VIC", "Australia", -38.1806, 146.3389, null],
  "Yarraville Oval": ["Melbourne", "VIC", "Australia", -37.8161, 144.8886, null],
  "York Park": ["Launceston", "TAS", "Australia", -41.4211, 147.1519, 21000],
};
const FINAL_TYPE = { 1: "final", 2: "elimination_final", 3: "qualifying_final", 4: "semi_final",
  5: "preliminary_final", 6: "grand_final", 7: "wildcard_final" };
// 1897 and 1924 used finals formats (a top-4 round-robin, and the "Argus system") that could crown
// a premier without a single deciding match; Squiggle's data has no is_grand_final=1 game for either
// year, and asserting a winner from the surrounding results would be a guess. Left unset on purpose.
const NO_DECIDER_SEASONS = new Set([1897, 1924]);

const num = (v) => (v === undefined || v === null ? null : Number(v));
const decadeOf = (y) => Math.floor(y / 10) * 10;

// -------------------------------------------------------------------------------------------
// Fetch: teams (current + the two historical-only clubs), then every season's games + standings.
// -------------------------------------------------------------------------------------------
const currentTeams = (await fetchJson(`${API}/?q=teams`, "afl_teams_current.json")).teams;
const oldTeams = (await fetchJson(`${API}/?q=teams;year=1910`, "afl_teams_1910.json")).teams
  .filter((t) => t.id === 19 || t.id === 20); // Fitzroy, University: gone before the current list
const teamInfo = new Map([...currentTeams, ...oldTeams].map((t) => [t.id, t]));
if (teamInfo.size !== 20) throw new Error(`expected 20 clubs total, got ${teamInfo.size} - Squiggle's team list changed`);

const allGames = [];
const standingsByYear = new Map();
for (let year = FIRST_SEASON; year <= LAST_SEASON; year++) {
  const g = await fetchJson(`${API}/?q=games;year=${year}`, `afl_games_${year}.json`);
  allGames.push(...(g.games ?? []));
  await new Promise((r) => setTimeout(r, 120));
  const s = await fetchJson(`${API}/?q=standings;year=${year}`, `afl_standings_${year}.json`);
  standingsByYear.set(year, s.standings ?? []);
  await new Promise((r) => setTimeout(r, 120));
}
const completed = allGames.filter((g) => g.complete === 100 && g.hscore != null && g.ascore != null);

// -------------------------------------------------------------------------------------------
// Venues: canonical name (after alias merge) with first/last year and matches hosted, from data;
// city/state/country/lat/lon/capacity from the reference map above.
// -------------------------------------------------------------------------------------------
const venueAgg = new Map(); // canonical name -> { first, last, n }
for (const g of completed) {
  const canon = VENUE_ALIAS[g.venue] ?? g.venue;
  if (!VENUE_META[canon]) throw new Error(`Unmapped AFL venue "${canon}" (raw "${g.venue}") - add it to VENUE_META`);
  const v = venueAgg.get(canon) ?? { first: g.year, last: g.year, n: 0 };
  v.first = Math.min(v.first, g.year);
  v.last = Math.max(v.last, g.year);
  v.n++;
  venueAgg.set(canon, v);
}
const venueNames = [...venueAgg.keys()].sort();
const venueId = new Map(venueNames.map((name, i) => [name, i + 1]));
const venues = venueNames.map((name) => {
  const [city, state, country, lat, lon, capacity] = VENUE_META[name];
  const agg = venueAgg.get(name);
  return [venueId.get(name), name, city, state, country, lat, lon, capacity, agg.first, agg.last, agg.last >= LAST_SEASON - 1 ? 1 : 0, agg.n];
});

// -------------------------------------------------------------------------------------------
// Clubs: Squiggle's own numeric team id doubles as our club_id (stable across every rename).
// -------------------------------------------------------------------------------------------
const clubYears = new Map(); // club_id -> Set(year) for seasons_played
for (const g of completed) {
  for (const id of [g.hteamid, g.ateamid]) {
    if (!clubYears.has(id)) clubYears.set(id, new Set());
    clubYears.get(id).add(g.year);
  }
}
const clubs = [...teamInfo.values()].map((t) => {
  const meta = CLUB_META[t.id];
  const retirement = t.retirement >= 9999 ? null : t.retirement;
  return [
    t.id, t.name, meta.nickname, t.abbrev, meta.state, meta.founded, t.debut, retirement,
    retirement === null ? 1 : 0, meta.venue ? venueId.get(meta.venue) : null, meta.colours,
    clubYears.get(t.id)?.size ?? 0, meta.note ?? null,
  ];
});
const clubName = new Map(clubs.map((c) => [c[0], c[1]]));

// -------------------------------------------------------------------------------------------
// Matches: one row per completed game, with pre-computed helper columns (margin, total, decade,
// winner/loser id, winner side) so common questions need no arithmetic in the generated SQL.
// -------------------------------------------------------------------------------------------
const matches = completed.map((g) => {
  const isDraw = g.hscore === g.ascore;
  const winnerId = isDraw ? null : g.winnerteamid;
  const loserId = isDraw ? null : winnerId === g.hteamid ? g.ateamid : g.hteamid;
  const winnerSide = isDraw ? "draw" : winnerId === g.hteamid ? "home" : "away";
  return [
    g.id, g.year, decadeOf(g.year), g.round, g.roundname, g.is_final > 0 ? 1 : 0,
    FINAL_TYPE[g.is_final] ?? null, g.is_grand_final, g.date.slice(0, 10),
    venueId.get(VENUE_ALIAS[g.venue] ?? g.venue), g.hteamid, g.ateamid, g.hscore, g.ascore,
    g.hgoals, g.hbehinds, g.agoals, g.abehinds, g.hscore + g.ascore, Math.abs(g.hscore - g.ascore),
    winnerId, loserId, winnerSide, isDraw ? 1 : 0,
  ];
});

// -------------------------------------------------------------------------------------------
// Ladder: the final (or current, for an in-progress season) standings table for every season.
// -------------------------------------------------------------------------------------------
const ladder = [];
for (const [year, rows] of standingsByYear) {
  for (const r of rows) {
    ladder.push([year, r.id, r.rank, r.played, r.wins, r.losses, r.draws, r.for, r.against,
      Math.round(r.percentage * 10) / 10, r.pts]);
  }
}

// -------------------------------------------------------------------------------------------
// Seasons: one row per year with pre-computed premier/runner-up (so "who won the flag in X" and
// "most premierships" need no finals-parsing logic in the generated SQL).
// -------------------------------------------------------------------------------------------
const gamesByYear = new Map();
for (const g of completed) {
  if (!gamesByYear.has(g.year)) gamesByYear.set(g.year, []);
  gamesByYear.get(g.year).push(g);
}
const seasons = [];
for (let year = FIRST_SEASON; year <= LAST_SEASON; year++) {
  const yearGames = gamesByYear.get(year) ?? [];
  const teamSet = new Set(yearGames.flatMap((g) => [g.hteamid, g.ateamid]));
  const standings = standingsByYear.get(year) ?? [];
  const minorPremier = standings.find((r) => r.rank === 1)?.id ?? null;
  let premier = null, runnerUp = null;
  if (!NO_DECIDER_SEASONS.has(year)) {
    // Grand finals are usually decisive; 1948/1977/2010 were drawn and replayed - the later
    // (by date) grand final of the season is the one that actually decided the premiership.
    const grandFinals = yearGames.filter((g) => g.is_grand_final === 1).sort((a, b) => new Date(a.date) - new Date(b.date));
    const decider = grandFinals.at(-1);
    if (decider && decider.hscore !== decider.ascore) {
      premier = decider.winnerteamid;
      runnerUp = decider.winnerteamid === decider.hteamid ? decider.ateamid : decider.hteamid;
    }
  }
  // A season is complete once its Grand Final has been played (or, for the two no-decider
  // years, once finals week wrapped up - both fully played out in Squiggle's data).
  const grandFinalPlayed = allGames.some((g) => g.year === year && g.is_grand_final === 1 && g.complete === 100);
  const isComplete = grandFinalPlayed || NO_DECIDER_SEASONS.has(year);
  seasons.push([year, decadeOf(year), year < 1990 ? "VFL" : "AFL", teamSet.size, yearGames.length,
    premier, runnerUp, minorPremier, isComplete ? 1 : 0]);
}

// -------------------------------------------------------------------------------------------
// Write the SQLite file.
// -------------------------------------------------------------------------------------------
const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE venues (
  venue_id      INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,        -- current/most recognisable name for the ground
  city          TEXT NOT NULL,
  state         TEXT,                        -- Australian state/territory abbreviation, NULL overseas
  country       TEXT NOT NULL DEFAULT 'Australia',
  latitude      REAL NOT NULL,
  longitude     REAL NOT NULL,
  capacity      INTEGER,                     -- approximate current/peak listed capacity
  first_year    INTEGER NOT NULL,
  last_year     INTEGER NOT NULL,
  is_active     INTEGER NOT NULL,            -- hosted a game in the last two seasons
  matches_hosted INTEGER NOT NULL
);
CREATE TABLE clubs (
  club_id         INTEGER PRIMARY KEY,       -- Squiggle's team id; stable across every rename
  name            TEXT NOT NULL,             -- current name
  nickname        TEXT NOT NULL,             -- primary fan nickname (Magpies, Cats, Swans, ...)
  abbrev          TEXT NOT NULL,
  state           TEXT NOT NULL,
  founded_year    INTEGER NOT NULL,          -- year the club was formed (may predate its VFL/AFL debut)
  debut_year      INTEGER NOT NULL,          -- first VFL/AFL season
  retirement_year INTEGER,                   -- last season, NULL if still competing
  is_active       INTEGER NOT NULL,
  home_venue_id   INTEGER REFERENCES venues(venue_id),
  colours         TEXT NOT NULL,
  seasons_played  INTEGER NOT NULL,
  note            TEXT                       -- merger/rename history, where relevant
);
CREATE TABLE seasons (
  year               INTEGER PRIMARY KEY,
  decade             INTEGER NOT NULL,
  era                TEXT NOT NULL CHECK (era IN ('VFL','AFL')),  -- competition renamed VFL -> AFL in 1990
  team_count         INTEGER NOT NULL,
  matches_played     INTEGER NOT NULL,
  premier_club_id    INTEGER REFERENCES clubs(club_id),    -- NULL for 1897 & 1924 (no single decider - see docs)
  runner_up_club_id  INTEGER REFERENCES clubs(club_id),
  minor_premier_club_id INTEGER REFERENCES clubs(club_id), -- top of the home-and-away ladder
  is_complete        INTEGER NOT NULL
);
CREATE TABLE matches (
  match_id      INTEGER PRIMARY KEY,         -- Squiggle's game id
  year          INTEGER NOT NULL REFERENCES seasons(year),
  decade        INTEGER NOT NULL,
  round_number  INTEGER NOT NULL,
  round_name    TEXT NOT NULL,               -- "Round 5", "Qualifying Final", "Grand Final", ...
  is_final      INTEGER NOT NULL,            -- 0 home-and-away, 1 any final
  final_type    TEXT,                        -- elimination_final|qualifying_final|semi_final|preliminary_final|grand_final|wildcard_final
  is_grand_final INTEGER NOT NULL,
  match_date    TEXT NOT NULL,               -- ISO date
  venue_id      INTEGER NOT NULL REFERENCES venues(venue_id),
  home_club_id  INTEGER NOT NULL REFERENCES clubs(club_id),
  away_club_id  INTEGER NOT NULL REFERENCES clubs(club_id),
  home_score    INTEGER NOT NULL,
  away_score    INTEGER NOT NULL,
  home_goals    INTEGER,
  home_behinds  INTEGER,
  away_goals    INTEGER,
  away_behinds  INTEGER,
  total_score   INTEGER NOT NULL,            -- home_score + away_score
  margin        INTEGER NOT NULL,            -- |home_score - away_score|
  winner_club_id INTEGER REFERENCES clubs(club_id),  -- NULL for a draw
  loser_club_id  INTEGER REFERENCES clubs(club_id),  -- NULL for a draw
  winner_side   TEXT NOT NULL CHECK (winner_side IN ('home','away','draw')),
  is_draw       INTEGER NOT NULL
);
CREATE TABLE ladder (
  year               INTEGER NOT NULL REFERENCES seasons(year),
  club_id            INTEGER NOT NULL REFERENCES clubs(club_id),
  position           INTEGER NOT NULL,
  played             INTEGER NOT NULL,
  wins               INTEGER NOT NULL,
  losses             INTEGER NOT NULL,
  draws              INTEGER NOT NULL,
  points_for         INTEGER NOT NULL,       -- total score (goals x6 + behinds) across the season
  points_against     INTEGER NOT NULL,
  percentage         REAL NOT NULL,
  premiership_points INTEGER NOT NULL,
  PRIMARY KEY (year, club_id)
);
CREATE INDEX idx_matches_year ON matches(year);
CREATE INDEX idx_matches_home ON matches(home_club_id);
CREATE INDEX idx_matches_away ON matches(away_club_id);
CREATE INDEX idx_matches_venue ON matches(venue_id);
CREATE INDEX idx_ladder_club ON ladder(club_id);

-- Flat convenience view: one row per match with club and venue names attached.
CREATE VIEW match_facts AS
SELECT m.*, hc.name AS home_club, hc.nickname AS home_nickname, ac.name AS away_club, ac.nickname AS away_nickname,
       wc.name AS winner_club, v.name AS venue, v.city AS venue_city, v.state AS venue_state
FROM matches m
JOIN clubs hc ON hc.club_id = m.home_club_id
JOIN clubs ac ON ac.club_id = m.away_club_id
JOIN venues v ON v.venue_id = m.venue_id
LEFT JOIN clubs wc ON wc.club_id = m.winner_club_id;
`;

const db = await openDb(OUT);
db.exec(DDL);
insertMany(db, "INSERT INTO venues VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", venues);
insertMany(db, "INSERT INTO clubs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", clubs);
insertMany(db, "INSERT INTO seasons VALUES (?,?,?,?,?,?,?,?,?)", seasons);
insertMany(db, `INSERT INTO matches VALUES (${Array(24).fill("?").join(",")})`, matches);
insertMany(db, "INSERT INTO ladder VALUES (?,?,?,?,?,?,?,?,?,?,?)", ladder);
// Provenance travels with the file (hidden from query candidates by the leading underscore).
db.exec("CREATE TABLE _about (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
insertMany(db, "INSERT INTO _about VALUES (?,?)", [
  ["title", "AFL"],
  ["source", "Squiggle API - https://api.squiggle.com.au/ (match results, ladders, teams)"],
  ["license", "Squiggle API usage terms (see docs/research/afl-data.md); club/venue reference facts are public knowledge"],
  ["attribution", "Match, team and ladder data: Squiggle (squiggle.com.au). Not endorsed by or affiliated with the AFL or Squiggle."],
  ["built_at", new Date().toISOString()],
]);
const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
if (fkErrors.length) throw new Error(`FK violations: ${JSON.stringify(fkErrors.slice(0, 5))}`);
db.exec("ANALYZE; VACUUM;");
for (const t of ["clubs", "venues", "seasons", "matches", "ladder"])
  console.log(t.padEnd(10), db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
db.close();
console.log("wrote", OUT);

// Build swift.sqlite: Taylor Swift discography, songwriting credits, awards, tours and Eras Tour
// dates.
//
// Sources (all fetched live, cached under CACHE_DIR):
//   - MusicBrainz (CC0): artist, release-groups/releases (albums + tracklists), works+artist-rels
//     (songwriter credits). https://musicbrainz.org/doc/MusicBrainz_API
//   - Wikidata (CC0, SPARQL): awards received/nominated, concert tours.
//   - Wikipedia (CC BY-SA 4.0): the Eras Tour's full "Tour dates" table (date/city/country/venue/
//     attendance) and each tour's infobox totals, plus a handful of "own words" Easter-egg facts.
//     Using Wikipedia text is why this dataset's licence is CC BY-SA 4.0, not CC0.
//   - OpenStreetMap Nominatim: geocoding for Eras Tour cities (lat/lon only, no other data used).
//
// HARD RULE: no lyrics anywhere, not even a line, and nothing lyric-derived. Song titles only.
// Every easter_eggs row is written in this script's own words and cites a URL actually fetched
// above (see EASTER_EGGS below); nothing here is invented.
//
// Usage: bun build-swift.mjs [out.sqlite]   |   node build-swift.mjs [out.sqlite]
// Set CACHE_DIR to an on-disk cache directory (outside the repo) to make reruns instant/offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDb, insertMany } from "./sqlite.mjs";

const OUT = process.argv[2] ?? "data/swift.sqlite";
const UA = "auradash-bi/1.0 (+https://auradash-bi.everadapt.au)";
const ARTIST_MBID = "20244d07-534f-4eff-b4d4-930878889970";

const ensureDir = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────── polite, cached HTTP ───────────────────────────────

const lastCallAt = {};
async function politeFetch(url, { cacheName, host, minIntervalMs = 0, headers = {} } = {}) {
  const cacheDir = process.env.CACHE_DIR && resolve(process.env.CACHE_DIR);
  const file = cacheDir && cacheName ? join(cacheDir, cacheName) : null;
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  if (minIntervalMs && host) {
    const wait = minIntervalMs - (Date.now() - (lastCallAt[host] ?? 0));
    if (wait > 0) await sleep(wait);
  }
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA, ...headers } });
    if (host) lastCallAt[host] = Date.now();
    if (res.ok) {
      const text = await res.text();
      if (file) { ensureDir(cacheDir); writeFileSync(file, text); }
      return text;
    }
    if (attempt >= 4) throw new Error(`${res.status} ${url}`);
    await sleep(1500 * attempt);
  }
}
const mbJson = async (path, cacheName) =>
  JSON.parse(await politeFetch(`https://musicbrainz.org/ws/2/${path}${path.includes("?") ? "&" : "?"}fmt=json`,
    { cacheName, host: "mb", minIntervalMs: 1100 }));
const wdSparql = async (query, cacheName) =>
  JSON.parse(await politeFetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`,
    { cacheName, host: "wd", minIntervalMs: 300 })).results.bindings;
const wikiRaw = async (title, cacheName) =>
  politeFetch(`https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`,
    { cacheName, host: "wiki", minIntervalMs: 300 });
async function geocode(query, cacheName) {
  const text = await politeFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
    { cacheName, host: "nominatim", minIntervalMs: 1100 });
  const arr = JSON.parse(text);
  return arr[0] ? { lat: Number(arr[0].lat), lon: Number(arr[0].lon) } : null;
}
/** Fetch every page of a MusicBrainz browse/search endpoint (100 per page). */
async function mbAll(pathBase, listKey, countKey, cacheKey) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const data = await mbJson(`${pathBase}${sep}limit=100&offset=${offset}`, `mb_${cacheKey}_${offset}.json`);
    out.push(...data[listKey]);
    if (offset + 100 >= data[countKey]) return out;
  }
}

// ─────────────────────────────── text helpers ───────────────────────────────

const straighten = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
function wikiClean(s) {
  return straighten(
    (s ?? "")
      .replace(/<ref[^>]*\/>/gi, "")
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
      .replace(/\{\{efn[^{}]*\}\}/gi, "")
      .replace(/\{\{n\/a\}\}/gi, "")
      .replace(/\{\{dagger\}\}/gi, "")
      .replace(/\[\[([^|\]]*)\|([^\]]*)\]\]/g, "$2")
      .replace(/\[\[([^\]]*)\]\]/g, "$1")
      .replace(/<br\s*\/?>/gi, ", ")
      .replace(/'''?/g, ""),
  ).trim();
}
/** The target of a cell's first [[wikilink]] (e.g. "Glendale, Arizona"), which Wikipedia uses to
 * disambiguate same-named cities - more precise for geocoding than the cleaned display text. */
function wikiLinkTarget(raw) {
  const m = (raw ?? "").match(/\[\[([^|\]]*)(?:\|[^\]]*)?\]\]/);
  return m ? straighten(m[1]) : wikiClean(raw);
}
/** Normalize a song/work title for cross-matching originals, re-recordings and works. */
function normKey(s) {
  return straighten(s ?? "")
    .replace(/\(feat\.[^)]*\)/gi, "")
    .replace(/\(taylor'?s version\)/gi, "")
    .replace(/\(from the vault\)/gi, "")
    .replace(/["“”]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}
function prettyTitle(s) {
  return straighten(s)
    .replace(/\(taylor'?s version\)/gi, "(Taylor's Version)")
    .replace(/\(from the vault\)/gi, "(From The Vault)");
}
function featuredArtists(title) {
  const m = title.match(/\(feat\.?\s*([^)]+)\)/i);
  return m ? straighten(m[1]).trim() : null;
}
/** Names other than the main artist on a track's artist-credit (MusicBrainz's structured
 * "featuring" data), falling back to a "(feat. X)" title match when artist-credit is absent. */
function featuredFromTrack(t, title) {
  const credit = t["artist-credit"] ?? t.recording?.["artist-credit"];
  if (Array.isArray(credit) && credit.length > 1) {
    const others = credit.filter((c) => c.artist?.id !== ARTIST_MBID).map((c) => straighten(c.name));
    if (others.length) return others.join(", ");
  }
  return featuredArtists(title);
}

// ─────────────────────────────── 1. albums (MusicBrainz release-groups) ───────────────────────────────

// Verified against a live MusicBrainz fetch (2026-09-24): the 16 "no secondary type" release-groups
// that are Taylor Swift's actual studio albums and "Taylor's Version" re-recordings (one bogus
// fan-made "The Vault (deluxe)" release-group with the same empty secondary-types was excluded).
const ALBUM_DEFS = [
  { id: "debut", mbid: "ba1d0c2a-bb07-38bc-835c-a880f76f1309", title: "Taylor Swift", date: "2006-10-24", era: "Debut" },
  { id: "fearless", mbid: "63eba062-847c-3b73-8b0f-6baf27bba6fa", title: "Fearless", date: "2008-11-11", era: "Fearless" },
  { id: "speak-now", mbid: "ba1259eb-d41e-41c5-a70c-0e6fa73e6708", title: "Speak Now", date: "2010-10-25", era: "Speak Now" },
  { id: "red", mbid: "a73cecde-0923-40ad-aad1-e8c24ba6c3d2", title: "Red", date: "2012-08-10", era: "Red" },
  { id: "1989", mbid: "4d9ec1c2-58ec-48a4-aa0a-916718adead0", title: "1989", date: "2014-10-24", era: "1989" },
  { id: "reputation", mbid: "f060c8fd-bec9-426e-800e-8efc040a71e6", title: "reputation", date: "2017-11-10", era: "reputation" },
  { id: "lover", mbid: "30e9785b-7b50-4d29-b3d1-96fb55e3397f", title: "Lover", date: "2019-08-23", era: "Lover" },
  { id: "folklore", mbid: "f1d08326-c23b-4b43-be3b-20b33ab10bf6", title: "folklore", date: "2020-07-24", era: "folklore" },
  { id: "evermore", mbid: "e86d6219-f5a2-4edd-bf2b-3f9eab190ae0", title: "evermore", date: "2020-12-11", era: "evermore" },
  { id: "midnights", mbid: "0dcc84fb-c592-46e9-ba92-a52bb44dd553", title: "Midnights", date: "2022-10-21", era: "Midnights" },
  { id: "ttpd", mbid: "71c3eed6-466c-4aef-ad12-65a36d19467a", title: "The Tortured Poets Department", date: "2024-04-19", era: "The Tortured Poets Department" },
  { id: "showgirl", mbid: "9ae7e7e9-ac40-4874-bd43-d77a9bb9b617", title: "The Life of a Showgirl", date: "2025-10-03", era: "The Life of a Showgirl" },
  { id: "fearless-tv", mbid: "d2e4838d-90e1-471c-bda0-fd816dabb2d4", title: "Fearless (Taylor's Version)", date: "2021-04-09", era: "Fearless", original: "fearless" },
  { id: "red-tv", mbid: "67727253-f1c0-4243-9270-f9f1401c3b8c", title: "Red (Taylor's Version)", date: "2021-11-11", era: "Red", original: "red" },
  { id: "speak-now-tv", mbid: "0441b1b2-de57-4a9a-b007-1f6e159921d5", title: "Speak Now (Taylor's Version)", date: "2023-07-07", era: "Speak Now", original: "speak-now" },
  { id: "1989-tv", mbid: "1c4770b3-b7a3-4d44-a7a9-8e2dbb74b85a", title: "1989 (Taylor's Version)", date: "2023-10-27", era: "1989", original: "1989" },
];

/** Pick the release that best represents an album's canonical tracklist. */
function pickRelease(releases) {
  const total = (r) => (r.media ?? []).reduce((n, m) => n + (m["track-count"] ?? 0), 0);
  const isDigital = (r) => (r.media ?? []).some((m) => m.format === "Digital Media");
  const rank = (r) => (r.country === "XW" ? 0 : r.country === "US" ? 1 : 2);
  function modePick(pool) {
    if (!pool.length) return null;
    const counts = new Map();
    for (const r of pool) counts.set(total(r), (counts.get(total(r)) ?? 0) + 1);
    let bestN = -1, bestCount = -1;
    for (const [n, c] of counts) if (c > bestCount || (c === bestCount && n > bestN)) { bestCount = c; bestN = n; }
    const candidates = pool.filter((r) => total(r) === bestN);
    candidates.sort((a, b) => rank(a) - rank(b) || (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    return candidates[0];
  }
  const official = releases.filter((r) => r.status === "Official");
  return modePick(official.filter(isDigital)) ?? modePick(official) ?? modePick(releases);
}

console.log("Fetching artist...");
const artist = await mbJson(`artist/${ARTIST_MBID}`, "mb_artist.json");
if (artist.name !== "Taylor Swift") throw new Error(`unexpected artist name: ${artist.name}`);

console.log("Fetching albums (release-groups + releases)...");
const albums = []; // rows
const songs = []; // rows, song_id assigned after collecting all
const songsByAlbum = new Map(); // album id -> [{title, trackNumber, discNumber, durationS}]
for (const def of ALBUM_DEFS) {
  const releases = await mbAll(`release?release-group=${def.mbid}&inc=recordings+labels+artist-credits`, "releases", "release-count", `rel2_${def.id}`);
  const chosen = pickRelease(releases);
  if (!chosen) throw new Error(`no release found for ${def.id}`);
  const label = chosen["label-info"]?.find((li) => li.label?.name)?.label?.name ?? null;
  const tracks = [];
  (chosen.media ?? []).forEach((medium, discIdx) => {
    for (const t of medium.tracks ?? []) {
      // Skip spoken-word bonus tracks (e.g. a "Taylor Swift Interview" bonus track on one
      // regional debut-album release): not a song, and it skews duration-based questions.
      if (/\binterview\b/i.test(t.title)) continue;
      const durationMs = t.length ?? t.recording?.length ?? null;
      tracks.push({
        title: prettyTitle(t.title),
        trackNumber: Number(t.number) || t.position,
        discNumber: discIdx + 1,
        durationS: durationMs ? Math.round(durationMs / 1000) : null,
        featured: featuredFromTrack(t, t.title),
      });
    }
  });
  const totalMinutes = tracks.some((t) => t.durationS) ? Math.round((tracks.reduce((n, t) => n + (t.durationS ?? 0), 0) / 60) * 10) / 10 : null;
  albums.push([
    def.id, def.title, def.date, Number(def.date.slice(0, 4)), def.era,
    def.original ? 1 : 0, def.original ?? null, def.original ? "re-recording" : "studio",
    tracks.length, totalMinutes, label,
  ]);
  songsByAlbum.set(def.id, tracks);
  console.log(`  ${def.id.padEnd(14)} ${tracks.length} tracks (release ${chosen.id}, ${chosen.country ?? "?"}/${(chosen.media ?? []).map((m) => m.format).join("+")})`);
}

console.log("Fetching singles (for is_single)...");
const singleGroups = await mbAll(`release-group?artist=${ARTIST_MBID}&type=single`, "release-groups", "release-group-count", "singles");
const singleKeys = new Set(singleGroups.map((g) => normKey(g.title)));

for (const def of ALBUM_DEFS) {
  for (const t of songsByAlbum.get(def.id)) {
    songs.push({
      albumId: def.id,
      title: t.title,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      durationS: t.durationS,
      isVault: /from the vault/i.test(t.title) ? 1 : 0,
      isSingle: singleKeys.has(normKey(t.title)) ? 1 : 0,
      featured: t.featured,
      year: Number(def.date.slice(0, 4)),
    });
  }
}
songs.forEach((s, i) => (s.songId = i + 1));
const songIdsByKey = new Map(); // normKey(title) -> [songId,...]
for (const s of songs) {
  const k = normKey(s.title);
  if (!songIdsByKey.has(k)) songIdsByKey.set(k, []);
  songIdsByKey.get(k).push(s.songId);
}

// ─────────────────────────────── 2. songwriting credits (MusicBrainz works) ───────────────────────────────

console.log("Fetching works + writer credits...");
const works = await mbAll(`work?artist=${ARTIST_MBID}&inc=artist-rels`, "works", "work-count", "works");
const people = new Map(); // person_id (mbid) -> name
const credits = []; // {songId, personId, role}
const ROLE_TYPES = new Set(["writer", "composer", "lyricist"]);
for (const w of works) {
  const key = normKey(w.title);
  const songIds = songIdsByKey.get(key);
  if (!songIds) continue; // work not on any album release we captured (e.g. a promo-only recording)
  const rels = (w.relations ?? []).filter((r) => r["target-type"] === "artist" && ROLE_TYPES.has(r.type));
  for (const r of rels) {
    people.set(r.artist.id, straighten(r.artist.name));
    for (const songId of songIds) credits.push({ songId, personId: r.artist.id, role: r.type });
  }
}
console.log(`  ${works.length} works, ${people.size} people, ${credits.length} credit rows`);

// ─────────────────────────────── 3. awards (Wikidata) ───────────────────────────────

console.log("Fetching awards (Wikidata)...");
const WON_Q = `SELECT ?award ?awardLabel ?year ?forWorkLabel WHERE {
  wd:Q26876 p:P166 ?stmt . ?stmt ps:P166 ?award .
  OPTIONAL { ?stmt pq:P585 ?date . } OPTIONAL { ?stmt pq:P1686 ?forWork . }
  BIND(YEAR(?date) AS ?year)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?year`;
const NOM_Q = WON_Q.replace(/P166/g, "P1411");
const won = await wdSparql(WON_Q, "wd_awards_won.json");
const nominated = await wdSparql(NOM_Q, "wd_awards_nom.json");
const validRows = (rows) => rows.filter((b) => b.year?.value && !/^list of/i.test(b.awardLabel.value));
const wonValid = validRows(won);
const nomValid = validRows(nominated);

const awardQids = [...new Set([...wonValid, ...nomValid].map((b) => b.award.value.split("/").pop()))];
const CEREMONY_Q = `SELECT ?award ?ceremonyLabel WHERE {
  VALUES ?award { ${awardQids.map((id) => `wd:${id}`).join(" ")} }
  OPTIONAL { ?award wdt:P361 ?ceremony }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
const ceremonyRows = await wdSparql(CEREMONY_Q, "wd_ceremony.json");
const ceremonyByQid = new Map(ceremonyRows.map((b) => [b.award.value.split("/").pop(), b.ceremonyLabel?.value]));

const BRANDS = [
  [/^Grammy Award for (.+)$/i, "Grammy Awards"],
  [/^American Music Award for (.+)$/i, "American Music Awards"],
  [/^MTV Video Music Award for (.+)$/i, "MTV Video Music Awards"],
  [/^MTV Europe Music Award for (.+)$/i, "MTV Europe Music Awards"],
  [/^Country Music Association Award for (.+)$/i, "CMA Awards"],
  [/^BRIT Award for (.+)$/i, "BRIT Awards"],
  [/^iHeartRadio Music Award for (.+)$/i, "iHeartRadio Music Awards"],
];
function ceremonyCategory(label, ceremonyRaw) {
  let ceremony = ceremonyRaw && !/^list of/i.test(ceremonyRaw) ? ceremonyRaw : null;
  for (const [re, brand] of BRANDS) {
    const m = label.match(re);
    if (m) return { ceremony: ceremony ?? brand, category: m[1] };
  }
  if (!ceremony) {
    if (/^Billboard/i.test(label)) ceremony = "Billboard Awards";
    else if (/^Dick Clark/i.test(label)) ceremony = "American Music Awards";
    else if (/^GLAAD/i.test(label)) ceremony = "GLAAD Media Awards";
    else if (/Favorite Adult Contemporary/i.test(label)) ceremony = "American Music Awards";
    else ceremony = "Other";
  }
  return { ceremony, category: label };
}
const awards = [];
const seenAward = new Set();
let awardId = 1;
for (const [rows, result] of [[wonValid, "won"], [nomValid, "nominated"]]) {
  for (const b of rows) {
    const qid = b.award.value.split("/").pop();
    const { ceremony, category } = ceremonyCategory(b.awardLabel.value, ceremonyByQid.get(qid));
    const work = b.forWorkLabel?.value ? straighten(b.forWorkLabel.value) : null;
    const dedupeKey = `${Number(b.year.value)}|${ceremony}|${category}|${work}|${result}`;
    if (seenAward.has(dedupeKey)) continue;
    seenAward.add(dedupeKey);
    awards.push([awardId++, Number(b.year.value), ceremony, category, work, result]);
  }
}
console.log(`  ${awards.length} award rows`);

// ─────────────────────────────── 4. tours (Wikidata + Wikipedia infobox totals) ───────────────────────────────

console.log("Fetching tours (Wikidata)...");
const TOUR_Q = `SELECT ?tour ?tourLabel ?start ?end WHERE {
  ?tour wdt:P175 wd:Q26876 . ?tour wdt:P31 wd:Q1573906 .
  OPTIONAL { ?tour wdt:P580 ?start } OPTIONAL { ?tour wdt:P582 ?end }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?start`;
const tourRows = (await wdSparql(TOUR_Q, "wd_tours.json")).filter((b) => b.start?.value);
const TOUR_DEFS = [
  { id: "fearless-tour", label: "Fearless Tour", wikiTitle: "Fearless_Tour" },
  { id: "speak-now-tour", label: "Speak Now World Tour", wikiTitle: "Speak_Now_World_Tour" },
  { id: "red-tour", label: "The Red Tour", wikiTitle: "The_Red_Tour" },
  { id: "1989-tour", label: "The 1989 World Tour", wikiTitle: "The_1989_World_Tour" },
  { id: "reputation-tour", label: "Reputation Stadium Tour", wikiTitle: "Reputation_Stadium_Tour" },
  { id: "eras-tour", label: "The Eras Tour", wikiTitle: "The_Eras_Tour" },
];
if (tourRows.length !== TOUR_DEFS.length) throw new Error(`expected ${TOUR_DEFS.length} tours from Wikidata, got ${tourRows.length}`);
const wdTourByLabel = new Map(tourRows.map((b) => [b.tourLabel.value, b]));

function extractInfoboxField(wikitext, field) {
  const m = wikitext.match(new RegExp(`\\|\\s*${field}\\s*=\\s*([^\\n]+)`, "i"));
  return m ? m[1] : null;
}
function parseMoneyOrCount(raw) {
  if (!raw) return null;
  let s = raw.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "").split("(")[0];
  s = s.replace(/\{\{[^{}]*\}\}/g, "").replace(/&nbsp;/g, " ").trim();
  const m = s.match(/([\d,.]+)\s*(million|billion)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (/billion/i.test(m[2] ?? "")) n *= 1e9;
  else if (/million/i.test(m[2] ?? "")) n *= 1e6;
  return Math.round(n);
}

const tours = [];
for (const def of TOUR_DEFS) {
  const wd = wdTourByLabel.get(def.label);
  const start = wd.start.value.slice(0, 10);
  const end = wd.end?.value ? wd.end.value.slice(0, 10) : null;
  if (def.id === "eras-tour") {
    // The infobox omits attendance/gross (disputed while touring); use the tour's own final,
    // post-tour report as covered in the Wikipedia article's lead (Sisario, The New York Times,
    // Dec 2024): "the tour grossed $2.07 billion with an attendance of 10.1 million."
    tours.push([def.id, def.label, start, end, 149, 10100000, 2070000000]);
    continue;
  }
  const text = await wikiRaw(def.wikiTitle, `wiki_tour_${def.id}.wikitext`);
  const shows = Number(extractInfoboxField(text, "number_of_shows"));
  const attendance = parseMoneyOrCount(extractInfoboxField(text, "attendance"));
  const gross = parseMoneyOrCount(extractInfoboxField(text, "gross"));
  tours.push([def.id, def.label, start, end, shows || null, attendance, gross]);
}

// ─────────────────────────────── 5. Eras Tour dates (Wikipedia table) ───────────────────────────────

console.log("Fetching + parsing the Eras Tour date table (Wikipedia)...");
const erasText = await wikiRaw("The_Eras_Tour", "wiki_eras_tour_full.wikitext");
const erasLines = erasText.split("\n");

function extractWikitable(lines, caption) {
  const start = lines.findIndex((l) => l.startsWith(`|+${caption}`));
  if (start === -1) throw new Error(`Eras Tour: caption not found: ${caption}`);
  let end = start;
  while (lines[end].trim() !== "|}") end++;
  return lines.slice(start + 1, end);
}
function stripCellAttrs(raw) {
  let s = raw, rowspan = 1, colspan = 1, m;
  while ((m = s.match(/^\s*([a-zA-Z][\w-]*)="([^"]*)"/))) {
    if (m[1].toLowerCase() === "rowspan") rowspan = parseInt(m[2], 10) || 1;
    if (m[1].toLowerCase() === "colspan") colspan = parseInt(m[2], 10) || 1;
    s = s.slice(m[0].length);
  }
  s = s.replace(/^\s*\|/, "");
  return { rowspan, colspan, text: s.trim() };
}
/** Reconstruct a 6-column (Date, City, Country, Venue, Opening act(s), Attendance) wikitable,
 * expanding rowspan/colspan. */
function parseShowsTable(rowLines) {
  const NCOL = 6;
  const carry = new Array(NCOL).fill(null);
  const rows = [];
  let current = [];
  function flush() {
    if (!current.length) return;
    if (current.some((c) => /scope="col"/.test(c)) || /colspan=/.test(current[0] ?? "")) { current = []; return; }
    const cells = current.map(stripCellAttrs);
    const rowValues = new Array(NCOL).fill(null);
    let ci = 0, col = 0;
    while (col < NCOL) {
      if (carry[col] && carry[col].left > 0) {
        rowValues[col] = carry[col].value;
        carry[col].left -= 1;
        if (carry[col].left === 0) carry[col] = null;
        col += 1;
      } else if (ci < cells.length) {
        const cell = cells[ci++];
        for (let k = 0; k < cell.colspan && col + k < NCOL; k++) {
          rowValues[col + k] = cell.text;
          if (cell.rowspan > 1) carry[col + k] = { value: cell.text, left: cell.rowspan - 1 };
        }
        col += cell.colspan;
      } else col += 1;
    }
    rows.push(rowValues);
    current = [];
  }
  for (const line of rowLines) {
    if (line.startsWith("|-")) flush();
    else if (line.startsWith("!") || line.startsWith("|")) current.push(line.slice(1));
  }
  flush();
  return rows;
}
const rawShows = [
  ...parseShowsTable(extractWikitable(erasLines, "2023 shows")),
  ...parseShowsTable(extractWikitable(erasLines, "2024 shows")),
].map(([date, city, country, venue, , attendance]) => ({
  date: wikiClean(date), city: wikiClean(city), cityGeoTarget: wikiLinkTarget(city), country: wikiClean(country),
  venue: wikiClean(venue), attendanceRaw: wikiClean(attendance),
}));
if (rawShows.length !== 149) throw new Error(`expected 149 Eras Tour shows, parsed ${rawShows.length}`);

const COUNTRY_ISO3 = {
  "United States": "USA", Canada: "CAN", Mexico: "MEX", Argentina: "ARG", Brazil: "BRA",
  Japan: "JPN", Singapore: "SGP", Australia: "AUS", England: "GBR", Scotland: "GBR",
  Wales: "GBR", Ireland: "IRL", France: "FRA", Netherlands: "NLD", Germany: "DEU",
  Switzerland: "CHE", Italy: "ITA", Sweden: "SWE", Poland: "POL", Portugal: "PRT", Spain: "ESP",
};
// Wikipedia's own footnote on this table: Allegiant Stadium is in Paradise, NV, "labeled as Las
// Vegas in promotional material" — used here since fans know it that way, not invented.
const CITY_FRIENDLY = { "Paradise|United States": "Las Vegas" };

console.log("Geocoding Eras Tour cities (Nominatim, 1 req/s)...");
const placeCoords = new Map(); // "city|country" -> {lat,lon}
for (const show of rawShows) {
  const key = `${show.city}|${show.country}`;
  if (placeCoords.has(key)) continue;
  const countryCode = COUNTRY_ISO3[show.country];
  if (!countryCode) throw new Error(`Unmapped Eras Tour country "${show.country}" - add it to COUNTRY_ISO3`);
  // Prefer Wikipedia's own disambiguated wikilink target (e.g. "Glendale, Arizona") over the bare
  // display city, since several US stadium cities (Glendale, Arlington, Santa Clara, Inglewood,
  // East Rutherford...) share their name with a much larger namesake elsewhere.
  const q = `${show.cityGeoTarget}, ${show.country}`;
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const coords = await geocode(q, `nominatim_${slug}.json`);
  placeCoords.set(key, coords);
  if (!coords) console.warn(`  no geocode result for "${q}"`);
}

const tourShows = rawShows.map((show, i) => {
  const key = `${show.city}|${show.country}`;
  const coords = placeCoords.get(key);
  const attMatch = show.attendanceRaw.match(/^([\d,]+)\s*\//);
  return [
    i + 1, "eras-tour", show.date, CITY_FRIENDLY[key] ?? show.city, COUNTRY_ISO3[show.country], show.venue,
    attMatch ? Number(attMatch[1].replace(/,/g, "")) : null, coords?.lat ?? null, coords?.lon ?? null,
  ];
});

// ─────────────────────────────── 6. Easter eggs (own words, cited) ───────────────────────────────

// Every description below is written in this script's own words from the cited Wikipedia article
// (fetched above or separately checked the same way); no lyrics are reproduced or referenced by
// content, only song titles.
const EASTER_EGGS = [
  { album: "debut", category: "liner_notes",
    description: "Swift's 2006 debut album booklet capitalizes scattered letters inside each song's printed lyrics, spelling out hidden messages - a trick she said was inspired by the Beatles.",
    url: "https://en.wikipedia.org/wiki/Taylor_Swift_(album)" },
  { album: "fearless-tv", category: "liner_notes",
    description: "Colbie Caillat flew to Nashville to redo her guest vocal on \"Breathe\" for Fearless (Taylor's Version); fiddler Jonathan Yudkin and bassist Amos Heller reprised their 2008 parts too.",
    url: "https://en.wikipedia.org/wiki/Fearless_(Taylor%27s_Version)" },
  { album: "fearless-tv", category: "liner_notes",
    description: "Keith Urban played uncredited guitar and harmony vocals on \"We Were Happy\" after Swift asked him by text message; he is a credited guest only on \"That's When.\"",
    url: "https://en.wikipedia.org/wiki/Fearless_(Taylor%27s_Version)" },
  { album: "red-tv", category: "music",
    description: "Red (Taylor's Version)'s nine vault tracks include a ten-minute \"All Too Well\" plus solo versions of two songs, \"Better Man\" and \"Babe,\" that Swift had written for other artists.",
    url: "https://en.wikipedia.org/wiki/Red_(Taylor%27s_Version)" },
  { album: "1989-tv", category: "liner_notes",
    description: "Every 1989 (Taylor's Version) vault track was written and produced by Swift and Jack Antonoff except \"Say Don't Go,\" co-written with Diane Warren, a first-time collaborator.",
    url: "https://en.wikipedia.org/wiki/1989_(Taylor%27s_Version)" },
  { album: "speak-now-tv", category: "liner_notes",
    description: "Speak Now (Taylor's Version)'s two guest features, Fall Out Boy on \"Electric Touch\" and Hayley Williams on \"Castles Crumbling,\" both appear on vault tracks written years earlier.",
    url: "https://en.wikipedia.org/wiki/Speak_Now_(Taylor%27s_Version)" },
  { album: "reputation", category: "social_media",
    description: "In August 2017, after months of near silence, Swift wiped her social media and posted short videos of a CGI snake, teasing reputation before any title was announced.",
    url: "https://en.wikipedia.org/wiki/Reputation_(album)" },
  { album: "reputation", category: "album_art",
    description: "Reputation's cover is a black-and-white photo of Swift with her name printed repeatedly across her face in a newspaper-style font, widely read as mocking tabloid coverage of her.",
    url: "https://en.wikipedia.org/wiki/Reputation_(album)" },
  { album: "midnights", category: "social_media",
    description: "Before Midnights came out, Swift's nightly TikTok videos revealed one track title at a time, sending fans hunting through each clip for hidden clues about the album.",
    url: "https://en.wikipedia.org/wiki/Midnights" },
  { album: "midnights", category: "music",
    description: "Midnights' \"Question...?\" contains a sample of \"Out of the Woods\" from 1989; both songs were written and produced by Swift together with Jack Antonoff.",
    url: "https://en.wikipedia.org/wiki/Midnights" },
  { album: "ttpd", category: "social_media",
    description: "To promote The Tortured Poets Department, QR-code murals appeared in cities worldwide, including Chicago and Sao Paulo, each linking to its own unlisted YouTube teaser video.",
    url: "https://en.wikipedia.org/wiki/The_Tortured_Poets_Department" },
  { album: "ttpd", category: "social_media",
    description: "Apple Music marked the album's release with five Swift-curated playlists of her older songs, one for each of the five stages of grief.",
    url: "https://en.wikipedia.org/wiki/The_Tortured_Poets_Department" },
  { album: "folklore", category: "lyrics",
    description: "Swift said she hid Easter eggs directly in folklore's lyrics, building a \"Teenage Love Triangle\": three songs telling the same story from three different characters' points of view.",
    url: "https://en.wikipedia.org/wiki/Folklore_(Taylor_Swift_album)" },
  { album: "folklore", category: "lyrics",
    description: "The love-triangle characters in folklore's \"Cardigan,\" \"Betty\" and \"August\" are named Betty, James and Inez - the same names as the daughters of Swift's friends Blake Lively and Ryan Reynolds.",
    url: "https://en.wikipedia.org/wiki/Folklore_(Taylor_Swift_album)" },
];
for (const e of EASTER_EGGS) {
  const words = e.description.split(/\s+/).length;
  if (words > 30) throw new Error(`easter egg over 30 words (${words}): ${e.description}`);
}

// ─────────────────────────────── write the database ───────────────────────────────

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE albums (
  album_id            TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  release_date        TEXT NOT NULL,
  year                INTEGER NOT NULL,
  era                 TEXT NOT NULL,
  is_taylors_version  INTEGER NOT NULL,
  original_album_id   TEXT REFERENCES albums(album_id),
  album_type          TEXT NOT NULL CHECK (album_type IN ('studio','re-recording')),
  track_count         INTEGER NOT NULL,
  total_minutes       REAL,
  label               TEXT
);
CREATE TABLE songs (
  song_id           INTEGER PRIMARY KEY,
  album_id          TEXT NOT NULL REFERENCES albums(album_id),
  title             TEXT NOT NULL,
  track_number      INTEGER NOT NULL,
  disc_number       INTEGER NOT NULL,
  duration_s        INTEGER,
  is_vault_track    INTEGER NOT NULL,
  is_single         INTEGER NOT NULL,
  featured_artists  TEXT,
  year              INTEGER NOT NULL
);
CREATE TABLE people (
  person_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL
);
CREATE TABLE credits (
  song_id    INTEGER NOT NULL REFERENCES songs(song_id),
  person_id  TEXT NOT NULL REFERENCES people(person_id),
  role       TEXT NOT NULL CHECK (role IN ('writer','composer','lyricist')),
  PRIMARY KEY (song_id, person_id, role)
);
CREATE TABLE awards (
  award_id  INTEGER PRIMARY KEY,
  year      INTEGER NOT NULL,
  ceremony  TEXT NOT NULL,
  category  TEXT NOT NULL,
  work      TEXT,
  result    TEXT NOT NULL CHECK (result IN ('won','nominated'))
);
CREATE TABLE tours (
  tour_id          TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  shows            INTEGER,
  total_attendance INTEGER,
  gross_usd        INTEGER
);
CREATE TABLE tour_shows (
  show_id       INTEGER PRIMARY KEY,
  tour_id       TEXT NOT NULL REFERENCES tours(tour_id),
  date          TEXT NOT NULL,
  city          TEXT NOT NULL,
  country_code  TEXT NOT NULL,
  venue         TEXT NOT NULL,
  attendance    INTEGER,
  latitude      REAL,
  longitude     REAL
);
CREATE TABLE easter_eggs (
  egg_id      INTEGER PRIMARY KEY,
  album_id    TEXT REFERENCES albums(album_id),
  song_id     INTEGER REFERENCES songs(song_id),
  category    TEXT NOT NULL,
  description TEXT NOT NULL,
  source_url  TEXT NOT NULL
);
CREATE INDEX idx_songs_album ON songs(album_id);
CREATE INDEX idx_credits_person ON credits(person_id);
CREATE INDEX idx_tour_shows_tour ON tour_shows(tour_id);
CREATE INDEX idx_awards_year ON awards(year);

-- Flat convenience views: everything a chart usually needs from one table.
CREATE VIEW song_facts AS
SELECT s.song_id, s.title AS song, a.album_id, a.title AS album, a.era, a.is_taylors_version,
       a.album_type, s.track_number, s.disc_number, s.duration_s, s.is_vault_track, s.is_single,
       s.featured_artists, s.year
FROM songs s JOIN albums a ON a.album_id = s.album_id;

CREATE VIEW credit_facts AS
SELECT c.song_id, s.title AS song, s.album_id, a.title AS album, c.person_id, p.name AS person, c.role
FROM credits c
JOIN people p ON p.person_id = c.person_id
JOIN songs s ON s.song_id = c.song_id
JOIN albums a ON a.album_id = s.album_id;
`;

const db = await openDb(OUT);
db.exec(DDL);
insertMany(db, "INSERT INTO albums VALUES (?,?,?,?,?,?,?,?,?,?,?)", albums);
insertMany(db, "INSERT INTO songs VALUES (?,?,?,?,?,?,?,?,?,?)",
  songs.map((s) => [s.songId, s.albumId, s.title, s.trackNumber, s.discNumber, s.durationS, s.isVault, s.isSingle, s.featured, s.year]));
insertMany(db, "INSERT INTO people VALUES (?,?)", [...people.entries()]);
insertMany(db, "INSERT INTO credits VALUES (?,?,?)",
  [...new Map(credits.map((c) => [`${c.songId}|${c.personId}|${c.role}`, c])).values()].map((c) => [c.songId, c.personId, c.role]));
insertMany(db, "INSERT INTO awards VALUES (?,?,?,?,?,?)", awards);
insertMany(db, "INSERT INTO tours VALUES (?,?,?,?,?,?,?)", tours);
insertMany(db, "INSERT INTO tour_shows VALUES (?,?,?,?,?,?,?,?,?)", tourShows);
insertMany(db, "INSERT INTO easter_eggs VALUES (?,?,?,?,?,?)",
  EASTER_EGGS.map((e, i) => [i + 1, e.album, e.song ?? null, e.category, e.description, e.url]));

db.exec("CREATE TABLE _about (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
insertMany(db, "INSERT INTO _about VALUES (?,?)", [
  ["title", "Taylor Swift"],
  ["source", "MusicBrainz (musicbrainz.org, CC0) - albums, tracklists, songwriting credits; Wikidata (query.wikidata.org, CC0) - awards, tours; Wikipedia (en.wikipedia.org, CC BY-SA 4.0) - Eras Tour dates, tour totals, Easter-egg facts; OpenStreetMap Nominatim - city coordinates."],
  ["license", "CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/ (the least permissive of the sources used, per Wikipedia's own licence)"],
  ["attribution", "Discography and credits: MusicBrainz contributors (CC0). Awards and tours: Wikidata contributors (CC0). Tour dates, totals and Easter-egg facts: Wikipedia contributors, CC BY-SA 4.0 (https://en.wikipedia.org/wiki/Taylor_Swift and linked articles). Not endorsed by or affiliated with Taylor Swift."],
  ["built_at", new Date().toISOString()],
]);

const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
if (fkErrors.length) throw new Error(`FK violations: ${JSON.stringify(fkErrors.slice(0, 5))}`);
db.exec("ANALYZE; VACUUM;");
for (const t of ["albums", "songs", "people", "credits", "awards", "tours", "tour_shows", "easter_eggs"])
  console.log(t.padEnd(14), db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
db.close();
console.log("wrote", OUT);

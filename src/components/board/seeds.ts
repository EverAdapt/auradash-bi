/**
 * OWNER: ask-board. The public showcase board: a curated arrangement across all four bundled
 * datasets, shown on a true first visit and by "Reset to examples". Every pin carries its own
 * hand-written SQL (verified against data/*.sqlite) instead of a fixture — the board re-runs each
 * pin's SQL on load anyway (see PinCard), so there is nothing a fixture would add except staleness.
 * A top strip of four KPI cards, then six showcase charts, one per chart family, spanning
 * population, prizes, sport and music so the demo reads as "nice stats", not one dataset's fixture
 * dump.
 */
import type { ChartSpec, Pin, PinLayout, ResultColumnMeta } from "@shared/contract"

interface SeedDef {
  id: string
  datasetId: string
  question: string
  title: string
  subtitle?: string
  sql: string
  columns: ResultColumnMeta[]
  chart: ChartSpec
  layout: PinLayout
}

const SEEDS: SeedDef[] = [
  // ── KPI strip ──────────────────────────────────────────────────────────────────────
  {
    id: "world_population_now_vs_1986",
    datasetId: "world",
    question: "World population, 1986 vs 2025",
    title: "World population, 1986 vs 2025",
    sql: `SELECT "year" AS "year", "population" AS "population"
FROM "aggregate_year"
WHERE "aggregate_code" = 'WLD' AND "year" IN (1986, 2025)
ORDER BY "year"`,
    columns: [
      { name: "year", label: "Year", kind: "time" },
      { name: "population", label: "Population", kind: "amount", unit: "people" },
    ],
    chart: { type: "kpi", x: "year", y: ["population"] },
    layout: { x: 0, y: 0, w: 3, h: 4 },
  },
  {
    id: "nobel_laureates_since_1901",
    datasetId: "nobel",
    question: "How many Nobel laureates have there been since 1901?",
    title: "Nobel laureates since 1901",
    sql: `SELECT COUNT(DISTINCT "laureate_id") AS "laureates" FROM "awards"`,
    columns: [{ name: "laureates", label: "Laureates", kind: "amount", format: "number" }],
    chart: { type: "kpi", y: ["laureates"] },
    layout: { x: 3, y: 0, w: 3, h: 4 },
  },
  {
    id: "afl_matches_since_1897",
    datasetId: "afl",
    question: "How many AFL matches have there been since 1897?",
    title: "AFL matches since 1897",
    sql: `SELECT COUNT(*) AS "matches" FROM "matches"`,
    columns: [{ name: "matches", label: "Matches", kind: "amount", format: "number" }],
    chart: { type: "kpi", y: ["matches"] },
    layout: { x: 6, y: 0, w: 3, h: 4 },
  },
  {
    id: "eras_tour_shows",
    datasetId: "swift",
    question: "How many shows has the Eras Tour played?",
    title: "Eras Tour shows",
    sql: `SELECT COUNT(*) AS "shows" FROM "tour_shows" WHERE "tour_id" = 'eras-tour'`,
    columns: [{ name: "shows", label: "Shows", kind: "amount", format: "number" }],
    chart: { type: "kpi", y: ["shows"] },
    layout: { x: 9, y: 0, w: 3, h: 4 },
  },

  // ── showcase charts ────────────────────────────────────────────────────────────────
  {
    id: "internet_users_by_country",
    datasetId: "world",
    question: "Internet users by country",
    title: "Internet users by country, 2024",
    subtitle: "Share of the population online",
    sql: `SELECT cy."country_code" AS "geo", c."name" AS "country", cy."internet_pct" AS "internet_users"
FROM "country_year" cy
JOIN "countries" c ON c."country_code" = cy."country_code"
WHERE cy."year" = 2024 AND cy."internet_pct" IS NOT NULL
ORDER BY cy."internet_pct" DESC`,
    columns: [
      { name: "geo", label: "Country code", kind: "geo_code" },
      { name: "country", label: "Country", kind: "category" },
      { name: "internet_users", label: "Internet users", kind: "amount", unit: "%", format: "percent" },
    ],
    chart: { type: "choropleth", geo: "geo", y: ["internet_users"], label: "country", percent: true },
    layout: { x: 0, y: 4, w: 12, h: 9 },
  },
  {
    id: "life_expectancy_by_region",
    datasetId: "world",
    question: "Life expectancy by region since 1960",
    title: "Life expectancy by region, 1960–2024",
    sql: `SELECT ay."year" AS "year", a."name" AS "region", ay."life_expectancy" AS "life_expectancy"
FROM "aggregate_year" ay
JOIN "aggregates" a ON a."aggregate_code" = ay."aggregate_code"
WHERE a."kind" = 'region' AND ay."year" >= 1960 AND ay."life_expectancy" IS NOT NULL
ORDER BY ay."year" ASC`,
    columns: [
      { name: "year", label: "Year", kind: "time" },
      { name: "region", label: "Region", kind: "category" },
      { name: "life_expectancy", label: "Life expectancy", kind: "amount", unit: "years" },
    ],
    chart: { type: "multi_line", x: "year", series: "region", y: ["life_expectancy"] },
    layout: { x: 0, y: 13, w: 6, h: 8 },
  },
  {
    id: "clubs_most_premierships",
    datasetId: "afl",
    question: "Which clubs have won the most premierships?",
    title: "Clubs with the most premierships",
    sql: `SELECT c."name" AS "club", COUNT(*) AS "premierships"
FROM "matches" m
JOIN "clubs" c ON c."club_id" = m."winner_club_id"
WHERE m."is_grand_final" = 1
GROUP BY m."winner_club_id"
ORDER BY "premierships" DESC
LIMIT 10`,
    columns: [
      { name: "club", label: "Club", kind: "category" },
      { name: "premierships", label: "Premierships", kind: "amount", format: "number" },
    ],
    chart: { type: "hbar", x: "club", y: ["premierships"] },
    layout: { x: 6, y: 13, w: 6, h: 8 },
  },
  {
    id: "eras_tour_map",
    datasetId: "swift",
    question: "Where did the Eras Tour play?",
    title: "Where the Eras Tour played",
    sql: `SELECT ("venue" || ', ' || "city") AS "location", "latitude" AS "latitude", "longitude" AS "longitude", "attendance" AS "attendance"
FROM "tour_shows"
WHERE "tour_id" = 'eras-tour'`,
    columns: [
      { name: "location", label: "Venue", kind: "category" },
      { name: "latitude", label: "Latitude", kind: "latitude" },
      { name: "longitude", label: "Longitude", kind: "longitude" },
      { name: "attendance", label: "Attendance", kind: "amount", unit: "people" },
    ],
    chart: { type: "point_map", lat: "latitude", lon: "longitude", size: "attendance", label: "location" },
    layout: { x: 0, y: 21, w: 7, h: 9 },
  },
  {
    id: "prizes_by_category_decade",
    datasetId: "nobel",
    question: "Nobel prizes by category and decade",
    title: "Nobel prizes by category and decade",
    sql: `SELECT (CAST(p."decade" AS TEXT) || 's') AS "decade", c."name" AS "category", COUNT(*) AS "prizes"
FROM "prizes" p
JOIN "categories" c ON c."category_id" = p."category_id"
WHERE p."is_awarded" = 1
GROUP BY p."decade", c."name"
ORDER BY p."decade" ASC`,
    columns: [
      { name: "decade", label: "Decade", kind: "category" },
      { name: "category", label: "Category", kind: "category" },
      { name: "prizes", label: "Prizes", kind: "amount", format: "number" },
    ],
    chart: { type: "heatmap", x: "decade", series: "category", y: ["prizes"] },
    layout: { x: 7, y: 21, w: 5, h: 9 },
  },
  {
    id: "songs_per_album",
    datasetId: "swift",
    question: "How many songs are on each Taylor Swift album?",
    title: "Songs per Taylor Swift album",
    sql: `SELECT al."title" AS "album", COUNT(*) AS "songs"
FROM "songs" so
JOIN "albums" al ON al."album_id" = so."album_id"
WHERE al."album_type" = 'studio'
GROUP BY al."album_id"
ORDER BY "songs" DESC`,
    columns: [
      { name: "album", label: "Album", kind: "category" },
      { name: "songs", label: "Songs", kind: "amount", format: "number" },
    ],
    chart: { type: "hbar", x: "album", y: ["songs"] },
    layout: { x: 0, y: 30, w: 12, h: 8 },
  },
]

export function buildSeedPins(): {
  pins: Pin[]
  layouts: Record<string, PinLayout>
} {
  const pins: Pin[] = []
  const layouts: Record<string, PinLayout> = {}

  SEEDS.forEach((seed, i) => {
    const id = `seed_${seed.id}`
    pins.push({
      id,
      datasetId: seed.datasetId,
      question: seed.question,
      title: seed.title,
      subtitle: seed.subtitle,
      plan: null,
      sql: seed.sql,
      params: [],
      columns: seed.columns,
      chart: seed.chart,
      chartRanking: [{ type: seed.chart.type, p: 1 }],
      createdAt: new Date(2026, 0, 1, i).toISOString(),
    })
    layouts[id] = seed.layout
  })

  return { pins, layouts }
}

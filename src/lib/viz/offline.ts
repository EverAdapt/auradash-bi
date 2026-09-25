/**
 * OWNER: charts. Rule-based chart ranking used when Jev is unavailable (no key, rate limited,
 * timeout). Cheap heuristics over the same profile Jev would see; probabilities always sum to 1
 * over the eligible set so decideChart never has to special-case "no ranking".
 */
import type { ChartType, ResultProfile } from "@shared/contract"
import { groupColumns, pickChannels } from "./helpers"

const SHARE_WORDS = /\b(share|split|proportion|percentage|breakdown)\b/i

/** Rank `eligible` types by a handful of shape/question heuristics. Order-stable, sums to 1. */
export function offlineRank(
  profile: ResultProfile,
  question: string,
  eligible: ChartType[]
): { type: ChartType; p: number }[] {
  const g = groupColumns(profile)
  const { x, series, amounts } = pickChannels(profile)
  const rows = profile.rowCount
  const wantsShare = SHARE_WORDS.test(question)

  const scores = new Map<ChartType, number>()
  for (const t of eligible) scores.set(t, 0.1) // every eligible type keeps some mass
  const bump = (t: ChartType, amount: number) => {
    if (scores.has(t)) scores.set(t, scores.get(t)! + amount)
  }

  // kpi for a single row, or a two-point "latest vs earlier" time comparison (year 1986 vs
  // 2025-style questions) — a two-point line is too thin to read as a trend, so KPI wins it.
  if (rows === 1 && amounts.length <= 2) bump("kpi", 3)
  if (rows === 2 && g.dims.length === 1 && g.time.length === 1 && amounts.length === 1) bump("kpi", 2.5)

  // line for a lone time series; multi_line once a series column rides along.
  if (g.dims.length === 1 && g.time.length === 1 && amounts.length === 1) bump("line", 2)
  if (g.time.length === 1 && series) {
    bump("multi_line", 2.5)
    bump("line", -1) // multi_line already explains the shape better
  }

  // choropleth once there is enough geographic spread to bother with a map.
  if (g.geo.length === 1 && rows >= 20) bump("choropleth", 2)

  // hbar once a ranking has more categories than comfortably fit as columns.
  if (g.category.length === 1 && g.dims.length === 1 && (x?.distinct ?? 0) > 8) bump("hbar", 1.5)
  else if (g.category.length === 1 && g.dims.length === 1) bump("bar", 1)

  // donut only for a small, explicitly "share of" question.
  if (rows <= 6 && wantsShare) bump("donut", 2.5)

  // point_map beats a generic scatter whenever real coordinates are present.
  if (g.lat.length === 1 && g.lon.length === 1) bump("point_map", 2)

  // more amounts -> richer relationship chart.
  if (amounts.length >= 3) bump("bubble", 1.5)
  else if (amounts.length >= 2) bump("scatter", 1.5)

  // histogram once the shape looks binned (one label/bin dim plus counts).
  if (g.dims.length <= 1 && amounts.length >= 1 && rows >= 4 && rows <= 60) bump("histogram", 1)

  const total = [...scores.values()].reduce((a, b) => a + Math.max(b, 0), 0) || 1
  return eligible
    .map((type) => ({ type, p: Math.max(scores.get(type) ?? 0.1, 0) / total }))
    .sort((a, b) => b.p - a.p)
}

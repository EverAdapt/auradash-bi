/**
 * OWNER: charts. The second Jev call: code already narrowed the result to `eligibleCharts`, Jev
 * (or the offline ranking) only ranks among those. See docs/research/jev-nl2sql.md "Call 2".
 */
import type { ChartRequest, ChartResponse, ChartType, DatasetId, JevMeta, ResultProfile } from "@shared/contract"
import { JevUnavailable, postChart } from "@/lib/jev/client"
import { chartCriteria } from "./criteria"
import { eligibleCharts } from "./eligible"
import { offlineRank } from "./offline"

export interface ChartDecision {
  type: ChartType
  /** eligible types ordered by Jev's probability (or the offline ranking) */
  ranking: { type: ChartType; p: number }[]
  meta: JevMeta
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

function offlineMeta(reason: string): JevMeta {
  return { source: "offline", model: "jev-offline", latencyMs: 0, questionCount: 0, reason }
}

async function rankEligible(
  question: string,
  datasetId: DatasetId,
  profile: ResultProfile,
  eligible: ChartType[],
  signal?: AbortSignal
): Promise<{ ranking: { type: ChartType; p: number }[]; meta: JevMeta }> {
  const request: ChartRequest = {
    datasetId,
    question,
    result: {
      row_count: profile.rowCount,
      columns: profile.columns.map((c) => ({ name: c.name, kind: c.kind, distinct: c.distinct, unit: c.unit })),
      first_rows: profile.firstRows.slice(0, 8),
    },
    // Only the eligible types are ever shown to Jev, keyed by the shared criterion wording.
    eligible: eligible.reduce<ChartRequest["eligible"]>((acc, t) => {
      acc[t] = chartCriteria[t]
      return acc
    }, {}),
  }

  let res: ChartResponse
  try {
    res = await postChart(request, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    const reason = err instanceof JevUnavailable ? err.reason : "error"
    return { ranking: offlineRank(profile, question, eligible), meta: offlineMeta(reason) }
  }

  const ranking = eligible
    .map((type) => ({ type, p: res.answer.probabilities[type] ?? 0 }))
    .sort((a, b) => b.p - a.p)
  // Every eligible option was in Jev's criteria, so some mass should have landed on one of them;
  // fall back rather than surface an all-zero ranking if that ever isn't true.
  if ((ranking[0]?.p ?? 0) > 0) return { ranking, meta: res.meta }
  return { ranking: offlineRank(profile, question, eligible), meta: res.meta }
}

export async function decideChart(args: {
  question: string
  datasetId: DatasetId
  profile: ResultProfile
  /** a chart the user named in the question ("pie chart of ..."), from the plan */
  named?: ChartType
  signal?: AbortSignal
}): Promise<ChartDecision> {
  const { question, datasetId, profile, named, signal } = args
  const eligible = eligibleCharts(profile)

  // Nothing but `table` fits this shape: no ranking to do.
  if (eligible.length === 1) {
    const type = eligible[0]
    return { type, ranking: [{ type, p: 1 }], meta: offlineMeta("single eligible type") }
  }

  const { ranking, meta } = await rankEligible(question, datasetId, profile, eligible, signal)

  // A chart the user named explicitly wins when it's honestly eligible — the ranking (with its
  // runner-ups) is still returned so the dashboard card's chart switcher can offer them.
  if (named && eligible.includes(named)) return { type: named, ranking, meta }
  return { type: ranking[0]?.type ?? eligible[0], ranking, meta }
}

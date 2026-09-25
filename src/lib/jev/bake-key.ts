/**
 * OWNER: planner. Stable cache keys for baked Try-prompt answers (public/data/<id>.baked.json,
 * produced at merge time) and the client/Worker LRUs. The exact same normalization is used
 * wherever a key is computed: here (client lookups) and by whatever bakes the file.
 */
import type { ChartRequest, PlanRequest } from "@shared/contract"

/** lowercase, trim, collapse whitespace — stable across "Which  categories?" vs "which categories?" */
export function normalizedQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ")
}

/** `datasetId|schemaHash|normalizedQuestion` */
export function planBakeKey(req: Pick<PlanRequest, "datasetId" | "schemaHash" | "question">): string {
  return `${req.datasetId}|${req.schemaHash}|${normalizedQuestion(req.question)}`
}

/** `datasetId|normalizedQuestion|sorted eligible types|row_count` */
export function chartBakeKey(req: ChartRequest): string {
  const types = Object.keys(req.eligible).sort().join(",")
  return `${req.datasetId}|${normalizedQuestion(req.question)}|${types}|${req.result.row_count}`
}

/**
 * Real results of every curated prompt's reference SQL, captured by scripts/build-catalog.ts
 * from the bundled databases. Used by stubs, the chart gallery and local development.
 * Lead-owned: regenerate with `bun scripts/build-catalog.ts`, never edit by hand.
 */
import type { ChartType, DatasetId, ResultSet } from "@shared/contract"
import raw from "./try-results.json"

export interface FixtureEntry {
  datasetId: DatasetId
  text: string
  chart?: ChartType
  sql: string
  result: ResultSet
}

export const tryResults = raw as FixtureEntry[]

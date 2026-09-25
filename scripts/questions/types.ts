/**
 * OWNER: lead. Shape of the v0.2 feature questions run by `bun scripts/plan-cli.ts --v02`.
 * A question passes when it plans + compiles + runs, every `expect` regex matches the compiled
 * SQL (the feature really fired), and it returns at least `minRows` rows (default 1).
 */
export interface V02Question {
  dataset: string
  q: string
  /** each must match the executed SQL, e.g. /HAVING/, /LIKE/, /IS NULL/, /OVER \(/ */
  expect?: RegExp[]
  /** each must NOT match (e.g. a feature that must stay off for a plain question) */
  reject?: RegExp[]
  minRows?: number
}

/**
 * OWNER: planner. Zod schemas for the /api/plan and /api/chart request bodies, with caps that
 * keep a single request cheap for Jev and safe for the Worker: question <= 300 chars, <= 254
 * options per Choice-backed record, option text <= 400 chars, <= 16 filters, <= 8 numbers,
 * request body <= 64 KB (checked by the caller on the raw text before JSON.parse — see
 * `MAX_BODY_BYTES`).
 */
import { z } from "zod"
import { CHART_TYPES } from "./contract"

export const MAX_QUESTION_LEN = 300
export const MAX_OPTIONS = 254
export const MAX_OPTION_TEXT_LEN = 400
export const MAX_OPTION_EXAMPLES = 12
export const MAX_FILTERS = 16
export const MAX_NUMBERS = 8
/** v0.2: max thresholds / texts / or-pairs per request */
export const MAX_V02_CANDIDATES = 6
export const MAX_BODY_BYTES = 64 * 1024

const optionText = z.union([
  z.string().max(MAX_OPTION_TEXT_LEN),
  z.object({
    what: z.string().max(MAX_OPTION_TEXT_LEN),
    examples: z.array(z.string().max(MAX_OPTION_TEXT_LEN)).max(MAX_OPTION_EXAMPLES).optional(),
  }),
])

function optionRecord(maxOptions = MAX_OPTIONS) {
  return z
    .record(z.string().min(1).max(160), optionText)
    .refine((r) => Object.keys(r).length <= maxOptions, { message: `at most ${maxOptions} options` })
}

const filterRoleSchema = z.object({
  key: z.string().max(160),
  label: z.string().max(120),
  synonyms: z.array(z.string().max(60)).max(MAX_OPTION_EXAMPLES).optional(),
})

const filterCandidateSchema = z.object({
  id: z.string().min(1).max(16),
  kind: z.enum(["value", "year", "number", "now", "range", "period"]),
  column: z.string().max(160),
  field: z.string().max(120),
  value: z.string().max(MAX_OPTION_TEXT_LEN),
  value2: z.string().max(40).optional(),
  unit: z.enum(["year", "quarter", "month", "week", "day", "ytd"]).optional(),
  display: z.string().max(MAX_OPTION_TEXT_LEN),
  matched: z.string().max(MAX_OPTION_TEXT_LEN),
  roles: z.array(filterRoleSchema).max(8).optional(),
})

const thresholdCandidateSchema = z.object({
  id: z.string().min(1).max(16),
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "between"]),
  values: z.array(z.number().finite()).min(1).max(2),
  matched: z.string().max(MAX_OPTION_TEXT_LEN),
  display: z.string().max(MAX_OPTION_TEXT_LEN),
})

const textCandidateSchema = z.object({
  id: z.string().min(1).max(16),
  mode: z.enum(["contains", "starts", "ends", "exact"]),
  value: z.string().min(1).max(120),
  matched: z.string().max(MAX_OPTION_TEXT_LEN),
})

const orPairSchema = z.object({ id: z.string().min(1).max(16), a: z.string().min(1).max(16), b: z.string().min(1).max(16) })

const rankWindowSchema = z.object({
  id: z.string().min(1).max(16),
  from: z.number().int().min(1).max(100000),
  to: z.number().int().min(1).max(100000),
  matched: z.string().max(MAX_OPTION_TEXT_LEN),
})

export const planRequestSchema = z.object({
  datasetId: z.string().min(1).max(80),
  schemaHash: z.string().min(1).max(64),
  question: z.string().min(1).max(MAX_QUESTION_LEN),
  dataset: z.object({
    name: z.string().max(200),
    about: z.string().max(2000),
    contains: z.array(z.string().max(200)).max(60),
  }),
  measures: optionRecord(),
  dimensions: optionRecord(),
  timeGrains: z.array(z.enum(["none", "year", "decade", "quarter", "month", "day", "weekday", "month_of_year", "hour"])).max(9),
  rowTables: optionRecord(),
  sortColumns: optionRecord(),
  numbers: z.array(z.string().max(20)).max(MAX_NUMBERS),
  filters: z.array(filterCandidateSchema).max(MAX_FILTERS),
  // v0.2 — all optional so a v0.1 client's request still validates
  thresholds: z.array(thresholdCandidateSchema).max(MAX_V02_CANDIDATES).optional(),
  texts: z.array(textCandidateSchema).max(MAX_V02_CANDIDATES).optional(),
  orPairs: z.array(orPairSchema).max(MAX_V02_CANDIDATES).optional(),
  rankWindows: z.array(rankWindowSchema).max(2).optional(),
  cues: z.object({ missing: z.boolean(), rate: z.boolean(), change: z.boolean() }).optional(),
  nullableColumns: optionRecord().optional(),
  textColumns: optionRecord().optional(),
})

const resultColumnSchema = z.object({
  name: z.string().max(120),
  kind: z.enum(["time", "category", "amount", "geo_code", "latitude", "longitude", "text", "id"]),
  distinct: z.number().int().min(0),
  unit: z.string().max(60).optional(),
})

const cellSchema = z.union([z.string().max(2000), z.number(), z.null()])

export const chartRequestSchema = z.object({
  datasetId: z.string().min(1).max(80),
  question: z.string().min(1).max(MAX_QUESTION_LEN),
  result: z.object({
    row_count: z.number().int().min(0),
    columns: z.array(resultColumnSchema).max(20),
    first_rows: z.array(z.array(cellSchema).max(20)).max(8),
  }),
  // A genuinely partial map (a result is rarely eligible for all 15 chart types) — z.record with
  // an enum key schema validates as if every key were required, so use z.partialRecord instead.
  eligible: z
    .partialRecord(z.enum(CHART_TYPES), z.string().max(MAX_OPTION_TEXT_LEN))
    .refine((r) => Object.keys(r).length >= 1, { message: "at least one eligible chart type" }),
})

export type ValidatedPlanRequest = z.infer<typeof planRequestSchema>
export type ValidatedChartRequest = z.infer<typeof chartRequestSchema>

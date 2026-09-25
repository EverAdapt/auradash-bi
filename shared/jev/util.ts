/**
 * OWNER: lead (read-only for implementers). Small helpers shared by every Jev question module
 * (questions.ts, questions-filters.ts, questions-calc.ts), kept apart so those modules never
 * import each other.
 */
import type { ChoiceCriteria, ChoiceResponse } from "@typesafe-ai/sdk"
import type { Answer, OptionText } from "../contract"

export const NONE = "none" as const

export function toCriteria(options: Record<string, OptionText>): ChoiceCriteria {
  const out: ChoiceCriteria = {}
  for (const [k, v] of Object.entries(options)) out[k] = v as ChoiceCriteria[string]
  return out
}

/** A schema-derived option record plus its escape option. */
export function withEscape(options: Record<string, OptionText>, key: string, text: string): ChoiceCriteria {
  return { ...toCriteria(options), [key]: text }
}

export function toAnswer<T extends string>(r: ChoiceResponse): Answer<T> {
  return { value: r.choice as T, confidence: r.confidence, probabilities: { ...r.probabilities } }
}

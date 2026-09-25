/**
 * OWNER: lead (read-only for implementers — report a needed change). Generic English cues found by
 * code that GATE the cue-only Jev questions, so an ordinary question sends exactly as many Jev
 * questions as in v0.1. A cue only decides whether a question is ASKED; Jev still decides the
 * answer (every cue-gated Choice has a "none" escape), so a false positive costs one extra
 * question, never a wrong filter. Dataset-agnostic by construction: no dataset nouns here.
 */
import type { PlanRequest } from "@shared/contract"

/** "which laureates are still alive", "matches without a winner", "unknown birth country" */
const MISSING_RE =
  /\b(without|missing|unknown|unrecorded|not recorded|not yet|no longer|never|still|lacks?|lacking|empty|blank|null|unassigned|unset|undated|unnamed|alive|living|ongoing|unfinished|incomplete|pending|open|no\s+(?!more\b|less\b|fewer\b)[a-z]+)\b/i

/** "goals per game", "ratio of wins to losses", "for every 1,000 people", "per capita" */
const RATE_RE = /\b(per|rate|rates|ratio|for every|relative to|divided by|proportional|per capita)\b/i

/** "how has X grown", "change since 2000", "cumulative", "running total", "year over year" */
const CHANGE_RE =
  /\b(growth|grow|grows|grew|grown|growing|change|changes|changed|changing|increase|increased|increases|decrease|decreased|decreases|rise|rose|risen|fall|fell|fallen|drop|dropped|decline|declined|cumulative|cumulatively|running total|so far|to date|year[- ]over[- ]year|month[- ]over[- ]month|yoy|mom|compared (?:to|with) (?:the )?previous)\b/i

export function findCues(question: string): NonNullable<PlanRequest["cues"]> {
  return { missing: MISSING_RE.test(question), rate: RATE_RE.test(question), change: CHANGE_RE.test(question) }
}

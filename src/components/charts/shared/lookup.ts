/** OWNER: charts. Look up a ProfiledColumn by result-set name — every renderer needs this. */
import type { ProfiledColumn, ResultProfile } from "@shared/contract"

export function findColumn(profile: ResultProfile, name: string | undefined): ProfiledColumn | undefined {
  if (!name) return undefined
  return profile.columns.find((c) => c.name === name)
}

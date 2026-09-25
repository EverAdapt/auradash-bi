/** OWNER: charts. Shared prop shape every renderer takes; re-exported as `ChartViewProps`. */
import type { ChartSpec, ResultProfile, ResultSet } from "@shared/contract"

export interface RendererProps {
  spec: ChartSpec
  result: ResultSet
  profile: ResultProfile
  className?: string
  /** false while a dashboard card is dragged/resized, and under reduced motion */
  animate?: boolean
  /** tighter axes/legend for small dashboard cells */
  compact?: boolean
}

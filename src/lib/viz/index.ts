/**
 * OWNER: charts. Result → profile → eligible charts → Jev's pick → encoding. Pure TS: no
 * DOM/React, so bun scripts (Try-prompt baking, the plan CLI) can run the same code via
 * `bun:sqlite`. This file is the module's public surface — everything else here is internal.
 */
export { profileResult } from "./profile"
export { eligibleCharts } from "./eligible"
export { offlineRank } from "./offline"
export { decideChart, type ChartDecision } from "./decide"
export { encodeChart } from "./encode"
export { chartCriteria } from "./criteria"
export {
  formatAverage,
  formatAxisTick,
  formatCompact,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  formatTimeLabel,
  formatTooltipValue,
  formatValue,
  formatYear,
  humanizeLabel,
  type FormatKind,
} from "./format"

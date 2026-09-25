/**
 * OWNER: charts. One line per chart type, in the plain-English register Jev reads when choosing
 * among eligible types (docs/research/jev-nl2sql.md "Call 2: chart choice", CHARTS map, extended
 * from 11 to all 16 contract types). Also the source of truth for the chart registry's
 * `criterion` field, so the picker UI and the Jev prompt never drift apart.
 */
import type { ChartType } from "@shared/contract"

export const chartCriteria: Record<ChartType, string> = {
  kpi: "One big number with a label, or a latest value compared with an earlier one",
  bar: "Vertical bars comparing one amount across a few categories",
  hbar: "Horizontal bars ranking categories, good for many categories or long names",
  line: "A line showing how an amount changes over time",
  area: "A filled area showing a running or cumulative amount over time",
  multi_line: "One line per series over time, to compare trends",
  stacked_bar: "Bars split into segments, showing each category's share of a total across time or groups",
  grouped_bar: "Bars for two or more series side by side within each category or period",
  donut: "A ring split into slices showing each category's share of a whole, for up to about 8 categories",
  scatter: "Dots placing each item by two different amounts, to show a relationship",
  bubble: "Dots placed by two amounts and sized by a third, to compare many items at once",
  histogram: "Bars counting how many items fall in each range of one amount",
  heatmap:
    "A shaded grid of cells comparing an amount across two categories at once, e.g. category by decade; best when both have many values",
  choropleth:
    "A world map shading each country by the amount; the natural choice whenever there is one value per country for many countries",
  point_map: "A map with a dot at each place, sized by its amount when there is one; the natural choice when the rows are places with coordinates",
  table:
    "A plain table, only for lists of individual records with several descriptive fields, or when no chart can show the answer",
}

/**
 * OWNER: charts. "/charts" — every chart type rendered from real dataset results.
 *
 * Cards are built straight from src/fixtures/try-results.json through profileResult +
 * encodeChart, with no ResultColumnMeta given — the same inference path a raw SQL console result
 * would take, so this page also doubles as a visual proof that column inference holds up on real
 * data. A few cards reuse one fixture under two chart types on purpose (stacked_bar/heatmap both
 * read "women and men laureates by decade"; line/area both read a Nobel time series) since the
 * fixture set doesn't carry a dedicated result for every one of the 16 contract types.
 */
import type { ChartType } from "@shared/contract"
import { Link } from "wouter"
import { ArrowUpRight } from "lucide-react"
import { encodeChart, profileResult } from "@/lib/viz"
import { ChartView, chartRegistry } from "@/components/charts"
import { tryResults } from "@/fixtures"

interface CardDef {
  type: ChartType
  /** index into src/fixtures/try-results.json */
  fixture: number
}

// One card per contract chart type (CHART_TYPES has 16 entries) — order matches the registry.
const CARDS: CardDef[] = [
  { type: "kpi", fixture: 0 }, // How many women have won a Nobel Prize?
  { type: "bar", fixture: 1 }, // Which categories have the most prizes?
  { type: "hbar", fixture: 7 }, // Top 10 universities by Nobel prizes
  { type: "line", fixture: 10 }, // Average age at award per decade
  { type: "area", fixture: 8 }, // Prize money over time, adjusted for inflation
  { type: "multi_line", fixture: 12 }, // Life expectancy by region since 1960
  { type: "stacked_bar", fixture: 2 }, // Women and men laureates by decade
  { type: "grouped_bar", fixture: 19 }, // Renewable energy share by region, 2000 vs 2020
  { type: "donut", fixture: 16 }, // How is the world's population split by income group?
  { type: "scatter", fixture: 4 }, // Are laureates getting older? Age at award by year
  { type: "bubble", fixture: 13 }, // Do richer countries live longer?
  { type: "histogram", fixture: 3 }, // How old are laureates when they win?
  { type: "heatmap", fixture: 2 }, // Women and men laureates by decade (as a grid)
  { type: "choropleth", fixture: 5 }, // Which countries were the most laureates born in?
  { type: "point_map", fixture: 6 }, // Where were physics laureates born?
  { type: "table", fixture: 9 }, // Who has won more than once?
]

export default function GalleryPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-10">
      <header className="mb-7 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Charts</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Jev picks one of these for every answer. Here is each one on real data from the two datasets.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {CARDS.map((card) => {
          const fixture = tryResults[card.fixture]
          if (!fixture) return null

          const entry = chartRegistry[card.type]
          const Icon = entry.icon
          const profile = profileResult(fixture.result)
          const spec = encodeChart(card.type, profile)
          const params = new URLSearchParams({ d: fixture.datasetId, q: fixture.text })

          return (
            <article
              key={`${card.type}-${card.fixture}`}
              className="flex flex-col gap-3 rounded-[var(--radius-xl)] border border-border bg-card p-4 shadow-[var(--shadow-rest)] transition-shadow hover:shadow-[var(--shadow-lift)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-muted text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="truncate text-sm font-medium text-foreground">{entry.label}</span>
                </div>
                <Link
                  href={`/?${params.toString()}`}
                  className="flex shrink-0 items-center gap-0.5 rounded-full px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent"
                >
                  Try it
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Link>
              </div>

              <p className="line-clamp-2 text-xs text-muted-foreground">{fixture.text}</p>

              <div className="h-[260px] min-h-0 w-full">
                <ChartView spec={spec} result={fixture.result} profile={profile} className="h-full w-full" compact={false} />
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

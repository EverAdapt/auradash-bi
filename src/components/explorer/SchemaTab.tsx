/** OWNER: data-engine. Schema tab: the table's columns (type, role, stats, FK) plus its joins. */
import { Link } from "wouter"
import { ArrowRight } from "lucide-react"
import type { Catalog, CatalogTable, DatasetId } from "@shared/contract"
import { Badge } from "@/components/ui/badge"
import { formatCount } from "@/lib/db/format"

const ROLE_LABEL: Record<string, string> = {
  id: "ID",
  fk: "FK",
  dimension: "dimension",
  label: "label",
  time: "time",
  date: "date",
  measure: "measure",
  geo_code: "geo code",
  latitude: "latitude",
  longitude: "longitude",
  flag: "flag",
  text: "text",
  url: "url",
  order: "order",
  hidden: "hidden",
}

function nullPct(nullCount: number | undefined, rowCount: number): string {
  if (!nullCount || rowCount === 0) return "0%"
  return `${Math.round((nullCount / rowCount) * 100)}%`
}

function minMax(min?: number, max?: number): string {
  if (min === undefined && max === undefined) return "—"
  return `${min ?? "—"} – ${max ?? "—"}`
}

export function SchemaTab({ datasetId, catalog, table }: { datasetId: DatasetId; catalog: Catalog; table: CatalogTable }) {
  const joins = catalog.joins.filter((j) => j.from.startsWith(`${table.name}.`) || j.to.startsWith(`${table.name}.`))

  return (
    <div className="flex flex-col gap-8">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              {["Column", "Label", "Type", "Role", "Unit", "Distinct", "Nulls", "Min – max", "FK"].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.columns.map((c) => (
              <tr key={c.key} className="border-t border-border/60">
                <td className="px-3 py-1.5 font-mono text-xs">{c.name}</td>
                <td className="px-3 py-1.5">{c.label}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{c.sqlType || "—"}</td>
                <td className="px-3 py-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {ROLE_LABEL[c.role] ?? c.role}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{c.unit ?? "—"}</td>
                <td className="px-3 py-1.5 tabular-nums">{formatCount(c.distinctCount)}</td>
                <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{nullPct(c.nullCount, table.rowCount)}</td>
                <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{minMax(c.min, c.max)}</td>
                <td className="px-3 py-1.5">
                  {c.fk ? (
                    <Link href={`/explore/${datasetId}/${c.fk.split(".")[0]}`} className="font-mono text-xs text-brand hover:underline">
                      {c.fk}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Joins from this table</h3>
        {joins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No joins declared for this table.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {joins.map((j) => (
              <li key={`${j.from}>${j.to}`} className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-1.5 font-mono text-xs">
                <span>{j.from}</span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                <span>{j.to}</span>
                <span className="ml-auto text-muted-foreground">{j.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

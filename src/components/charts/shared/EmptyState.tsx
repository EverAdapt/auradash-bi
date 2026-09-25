/** OWNER: charts. The friendly "nothing to show" state every renderer falls back to. */
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { LucideIcon } from "lucide-react"

export function ChartEmptyState({
  icon: Icon,
  title = "No data",
  description = "This result doesn't have anything to plot yet.",
}: {
  icon: LucideIcon
  title?: string
  description?: string
}) {
  return (
    <Empty className="h-full min-h-[140px] flex-1 border-0 p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription className="text-xs">{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

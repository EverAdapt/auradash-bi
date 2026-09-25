/** OWNER: ask-board. "/" — the ask panel (Try chips, live preview, pin) above the pinned board. */
import { useEffect, useState } from "react"
import { EllipsisIcon, LayoutGridIcon } from "lucide-react"
import { AskPanel } from "@/components/ask/AskPanel"
import { BoardGrid } from "@/components/board/BoardGrid"
import { buildSeedPins } from "@/components/board/seeds"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { usePins } from "@/state/pins"

export default function DashboardPage() {
  const pins = usePins((s) => s.pins)
  const hasHydrated = usePins((s) => s.hasHydrated)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)

  // Seed the board with 6 example pins on a true first visit (no persisted board yet); a no-op
  // once the board has ever been seeded or explicitly cleared.
  useEffect(() => {
    if (!hasHydrated) return
    usePins.getState().seedIfNeeded(buildSeedPins())
  }, [hasHydrated])

  return (
    <div>
      <AskPanel />

      <div className="mx-auto max-w-[1240px] px-4 pb-16">
        <div className="flex items-center justify-end px-1 pb-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Board options">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  usePins.getState().resetToExamples(buildSeedPins())
                }
              >
                Reset to examples
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirmClearOpen(true)}
              >
                Clear all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {hasHydrated && pins.length === 0 ? (
          <Empty className="rounded-[20px] border border-dashed border-line-strong">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayoutGridIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing pinned yet</EmptyTitle>
              <EmptyDescription>
                Ask a question above, then press Enter to pin it here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <BoardGrid />
        )}
      </div>

      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear the dashboard?</DialogTitle>
            <DialogDescription>
              Every pinned card comes off your board. You can always ask for
              them again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmClearOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                usePins.getState().clearAll()
                setConfirmClearOpen(false)
              }}
            >
              Clear all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

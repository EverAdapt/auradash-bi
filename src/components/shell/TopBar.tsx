/**
 * OWNER: ask-board. The app shell's top bar: logo + wordmark, nav pills, dataset switcher, theme
 * toggle and a status dot. `h-14`, content capped at `max-w-[1240px]`. Collapses into a Sheet menu
 * below `md` so 375px has no horizontal scroll.
 */
import { useState } from "react"
import { Link, useLocation } from "wouter"
import { MenuIcon, MoonIcon, SparkleIcon, SunIcon } from "lucide-react"
import { useTheme } from "@/components/theme-provider"
import { APP_NAME } from "@/lib/site"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useJevStatus } from "@/lib/ask/jev-status-shim"
import { DatasetSwitcher } from "./DatasetSwitcher"

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/explore", label: "Explore" },
  { href: "/charts", label: "Charts" },
  { href: "/data", label: "Data" },
] as const

function isActive(location: string, href: string): boolean {
  if (href === "/") return location === "/"
  return location === href || location.startsWith(`${href}/`)
}

function NavPills({
  location,
  onNavigate,
}: {
  location: string
  onNavigate?: () => void
}) {
  return (
    <>
      {NAV_LINKS.map((link) => {
        const active = isActive(location, link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            className={
              active
                ? "rounded-full bg-secondary px-3 py-1.5 text-sm font-medium text-foreground"
                : "rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
            }
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        )
      })}
    </>
  )
}

function StatusDot() {
  const status = useJevStatus()
  const color =
    status.source === "jev"
      ? "bg-positive"
      : status.source === "cache" || status.source === "baked"
        ? "bg-brand"
        : status.source === "offline"
          ? "bg-caution"
          : "bg-muted-foreground/40"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-6 items-center justify-center"
          aria-hidden={false}
          aria-label={status.label}
        >
          <span className={`size-2 rounded-full ${color}`} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{status.label}</TooltipContent>
    </Tooltip>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const dark = theme === "dark"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme(dark ? "light" : "dark")}
        >
          {dark ? <MoonIcon /> : <SunIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Toggle theme (d)</TooltipContent>
    </Tooltip>
  )
}

export function TopBar() {
  const [location] = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="sticky top-0 z-40 h-14 border-b border-border bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-3 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-brand">
            <SparkleIcon className="size-4 text-white" />
          </span>
          <span className="text-[15px] font-[550] tracking-[-0.01em] text-foreground">
            {APP_NAME}
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          <NavPills location={location} />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block">
            <DatasetSwitcher />
          </div>
          <StatusDot />
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <MenuIcon />
          </Button>
        </div>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="right" className="w-72">
          <SheetHeader>
            <SheetTitle>{APP_NAME}</SheetTitle>
          </SheetHeader>
          <nav className="flex flex-col gap-1 px-4" aria-label="Primary">
            <NavPills
              location={location}
              onNavigate={() => setMenuOpen(false)}
            />
          </nav>
          <div className="mt-2 px-4">
            <DatasetSwitcher />
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}

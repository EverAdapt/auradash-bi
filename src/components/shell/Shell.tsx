/**
 * OWNER: ask-board. App shell: top bar, the routed page, footer. Calls `useDatasets.getState()
 * .refresh()` once on startup, and keeps the URL's `?d=` in sync with the current dataset after
 * the first load (the ask panel owns reading the *initial* `?q=`/`?d=`, per its own URL contract).
 */
import { useEffect, useRef } from "react"
import { useLocation, useSearch } from "wouter"
import { loadDemoFlag } from "@/lib/demo"
import { APP_NAME } from "@/lib/site"
import { useDatasets } from "@/state/datasets"
import { Footer } from "./Footer"
import { TopBar } from "./TopBar"

/** Page label per route, for the document title (e.g. "Explore · auradash-bi"). */
function pageTitle(location: string): string {
  if (location === "/") return "Dashboard"
  if (location.startsWith("/explore")) return "Explore"
  if (location.startsWith("/data")) return "Data"
  if (location.startsWith("/charts")) return "Charts"
  return "Not found"
}

export function Shell({ children }: { children: React.ReactNode }) {
  const datasetId = useDatasets((s) => s.currentId)
  const [location, navigate] = useLocation()
  const search = useSearch()
  const didMount = useRef(false)

  useEffect(() => {
    useDatasets.getState().refresh()
    void loadDemoFlag()
  }, [])

  useEffect(() => {
    document.title = `${pageTitle(location)} · ${APP_NAME}`
  }, [location])

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      return
    }
    const params = new URLSearchParams(search)
    if (params.get("d") === datasetId) return
    params.set("d", datasetId)
    navigate(`${location}?${params.toString()}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId])

  return (
    <div className="flex min-h-svh flex-col">
      <TopBar />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  )
}

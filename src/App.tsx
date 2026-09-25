/**
 * OWNER: ask-board. Routes + shell. Pages are lazy so charts, the explorer and the DB worker load
 * only when needed. The route table is part of the contract: keep these paths.
 */
import { lazy, Suspense } from "react"
import { Route, Switch } from "wouter"
import { Shell } from "@/components/shell/Shell"

const DashboardPage = lazy(() => import("@/pages/DashboardPage"))
const ExplorePage = lazy(() => import("@/pages/ExplorePage"))
const DataPage = lazy(() => import("@/pages/DataPage"))
const GalleryPage = lazy(() => import("@/pages/GalleryPage"))

export default function App() {
  return (
    <Shell>
      <Suspense fallback={null}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/explore/:datasetId?/:table?" component={ExplorePage} />
          <Route path="/data" component={DataPage} />
          <Route path="/charts" component={GalleryPage} />
          <Route>
            <div className="p-6">Not found</div>
          </Route>
        </Switch>
      </Suspense>
    </Shell>
  )
}

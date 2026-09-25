/**
 * OWNER: charts. World geometry (Natural Earth 110m, ISO3 feature ids) — fetched once and cached
 * at module scope, so switching between choropleth cards never re-downloads it.
 */
import type { FeatureCollection, Geometry } from "geojson"

export type WorldGeo = FeatureCollection<Geometry, { name?: string }>

let cached: Promise<WorldGeo> | null = null

export function loadWorldGeo(): Promise<WorldGeo> {
  if (!cached) {
    cached = fetch("/data/world-110m.iso3.geojson").then((res) => {
      if (!res.ok) throw new Error(`world geometry: HTTP ${res.status}`)
      return res.json() as Promise<WorldGeo>
    })
  }
  return cached
}

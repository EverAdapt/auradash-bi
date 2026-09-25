/**
 * OWNER: ask-board. Tiny LRU on Map insertion order (ported from shapeshift's `lib/lru.ts`).
 * Used by the ask pipeline's client cache, keyed by `${datasetId}::${normalized text}`.
 */
export class LRU<K, V> {
  #map = new Map<K, V>()
  #max: number
  constructor(max: number) {
    this.#max = max
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key)
    if (value === undefined) return undefined
    this.#map.delete(key)
    this.#map.set(key, value)
    return value
  }

  set(key: K, value: V) {
    this.#map.delete(key)
    this.#map.set(key, value)
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value
      if (oldest !== undefined) this.#map.delete(oldest)
    }
  }

  clear() {
    this.#map.clear()
  }
}

export const normalizeKey = (text: string) =>
  text.toLowerCase().replace(/\s+/g, " ").trim()

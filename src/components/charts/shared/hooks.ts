/** OWNER: charts. Small shared hooks: reduced-motion detection and a respectful count-up. */
import * as React from "react"

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return reduced
}

/**
 * Eases a number from its last value to `value` over ~600ms. When disabled (reduced motion, or
 * the caller opted out) it returns `value` directly and never touches animation state.
 */
export function useCountUp(value: number, enabled: boolean): number {
  const [display, setDisplay] = React.useState(value)
  const fromRef = React.useRef(value)

  React.useEffect(() => {
    if (!enabled) {
      fromRef.current = value
      return
    }
    const from = fromRef.current
    const to = value
    const duration = 600
    const start = performance.now()
    let raf = requestAnimationFrame(function tick(now: number) {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) * (1 - t) // ease-out quad
      setDisplay(from + (to - from) * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = to
    })
    return () => cancelAnimationFrame(raf)
  }, [value, enabled])

  return enabled ? display : value
}

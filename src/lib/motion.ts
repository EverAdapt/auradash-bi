/**
 * OWNER: ask-board. Ported verbatim from shapeshift's `src/lib/motion.ts` :
 * shared spring/tween presets so every enter/exit/crossfade in the ask panel and board feels like
 * one system. Respect `useReducedMotion()` at the call site — these presets don't do it themselves.
 */
import type { Transition } from "motion/react"

export const spring = {
  morph: { type: "spring", stiffness: 380, damping: 34, mass: 0.9 },
  settle: { type: "spring", stiffness: 260, damping: 30 },
  snappy: { type: "spring", stiffness: 520, damping: 38 },
  number: { stiffness: 180, damping: 26 },
} as const satisfies Record<
  string,
  Transition | { stiffness: number; damping: number }
>

/** Strong ease-out for UI (same curve as the CSS `--ease-out` / Tailwind `ease-out`). */
export const easeOut = [0.23, 1, 0.32, 1] as const

/**
 * Shared tweens. Exits are faster than enters and always ease-out; reduced motion keeps
 * a short opacity fade so state changes still read.
 */
export const tween = {
  /** Reduced-motion stand-in for any spring. */
  fade: { duration: 0.15, ease: easeOut },
  /** Content leaving (cards, chips, rows). */
  exit: { duration: 0.12, ease: easeOut },
  /** Swatch / placeholder crossfades. */
  crossfade: { duration: 0.24, ease: easeOut },
  /** Contextual icon swaps (better-ui): spring, no bounce. */
  icon: { type: "spring", duration: 0.3, bounce: 0 },
} as const satisfies Record<string, Transition>

/** Enter: fade + rise + unblur, the recurring "arrival" motion across the app. */
export const enterProps = {
  initial: { opacity: 0, y: 6, filter: "blur(4px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: {
    opacity: 0,
    scale: 0.98,
    filter: "blur(4px)",
    transition: tween.exit,
  },
} as const

/**
 * OWNER: ask-board. Tiny platform sniff for keyboard-shortcut labels: the ask panel and the pin
 * button both need to say "⌘" instead of "Ctrl" on macOS/iOS.
 */

/** True on macOS/iOS (Apple platforms use ⌘ for the "primary" modifier). */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData
  const platform = uaData?.platform || navigator.platform || navigator.userAgent || ""
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** The label for the "pin" modifier key: "⌘" on Apple platforms, "Ctrl" everywhere else. */
export function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl"
}

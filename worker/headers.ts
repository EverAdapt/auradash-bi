/**
 * OWNER: platform. Security headers applied to every Worker response (API routes; static assets
 * get the same values from public/_headers, which Workers static assets honour directly and which
 * must be kept in sync with SECURITY_HEADERS below by hand — it's plain text, not built from this).
 *
 * CSP is deliberately narrow: 'self' for everything, 'wasm-unsafe-eval' for the sqlite-wasm engine
 * (WebAssembly.instantiate needs it), 'unsafe-inline' only for style-src (Tailwind/shadcn inline
 * styles; the app ships no inline <script>), blob: for worker-src (the DB module worker is
 * constructed from a blob URL in some bundling paths) and img-src (canvas/chart exports).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com", // Cloudflare Web Analytics beacon
  "worker-src 'self' blob:",
  "connect-src 'self' https://cloudflareinsights.com",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
}

/** Applied to every /api/* response in addition to SECURITY_HEADERS — API responses are never cached. */
export const NO_STORE_HEADER = { "Cache-Control": "no-store" } as const

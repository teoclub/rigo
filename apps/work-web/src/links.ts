/**
 * Rigo Work Web safe-link policy (Issue 033; SPEC §7.5): external links and
 * Source URIs only use controlled URI schemes; everything else is rejected.
 *
 * @module @teoclub/work-web/links
 */

/** Controlled URI schemes for external links (SPEC §7.5). */
export const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'file:'])

/**
 * Sanitize a link href: relative paths and the safe schemes pass; anything
 * else (javascript:, data:, vbscript:, …) is rejected.
 * @param href - the raw href.
 * @returns the safe href, or `undefined` when rejected.
 */
export function safeLinkHref(href: string): string | undefined {
  if (typeof href !== 'string') return undefined
  const trimmed = href.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    // Relative references stay inside the same-origin app (SPEC §7.5
    // controlled schemes; the UI is same-origin with the API).
    return trimmed
  }
  try {
    const url = new URL(trimmed)
    return SAFE_LINK_SCHEMES.has(url.protocol) ? trimmed : undefined
  } catch {
    return undefined
  }
}

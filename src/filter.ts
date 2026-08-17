/**
 * The `publish.html` filter body.
 *
 * One pure function over the rendered document, so the whole feature is
 * testable without a CMS. The server entrypoint (`server/index.ts`) is a thin
 * wrapper that registers this with `api.cms.hooks.filter('publish.html', …)`.
 *
 * Order matters and is deliberate:
 *
 *   1. Substitute markers first, so step 2 can derive the CSP from what is
 *      actually in the finished document rather than from what we predicted.
 *   2. Bail out untouched if nothing was substituted — a page with no video
 *      keeps `frame-src 'none'` and gains no stylesheet.
 *   3. Inject the facade CSS.
 *   4. Widen `frame-src` with only the origins the surviving embeds need.
 */
import { EMBED_CSS, providersInHtml } from './embed'
import { addFrameSrcOrigins } from './csp'
import { substituteMarkers } from './marker'
import { frameSrcOriginsFor } from './providers'

/** Identifies our injected stylesheet so a re-run cannot duplicate it. */
const STYLE_MARKER = 'data-ive-styles'

/**
 * Insert the facade stylesheet into `<head>`.
 *
 * Idempotent: a document already carrying our marker attribute is returned
 * unchanged. If there is no `</head>` to insert before, the document is
 * returned untouched rather than having a `<style>` block bolted somewhere
 * arbitrary — a page whose shape we do not recognize is one we should not be
 * restructuring.
 *
 * Inline `<style>` is permitted by the publisher's base policy, which sets
 * `style-src 'self' 'unsafe-inline'`.
 */
function injectStyles(html: string): string {
  if (html.includes(STYLE_MARKER)) return html
  const tag = `<style ${STYLE_MARKER}>${EMBED_CSS}</style>`
  const headClose = html.indexOf('</head>')
  if (headClose === -1) return html
  return html.slice(0, headClose) + tag + html.slice(headClose)
}

export interface ApplyResult {
  html: string
  /** Markers replaced with an embed. */
  replaced: number
  /** Markers left in place because they did not parse. */
  skipped: number
  /** Origins added to `frame-src`, if any. */
  originsAdded: string[]
}

/**
 * Apply video embeds to one published document.
 *
 * Returns the document unchanged when it contains no valid marker. That is the
 * common case for most pages on a site, and it is what keeps this from being a
 * site-wide CSP widening.
 */
export function applyVideoEmbeds(html: string): ApplyResult {
  if (typeof html !== 'string' || html.length === 0) {
    return { html: typeof html === 'string' ? html : '', replaced: 0, skipped: 0, originsAdded: [] }
  }

  const substituted = substituteMarkers(html)

  if (substituted.replaced === 0) {
    return { html, replaced: 0, skipped: substituted.skipped, originsAdded: [] }
  }

  // Derive the CSP from the finished document rather than from the parse
  // results, so the policy can never be wider than what was actually emitted.
  const origins = frameSrcOriginsFor(providersInHtml(substituted.html))

  const withStyles = injectStyles(substituted.html)
  const withCsp = addFrameSrcOrigins(withStyles, origins)

  return {
    html: withCsp,
    replaced: substituted.replaced,
    skipped: substituted.skipped,
    originsAdded: origins,
  }
}

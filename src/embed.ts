/**
 * Embed markup generation.
 *
 * ## Escaping is our job, not the host's
 *
 * Instatic's docs state that module HTML is sanitized by the host. It is not:
 * `applyPublishedHtmlPipeline` runs no sanitizer over the assembled document
 * (DOMPurify is applied at the prop / richtext / SVG boundary and on media
 * upload, never to module `render()` output). Treat every string that reaches
 * this file as hostile and escape it here.
 *
 * The strongest protection is structural rather than lexical: the only
 * author-controlled value that ever reaches an `src` attribute is an embed URL
 * built by `buildEmbedUrl` from a hardcoded origin plus an id that matched a
 * strict allowlist. The raw pasted URL is never interpolated into markup. The
 * escaping below is the second line of defence, covering the free-text title
 * and the poster URL.
 */
import {
  buildEmbedUrl,
  PROVIDER_LABELS,
  type ParsedEmbed,
  type ProviderId,
} from './providers'

/**
 * Marker class on every embed we emit. The `publish.html` filter greps the
 * rendered document for this to decide whether a page needs its `frame-src`
 * widened at all.
 */
export const EMBED_MARKER_CLASS = 'ive-embed'

/**
 * Attribute carrying the provider id, so the filter can widen `frame-src` with
 * only the origins actually present on that page instead of all four.
 */
export const PROVIDER_ATTR = 'data-ive-provider'

/**
 * Escape a value for interpolation inside a double-quoted HTML attribute.
 *
 * Escapes `&` first (so we never double-encode), then `<`, `>`, `"` and `'`.
 * Quotes are the ones that actually matter for attribute-context breakout;
 * the angle brackets guard against a value that escapes the attribute
 * entirely being able to open a new tag.
 */
export function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Accept a poster image URL only if it is unambiguously safe to place in an
 * `src` attribute.
 *
 * Allowed: a site-relative path (`/uploads/...`) or an absolute `https:` URL.
 * Everything else — `javascript:`, `data:`, protocol-relative `//host`,
 * anything with whitespace or control characters — returns `null` and the
 * poster is simply omitted. A missing poster degrades to a black facade; a
 * bad one is a scripting vector, so the asymmetry is deliberate.
 *
 * `data:` is refused even though it cannot execute in `img[src]`, because
 * allowing it here invites copy-paste reuse in a context where it can.
 */
export function safePosterUrl(value: string): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  // No whitespace or control characters anywhere in a URL we will emit.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null

  // Protocol-relative URLs inherit the page scheme and hide their host.
  if (trimmed.startsWith('//')) return null

  // Site-relative path — the media library case.
  if (trimmed.startsWith('/')) return trimmed

  if (/^https:\/\/[^/?#]+/i.test(trimmed)) return trimmed

  return null
}

export interface RenderEmbedInput {
  parsed: ParsedEmbed
  /** Accessible iframe title. Falls back to "<Provider> video". */
  title?: string
  /** Optional poster image shown until the iframe loads. */
  posterUrl?: string
  /** Start playback automatically (muted). */
  autoplay?: boolean
  /**
   * Whether free-text props still need HTML-escaping.
   *
   * The publisher runs `escapeProps` over props BEFORE calling `render()`, and
   * it dispatches on the declared control type:
   *   - `url` / `image` props are scheme-checked but NOT HTML-escaped
   *   - every other type is `escapeHtml`-ed
   *
   * The editor canvas runs the module in the admin browser with RAW props and
   * no such pass. So the same string arrives pre-escaped on the publish path
   * and unescaped on the canvas path.
   *
   * Escaping unconditionally would double-encode at publish — an author's
   * "Q&A with Ada" would render as "Q&amp;A with Ada". Not escaping at all
   * would leave the canvas able to break out of the attribute. Hence the flag:
   * `render()` passes `false`, `preview()` passes `true`.
   *
   * URL-typed props (the poster) are escaped on BOTH paths, because neither
   * path HTML-escapes them and a query string's `&` genuinely needs encoding.
   */
  escapeText?: boolean
}

export interface RenderEmbedOutput {
  html: string
  css: string
}

/**
 * `allow` attribute per provider. Kept minimal — only what the player needs.
 * Notably absent: `camera`, `microphone`, `geolocation`, `payment`.
 */
const IFRAME_ALLOW: Record<ProviderId, string> = {
  youtube: 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen',
  vimeo: 'autoplay; fullscreen; picture-in-picture',
  loom: 'autoplay; fullscreen',
  wistia: 'autoplay; fullscreen',
}

/**
 * Render the lazy-loading facade for a parsed video.
 *
 * Structure mirrors the approach Instatic's built-in `base.video` uses for
 * YouTube: a 16:9 container holding an optional poster `<img>` that paints
 * immediately, with a `loading="lazy"` iframe stacked on top. The provider's
 * player scripts only load when the element nears the viewport, and there is
 * no JavaScript in the published output — it is native browser behaviour plus
 * a CSS z-stack.
 */
export function renderEmbed(input: RenderEmbedInput): RenderEmbedOutput {
  const { parsed } = input
  const src = buildEmbedUrl(parsed, { autoplay: input.autoplay === true })
  const rawTitle = (input.title ?? '').trim() || `${PROVIDER_LABELS[parsed.provider]} video`
  // See `escapeText` on RenderEmbedInput for why this is conditional.
  const title = input.escapeText === true ? escapeAttr(rawTitle) : rawTitle
  const poster = safePosterUrl(input.posterUrl ?? '')

  const iframe =
    `<iframe class="ive-embed-frame"` +
    ` src="${escapeAttr(src)}"` +
    ` title="${title}"` +
    ` loading="lazy"` +
    ` referrerpolicy="strict-origin-when-cross-origin"` +
    ` allow="${escapeAttr(IFRAME_ALLOW[parsed.provider])}"` +
    ` allowfullscreen` +
    `></iframe>`

  const posterImg = poster
    ? `<img class="ive-embed-poster" src="${escapeAttr(poster)}" alt=""` +
      ` loading="eager" decoding="async">`
    : ''

  const html =
    `<div class="${EMBED_MARKER_CLASS}" ${PROVIDER_ATTR}="${escapeAttr(parsed.provider)}">` +
    posterImg +
    iframe +
    `</div>`

  return { html, css: EMBED_CSS }
}

/**
 * Scoped to the marker class so the publisher's per-module CSS dedup emits it
 * once per page rather than once per embed. Contains no interpolated props —
 * it is a constant.
 */
export const EMBED_CSS = `
.${EMBED_MARKER_CLASS} {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  background-color: #000;
  overflow: hidden;
  border-radius: 4px;
}
.${EMBED_MARKER_CLASS} > .ive-embed-poster,
.${EMBED_MARKER_CLASS} > .ive-embed-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  border: 0;
}
.${EMBED_MARKER_CLASS} > .ive-embed-poster {
  object-fit: cover;
}
.${EMBED_MARKER_CLASS} > .ive-embed-frame {
  background: transparent;
  z-index: 1;
}
`.trim()

/**
 * Which providers appear in a rendered document.
 *
 * The `publish.html` filter uses this to widen `frame-src` with only the
 * origins that page actually needs. Reads the marker attribute rather than
 * re-parsing URLs, so it stays cheap on a large document — the filter runs
 * under a 5 s / 64 MB budget with the whole page JSON-marshalled in and out
 * of the sandbox.
 */
export function providersInHtml(html: string): ProviderId[] {
  if (typeof html !== 'string' || html.length === 0) return []

  const found = new Set<ProviderId>()
  const pattern = new RegExp(`${PROVIDER_ATTR}="([a-z]+)"`, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(html)) !== null) {
    const candidate = match[1]
    if (candidate in PROVIDER_LABELS) found.add(candidate as ProviderId)
  }

  return [...found].sort()
}

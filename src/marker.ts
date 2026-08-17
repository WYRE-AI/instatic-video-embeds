/**
 * Marker parsing and substitution.
 *
 * ## Why a code span
 *
 * The author writes the marker as an inline code span on its own line:
 *
 * ```markdown
 * `@@video:https://vimeo.com/123456789@@`
 * ```
 *
 * The backticks are load-bearing, and the choice was made by measurement
 * rather than taste. A marker written as plain text does NOT survive the
 * editor's markdown round-trip, for two independent reasons:
 *
 *  1. **Linkify autolinks the URL.** `markdownToProseMirrorDoc` →
 *     `proseMirrorDocToMarkdown` turns `@@video:https://vimeo.com/123@@` into
 *     `@@video:[https://vimeo.com/123@@](https://vimeo.com/123@@)` — and the
 *     closing delimiter is swallowed into the href.
 *  2. **`escapeInline` backslash-escapes ``\ ` * _ ~ [ ]``**
 *     (`src/core/markdown/markdownDocument.ts`). YouTube ids are
 *     `[A-Za-z0-9_-]{11}`, so any id containing `_` comes back as `dQw4w9\_gXcQ`.
 *
 * A code span sidesteps both: `escapeInline` returns text untouched inside a
 * code mark, and linkify does not autolink within code. Measured: the code-span
 * form round-trips byte-identically through three consecutive passes, including
 * a YouTube id containing an underscore. Every plain-text variant tried
 * (`@@…@@`, `::video …::`, `!video[…]`, `{{…}}`, a bare URL) was corrupted on
 * the first pass.
 *
 * The code span buys a second property for free: **if this plugin is ever
 * disabled or uninstalled, the marker degrades to inert monospace text.** It
 * is visible and slightly ugly, but it is never a broken player and never
 * unescaped author input.
 */
import { renderEmbed } from './embed'
import { parseVideoUrl } from './providers'

/** Opening delimiter of a marker, inside the code span. */
export const MARKER_PREFIX = '@@video:'
/** Closing delimiter of a marker, inside the code span. */
export const MARKER_SUFFIX = '@@'

/**
 * Matches a marker in either of the two shapes it can reach the published
 * document in, as a single ordered alternation.
 *
 * **Branch 1 — the whole paragraph.** The documented, supported form. The
 * surrounding `<p>` is consumed along with the marker, which matters because
 * the embed is a `<div>`, and a `<div>` nested inside a `<p>` is invalid HTML
 * that browsers silently restructure — breaking the facade's absolute
 * positioning.
 *
 * **Branch 2 — a bare code span.** Instatic's richtext sanitizer sometimes
 * drops a `<p>` wrapper, so the paragraph form is not guaranteed to survive.
 * This keeps the feature working when it doesn't.
 *
 * One regex rather than two sequential passes, deliberately. Two passes
 * double-count a failed marker: the paragraph pass leaves it in place, then
 * the bare pass matches the very same text again. Ordered alternation tries
 * the paragraph shape first at each position and consumes the match either
 * way, so every marker is considered exactly once.
 *
 * `[^<]*?` cannot cross a tag boundary, so a marker can never swallow markup.
 */
const MARKER_RE =
  /<p>\s*<code>\s*@@video:([^<]*?)@@\s*<\/code>\s*<\/p>|<code>\s*@@video:([^<]*?)@@\s*<\/code>/gi

/**
 * Decode the HTML entities the markdown renderer introduces inside a code span.
 *
 * Necessary because the marker's URL is entity-encoded by the time it reaches
 * the published document: a `&` in a query string arrives as `&amp;`.
 *
 * `&amp;` is decoded LAST so that an input of `&amp;lt;` yields `&lt;` rather
 * than being double-decoded into `<`.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/g, '&')
}

export interface SubstitutionResult {
  html: string
  /** How many markers were replaced with an embed. */
  replaced: number
  /** How many markers were left in place because they did not parse. */
  skipped: number
}

/**
 * Replace every recognized video marker in a published document with embed
 * markup.
 *
 * Fail-safe by construction: a marker whose URL does not parse — unsupported
 * provider, malformed id, hostile input — is returned **unchanged**, so it
 * stays inert literal text. There is no path here that emits a player for an
 * input we could not validate, and no path that interpolates the author's
 * string into markup.
 *
 * The publisher has already HTML-escaped the code span's contents by this
 * point, so the value is decoded before parsing. Anything genuinely hostile
 * fails the parser's strict host/scheme/id allowlists regardless.
 */
export function substituteMarkers(html: string): SubstitutionResult {
  if (typeof html !== 'string' || html.length === 0) {
    return { html: typeof html === 'string' ? html : '', replaced: 0, skipped: 0 }
  }

  let replaced = 0
  let skipped = 0

  // Exactly one of the two capture groups is set, depending on which
  // alternation branch matched.
  const out = html.replace(
    MARKER_RE,
    (full: string, paragraphForm?: string, bareForm?: string): string => {
      const captured = paragraphForm ?? bareForm ?? ''
      const parsed = parseVideoUrl(decodeEntities(captured))
      if (!parsed) {
        skipped += 1
        return full
      }
      replaced += 1
      // `escapeText: false` — the publisher already ran its escaping pass over
      // body content, and this path only ever emits values we constructed.
      return renderEmbed({ parsed, escapeText: false }).html
    },
  )

  return { html: out, replaced, skipped }
}

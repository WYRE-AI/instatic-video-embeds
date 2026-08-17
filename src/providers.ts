/**
 * Provider URL parsing and embed-URL construction.
 *
 * This file is the security boundary of the plugin. Everything here is a
 * pure function over strings so it can be exhaustively unit-tested without
 * a CMS, a DOM, or a network.
 *
 * Three rules govern every line below:
 *
 *  1. **Never trust the author-supplied URL.** It is parsed, decomposed, and
 *     discarded. The only things that survive parsing are a provider id (from
 *     a closed enum) and an opaque media id that matched a strict character
 *     allowlist. Embed URLs are then *rebuilt from scratch* out of a
 *     hardcoded origin plus that validated id. The raw input string is never
 *     interpolated into markup.
 *
 *  2. **Allowlist, never blocklist.** Hosts are compared against an exact set
 *     (or, for Wistia's per-account subdomains, an anchored pattern). Paths
 *     must match a known shape. Ids must match a strict regex. Anything that
 *     falls through returns `null`, and `null` renders nothing at all.
 *
 *  3. **No `URL` constructor.** Plugin module `render()` runs inside a
 *     QuickJS-WASM sandbox whose global surface is deliberately tiny. Rather
 *     than depend on a WHATWG `URL` implementation being present, we do our
 *     own strict decomposition with a single anchored regex. This also
 *     sidesteps the parser-differential bugs that come from validating with
 *     one URL implementation and rendering in another.
 */

/** Providers this plugin knows how to embed. Closed set — not extensible at runtime. */
export type ProviderId = 'youtube' | 'vimeo' | 'loom' | 'wistia'

export interface ParsedEmbed {
  provider: ProviderId
  /** Opaque provider media id. Guaranteed to match the provider's id pattern. */
  id: string
  /**
   * Vimeo unlisted-video privacy hash (the `h` parameter), when the source URL
   * carried one. Undefined for every other provider.
   */
  hash?: string
}

/**
 * Strict URL decomposition.
 *
 * Anchored end-to-end and rejects all whitespace, which makes the usual
 * smuggling tricks (embedded newlines, tabs, spaces before a scheme) fail
 * closed. Captures: scheme, authority, path, query.
 */
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#\s]+)(\/[^?#\s]*)?(?:\?([^#\s]*))?(?:#[^\s]*)?$/

interface DecomposedUrl {
  host: string
  path: string
  query: string
}

/**
 * Decompose an absolute http(s) URL into the pieces the provider matchers
 * need. Returns `null` for anything that is not a plain, credential-free,
 * default-port http(s) URL.
 */
function decompose(input: string): DecomposedUrl | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const match = URL_RE.exec(trimmed)
  if (!match) return null

  const scheme = match[1].toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return null

  const authority = match[2]

  // `https://vimeo.com@evil.example/1234` — the real host is evil.example.
  // The allowlist check below would already reject it, but rejecting
  // userinfo outright keeps the intent explicit and the failure obvious.
  if (authority.includes('@')) return null

  // Reject explicit ports. No provider needs one, and allowing them widens
  // the surface for no benefit.
  if (authority.includes(':')) return null

  // Trailing dot is a valid FQDN form ("vimeo.com.") that would otherwise
  // slip past an exact-match allowlist.
  const host = authority.toLowerCase().replace(/\.$/, '')
  if (!host) return null

  return {
    host,
    path: match[3] ?? '/',
    query: match[4] ?? '',
  }
}

/** Read a single query parameter without depending on `URLSearchParams`. */
function queryParam(query: string, key: string): string | null {
  if (!query) return null
  const parts = query.split('&')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq) !== key) continue
    return part.slice(eq + 1)
  }
  return null
}

/** Strip a leading `www.` for host comparison. */
function bareHost(host: string): string {
  return host.replace(/^www\./, '')
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/**
 * Exactly 11 base64-url characters — the canonical YouTube video id shape.
 *
 * This mirrors `parseYoutubeId` in Instatic's built-in `base.video`
 * (src/modules/base/video/youtube.ts). Matching its strictness matters:
 * a bare id with no surrounding URL is rejected, so an author who types
 * "dQw4w9WgXcQ" gets nothing rather than an accidental embed.
 */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/

/**
 * YouTube URL shapes:
 *   youtube.com/watch?v=<id>
 *   youtu.be/<id>
 *   youtube.com/embed/<id>
 *   youtube.com/shorts/<id>
 *   youtube.com/v/<id>
 *   youtube-nocookie.com/embed/<id>
 *   m.youtube.com/watch?v=<id>
 */
function parseYouTube(url: DecomposedUrl): ParsedEmbed | null {
  const host = bareHost(url.host)

  if (host === 'youtu.be') {
    const candidate = url.path.split('/').filter((s) => s.length > 0)[0]
    return candidate && YOUTUBE_ID_RE.test(candidate)
      ? { provider: 'youtube', id: candidate }
      : null
  }

  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') {
    return null
  }

  const segments = url.path.split('/').filter((s) => s.length > 0)

  if (segments.length === 0 || segments[0] === 'watch') {
    const v = queryParam(url.query, 'v')
    return v && YOUTUBE_ID_RE.test(v) ? { provider: 'youtube', id: v } : null
  }

  if (segments[0] === 'embed' || segments[0] === 'shorts' || segments[0] === 'v') {
    const candidate = segments[1]
    return candidate && YOUTUBE_ID_RE.test(candidate)
      ? { provider: 'youtube', id: candidate }
      : null
  }

  return null
}

// ---------------------------------------------------------------------------
// Vimeo
// ---------------------------------------------------------------------------

/**
 * Vimeo ids are numeric. Real ids are currently 9 digits and climbing; the
 * 6..12 window is deliberately loose enough to survive Vimeo's growth and
 * tight enough to reject anything that isn't an id.
 */
const VIMEO_ID_RE = /^[0-9]{6,12}$/

/**
 * Unlisted-video privacy hash. Vimeo emits lowercase hex, but we accept the
 * broader alphanumeric set so a format change doesn't silently break embeds.
 */
const VIMEO_HASH_RE = /^[A-Za-z0-9]{6,16}$/

/**
 * Vimeo canonical URL shapes, all of which end with the numeric id:
 *   /123456789
 *   /123456789/abcdef1234          (unlisted, hash in the path)
 *   /channels/<channel>/123456789
 *   /groups/<group>/videos/123456789
 *   /album/<album>/video/123456789
 *   /ondemand/<name>/123456789
 *   player.vimeo.com/video/123456789
 */
function parseVimeo(url: DecomposedUrl): ParsedEmbed | null {
  const host = bareHost(url.host)
  const isPlayer = host === 'player.vimeo.com'
  if (host !== 'vimeo.com' && !isPlayer) return null

  const segments = url.path.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null

  let id: string | null = null
  let pathHash: string | null = null

  if (isPlayer) {
    // player.vimeo.com/video/<id>
    if (segments[0] === 'video' && segments[1] && VIMEO_ID_RE.test(segments[1])) {
      id = segments[1]
    }
  } else if (VIMEO_ID_RE.test(segments[0])) {
    // vimeo.com/<id> and vimeo.com/<id>/<hash>
    id = segments[0]
    if (segments[1] && VIMEO_HASH_RE.test(segments[1])) pathHash = segments[1]
  } else {
    // Nested shapes: the id is the last segment that looks like one.
    const last = segments[segments.length - 1]
    const known = ['channels', 'groups', 'album', 'ondemand', 'showcase']
    if (known.includes(segments[0]) && VIMEO_ID_RE.test(last)) {
      id = last
    }
  }

  if (!id) return null

  // A hash in the query (`?h=`) is the player.vimeo.com form; a hash in the
  // path is the vimeo.com form. Either is accepted, both are validated.
  const rawQueryHash = queryParam(url.query, 'h')
  const queryHash = rawQueryHash && VIMEO_HASH_RE.test(rawQueryHash) ? rawQueryHash : null
  const hash = pathHash ?? queryHash

  return hash ? { provider: 'vimeo', id, hash } : { provider: 'vimeo', id }
}

// ---------------------------------------------------------------------------
// Loom
// ---------------------------------------------------------------------------

/** Loom ids are exactly 32 lowercase hex characters. */
const LOOM_ID_RE = /^[0-9a-f]{32}$/

/**
 * Loom URL shapes:
 *   /share/<32-hex>
 *   /embed/<32-hex>
 *   /share/<32-hex>?sid=...
 */
function parseLoom(url: DecomposedUrl): ParsedEmbed | null {
  if (bareHost(url.host) !== 'loom.com') return null

  const segments = url.path.split('/').filter((s) => s.length > 0)
  if (segments.length < 2) return null
  if (segments[0] !== 'share' && segments[0] !== 'embed') return null

  // Loom ids are canonically lowercase; normalize so a pasted uppercase
  // variant still matches rather than silently rendering nothing.
  const candidate = segments[1].toLowerCase()
  if (!LOOM_ID_RE.test(candidate)) return null

  return { provider: 'loom', id: candidate }
}

// ---------------------------------------------------------------------------
// Wistia
// ---------------------------------------------------------------------------

/** Wistia hashed ids are lowercase alphanumeric, canonically 10 characters. */
const WISTIA_ID_RE = /^[a-z0-9]{8,12}$/

/**
 * Wistia serves per-account subdomains (`acme.wistia.com`) alongside its
 * embed CDN (`fast.wistia.net`). The pattern is anchored on both ends so it
 * matches `<label>.wistia.com|net` and nothing else — notably not
 * `wistia.com.evil.example`.
 */
const WISTIA_HOST_RE = /^(?:[a-z0-9-]+\.)?wistia\.(?:com|net)$/

/**
 * Wistia URL shapes:
 *   <account>.wistia.com/medias/<id>
 *   fast.wistia.net/embed/iframe/<id>
 *   fast.wistia.net/embed/medias/<id>.jsonp
 */
function parseWistia(url: DecomposedUrl): ParsedEmbed | null {
  if (!WISTIA_HOST_RE.test(url.host)) return null

  const segments = url.path.split('/').filter((s) => s.length > 0)
  if (segments.length < 2) return null

  let candidate: string | null = null
  if (segments[0] === 'medias') {
    candidate = segments[1]
  } else if (segments[0] === 'embed') {
    if (segments[1] === 'iframe' && segments[2]) candidate = segments[2]
    else if (segments[1] === 'medias' && segments[2]) candidate = segments[2]
  }

  if (!candidate) return null

  // `fast.wistia.net/embed/medias/<id>.jsonp` — drop a trailing extension.
  const dot = candidate.indexOf('.')
  if (dot !== -1) candidate = candidate.slice(0, dot)

  const normalized = candidate.toLowerCase()
  if (!WISTIA_ID_RE.test(normalized)) return null

  return { provider: 'wistia', id: normalized }
}

// ---------------------------------------------------------------------------
// Public parsing entry point
// ---------------------------------------------------------------------------

/**
 * Identify a supported non-YouTube video URL.
 *
 * Returns `null` for empty input, malformed input, unsupported providers, and
 * anything whose id fails validation. Callers must treat `null` as "render
 * nothing" — never as "render a fallback player".
 *
 * YouTube IS handled here. Instatic's built-in `base.video` also supports it,
 * but `base.video` is a site-canvas module that can only live in a page or
 * template tree — it cannot be placed inline in a post body, which is this
 * plugin's whole reason to exist.
 */
export function parseVideoUrl(input: string): ParsedEmbed | null {
  if (typeof input !== 'string') return null

  const url = decompose(input)
  if (!url) return null

  return parseYouTube(url) ?? parseVimeo(url) ?? parseLoom(url) ?? parseWistia(url)
}

// ---------------------------------------------------------------------------
// Embed URL construction
// ---------------------------------------------------------------------------

/**
 * The single origin each provider's iframe is served from. These strings are
 * the only origins this plugin will ever add to `frame-src`, and the only
 * origins it will ever build an embed URL against.
 */
export const PROVIDER_ORIGINS: Record<ProviderId, string> = {
  // youtube-nocookie is the privacy-enhanced origin. We always embed against
  // it, so it is also the only YouTube origin we ever add to frame-src —
  // narrower than base.video, which allows both youtube.com and nocookie.
  youtube: 'https://www.youtube-nocookie.com',
  vimeo: 'https://player.vimeo.com',
  loom: 'https://www.loom.com',
  wistia: 'https://fast.wistia.net',
}

/** Human-readable provider names, for the accessible iframe title fallback. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  loom: 'Loom',
  wistia: 'Wistia',
}

export interface EmbedOptions {
  /** Start playback automatically. Off by default. */
  autoplay?: boolean
}

/**
 * Build the embed URL for a parsed video.
 *
 * The output is assembled from a hardcoded origin and the validated id — no
 * part of the author's original URL is carried through. Ids are additionally
 * `encodeURIComponent`-ed: redundant given they already matched a strict
 * alphanumeric pattern, but it keeps the contract honest if a future edit
 * loosens one of those patterns.
 *
 * Privacy defaults: Vimeo gets `dnt=1` (do-not-track, suppresses Vimeo's
 * analytics cookies). Loom and Wistia expose no equivalent URL parameter, so
 * their embeds are built with playback parameters only.
 */
export function buildEmbedUrl(parsed: ParsedEmbed, options: EmbedOptions = {}): string {
  const autoplay = options.autoplay === true

  switch (parsed.provider) {
    case 'youtube': {
      // rel=0 keeps YouTube's post-playback recommendations scoped to the
      // same channel rather than the open web.
      const params = ['rel=0']
      if (autoplay) params.push('autoplay=1', 'mute=1')
      return `${PROVIDER_ORIGINS.youtube}/embed/${encodeURIComponent(parsed.id)}?${params.join('&')}`
    }
    case 'vimeo': {
      const params = ['dnt=1']
      if (parsed.hash) params.push(`h=${encodeURIComponent(parsed.hash)}`)
      if (autoplay) params.push('autoplay=1', 'muted=1')
      return `${PROVIDER_ORIGINS.vimeo}/video/${encodeURIComponent(parsed.id)}?${params.join('&')}`
    }
    case 'loom': {
      const params: string[] = []
      if (autoplay) params.push('autoplay=1')
      const qs = params.length > 0 ? `?${params.join('&')}` : ''
      return `${PROVIDER_ORIGINS.loom}/embed/${encodeURIComponent(parsed.id)}${qs}`
    }
    case 'wistia': {
      const params: string[] = ['dnt=1']
      if (autoplay) params.push('autoPlay=true', 'muted=true')
      return `${PROVIDER_ORIGINS.wistia}/embed/iframe/${encodeURIComponent(parsed.id)}?${params.join('&')}`
    }
  }
}

/**
 * The `frame-src` origins required to render a given set of providers.
 *
 * Deliberately returns only the origins for providers actually present, so a
 * page embedding one Vimeo video does not get its `frame-src` widened to Loom
 * and Wistia as well.
 */
export function frameSrcOriginsFor(providers: Iterable<ProviderId>): string[] {
  const origins = new Set<string>()
  for (const provider of providers) {
    const origin = PROVIDER_ORIGINS[provider]
    if (origin) origins.add(origin)
  }
  return [...origins].sort()
}

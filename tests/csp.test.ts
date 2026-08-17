/**
 * Tests for the `frame-src` widening applied by the `publish.html` filter.
 *
 * The published CSP is a derived value with deterministic serialization, and
 * the host re-matches its own `<meta>` tag pattern in later stages. So these
 * tests care about two things beyond "the origin got added": that the emitted
 * tag keeps the exact shape the host expects, and that nothing else in the
 * policy is disturbed.
 */
import { describe, expect, it } from 'bun:test'
import { addFrameSrcOrigins, hasEmbedMarker } from '../src/csp'

/**
 * The publisher's base policy, serialized exactly as `createBaseCspPlan` +
 * `serializeCsp` in `src/core/publisher/cspPlan.ts` would emit it for a page
 * with no script tags.
 */
const BASE_POLICY =
  "default-src 'self'; frame-src 'none'; img-src 'self' data: https:; " +
  "media-src 'self' data: https:; script-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; worker-src 'none';"

function documentWith(policy: string): string {
  return (
    '<!doctype html><html><head><meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `  <meta http-equiv="Content-Security-Policy" content="${policy}">\n` +
    '  <title>Post</title></head><body><p>Hello</p></body></html>'
  )
}

/** Pull the policy string back out of a rewritten document. */
function policyOf(html: string): string {
  const match = /content="([^"]*)"\s*\/?>/i.exec(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)![0],
  )
  return match![1]
}

describe('addFrameSrcOrigins', () => {
  it('lifts frame-src from none to the given origin', () => {
    const out = addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://player.vimeo.com'])
    expect(policyOf(out)).toContain('frame-src https://player.vimeo.com;')
    expect(policyOf(out)).not.toContain("frame-src 'none'")
  })

  it("removes 'none' rather than leaving it alongside a real origin", () => {
    const out = addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://www.loom.com'])
    expect(policyOf(out)).not.toContain("'none' https")
    expect(policyOf(out)).not.toContain("https://www.loom.com 'none'")
  })

  it('leaves every other directive intact', () => {
    const out = policyOf(addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://player.vimeo.com']))
    expect(out).toContain("default-src 'self';")
    expect(out).toContain("img-src 'self' data: https:;")
    expect(out).toContain("media-src 'self' data: https:;")
    expect(out).toContain("script-src 'none';")
    expect(out).toContain("style-src 'self' 'unsafe-inline';")
    expect(out).toContain("worker-src 'none';")
  })

  it('emits directives sorted by name and sources sorted within a directive', () => {
    const out = policyOf(
      addFrameSrcOrigins(documentWith(BASE_POLICY), [
        'https://www.youtube-nocookie.com',
        'https://fast.wistia.net',
        'https://player.vimeo.com',
      ]),
    )
    expect(out).toBe(
      "default-src 'self'; " +
        'frame-src https://fast.wistia.net https://player.vimeo.com https://www.youtube-nocookie.com; ' +
        "img-src 'self' data: https:; " +
        "media-src 'self' data: https:; " +
        "script-src 'none'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "worker-src 'none';",
    )
  })

  it('is deterministic regardless of the order origins are supplied in', () => {
    const doc = documentWith(BASE_POLICY)
    const a = addFrameSrcOrigins(doc, ['https://player.vimeo.com', 'https://www.loom.com'])
    const b = addFrameSrcOrigins(doc, ['https://www.loom.com', 'https://player.vimeo.com'])
    expect(a).toBe(b)
  })

  it('unions with an existing frame-src rather than replacing it', () => {
    // A page that already embeds YouTube via the built-in base.video module.
    const policy = BASE_POLICY.replace(
      "frame-src 'none'",
      'frame-src https://www.youtube.com',
    )
    const out = policyOf(addFrameSrcOrigins(documentWith(policy), ['https://player.vimeo.com']))
    expect(out).toContain('frame-src https://player.vimeo.com https://www.youtube.com;')
  })

  it('is idempotent — re-running adds nothing', () => {
    const once = addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://player.vimeo.com'])
    const twice = addFrameSrcOrigins(once, ['https://player.vimeo.com'])
    expect(twice).toBe(once)
  })

  it('keeps the tag in the exact shape the host pattern matches', () => {
    const out = addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://player.vimeo.com'])
    // Same pattern the host uses in src/core/publisher/cspPlan.ts.
    const hostPattern =
      /<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i
    expect(hostPattern.test(out)).toBe(true)
  })

  it('returns the document untouched when there are no origins to add', () => {
    const doc = documentWith(BASE_POLICY)
    expect(addFrameSrcOrigins(doc, [])).toBe(doc)
  })

  it('returns the document untouched when it has no CSP meta tag', () => {
    // Never invent a policy for a document we do not understand.
    const doc = '<!doctype html><html><head><title>No CSP</title></head><body></body></html>'
    expect(addFrameSrcOrigins(doc, ['https://player.vimeo.com'])).toBe(doc)
  })

  it('does not disturb the rest of the document', () => {
    const out = addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://player.vimeo.com'])
    expect(out).toContain('<title>Post</title>')
    expect(out).toContain('<body><p>Hello</p></body>')
    expect(out).toContain('<meta charset="UTF-8">')
  })

  it('rewrites only the CSP meta tag, not other meta tags', () => {
    const out = addFrameSrcOrigins(documentWith(BASE_POLICY), ['https://player.vimeo.com'])
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
  })

  it('handles a self-closing meta tag', () => {
    const doc = `<html><head><meta http-equiv="Content-Security-Policy" content="${BASE_POLICY}" /></head></html>`
    const out = addFrameSrcOrigins(doc, ['https://player.vimeo.com'])
    expect(out).toContain('frame-src https://player.vimeo.com;')
  })

  it('adds frame-src when the policy has no frame-src directive at all', () => {
    const doc = documentWith("default-src 'self';")
    const out = policyOf(addFrameSrcOrigins(doc, ['https://player.vimeo.com']))
    expect(out).toBe("default-src 'self'; frame-src https://player.vimeo.com;")
  })

  it('does not build a regex from policy content', () => {
    // A directive name full of regex metacharacters must not throw or corrupt.
    const doc = documentWith("default-src 'self'; x-(*+[ weird;")
    expect(() => addFrameSrcOrigins(doc, ['https://player.vimeo.com'])).not.toThrow()
  })
})

describe('hasEmbedMarker', () => {
  it('detects the marker when present', () => {
    expect(hasEmbedMarker('<div class="ive-embed">x</div>', 'ive-embed')).toBe(true)
  })

  it('returns false when absent, so the page keeps frame-src none', () => {
    expect(hasEmbedMarker('<p>no video here</p>', 'ive-embed')).toBe(false)
  })

  it('is defensive about non-string input', () => {
    expect(hasEmbedMarker(undefined as unknown as string, 'ive-embed')).toBe(false)
  })
})

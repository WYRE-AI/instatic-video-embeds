/**
 * Tests for marker parsing and substitution.
 *
 * The fixtures in `PUBLISHED` are not invented — they are the verbatim output
 * of running Instatic's real pipeline (`renderMarkdownToHtml` →
 * `sanitizeRichtext`) over a body containing the marker, at
 * `v0.0.16-3-g6b055cf7`. Pinning them means that if Instatic changes the shape
 * of published code spans, these tests fail and tell us why.
 */
import { describe, expect, it } from 'bun:test'
import { decodeEntities, MARKER_PREFIX, MARKER_SUFFIX, substituteMarkers } from '../src/marker'

/** Verbatim published output captured from the real Instatic pipeline. */
const PUBLISHED = {
  youtube:
    'Intro.\n<p><code>@@video:https://youtu.be/dQw4w9_gXcQ@@</code></p>\n<p>Outro.</p>',
  vimeo:
    'Intro.\n<p><code>@@video:https://vimeo.com/123456789@@</code></p>\n<p>Outro.</p>',
  loom:
    'Intro.\n<p><code>@@video:https://www.loom.com/share/a1b2c3d4e5f60718293a4b5c6d7e8f90@@</code></p>\n<p>Outro.</p>',
  hostile:
    'Intro.\n<p><code>@@video:https://vimeo.com/1"&gt;&lt;script&gt;alert(1)&lt;/script&gt;@@</code></p>\n<p>Outro.</p>',
}

describe('marker syntax survives the editor markdown round-trip', () => {
  /**
   * Replicates `escapeInline` from
   * `src/core/markdown/markdownDocument.ts`, which backslash-escapes these
   * characters in any text node that does NOT carry a code mark.
   */
  const ESCAPED_OUTSIDE_CODE = /[\\`*_~[\]]/

  it('uses delimiters that markdown would not escape', () => {
    expect(ESCAPED_OUTSIDE_CODE.test(MARKER_PREFIX)).toBe(false)
    expect(ESCAPED_OUTSIDE_CODE.test(MARKER_SUFFIX)).toBe(false)
  })

  it('documents why the code span is required, not decorative', () => {
    // A YouTube id legitimately contains `_`, which IS in the escape set. That
    // is why the marker must sit inside a code span: escapeInline returns text
    // untouched when a code mark is present. Measured: the code-span form
    // round-trips byte-identically three passes running, while every
    // plain-text variant was corrupted on the first pass.
    expect(ESCAPED_OUTSIDE_CODE.test('dQw4w9_gXcQ')).toBe(true)
  })
})

describe('substituteMarkers — the happy path', () => {
  it('replaces a YouTube marker with an embed', () => {
    const out = substituteMarkers(PUBLISHED.youtube)
    expect(out.replaced).toBe(1)
    expect(out.skipped).toBe(0)
    expect(out.html).toContain('data-ive-provider="youtube"')
    expect(out.html).toContain('https://www.youtube-nocookie.com/embed/dQw4w9_gXcQ?rel=0')
  })

  it('replaces a Vimeo marker, keeping the privacy default', () => {
    const out = substituteMarkers(PUBLISHED.vimeo)
    expect(out.replaced).toBe(1)
    expect(out.html).toContain('https://player.vimeo.com/video/123456789?dnt=1')
  })

  it('replaces a Loom marker', () => {
    const out = substituteMarkers(PUBLISHED.loom)
    expect(out.replaced).toBe(1)
    expect(out.html).toContain(
      'https://www.loom.com/embed/a1b2c3d4e5f60718293a4b5c6d7e8f90',
    )
  })

  it('removes the wrapping paragraph so a div is not nested inside a p', () => {
    const out = substituteMarkers(PUBLISHED.vimeo)
    expect(out.html).not.toContain('<p><div')
    expect(out.html).not.toContain('<code>')
    expect(out.html).toContain('<p>Outro.</p>')
  })

  it('leaves the surrounding copy untouched', () => {
    const out = substituteMarkers(PUBLISHED.vimeo)
    expect(out.html).toContain('Intro.')
    expect(out.html).toContain('<p>Outro.</p>')
  })

  it('replaces several markers in one document', () => {
    const doc =
      '<p><code>@@video:https://vimeo.com/123456789@@</code></p>' +
      '<p>between</p>' +
      '<p><code>@@video:https://youtu.be/dQw4w9_gXcQ@@</code></p>'
    const out = substituteMarkers(doc)
    expect(out.replaced).toBe(2)
    expect(out.html).toContain('data-ive-provider="vimeo"')
    expect(out.html).toContain('data-ive-provider="youtube"')
    expect(out.html).toContain('<p>between</p>')
  })

  it('handles a bare code span with no paragraph wrapper', () => {
    // Instatic's sanitizer sometimes drops the <p>; the fallback covers it.
    const out = substituteMarkers('<code>@@video:https://vimeo.com/123456789@@</code>')
    expect(out.replaced).toBe(1)
    expect(out.html).toContain('data-ive-provider="vimeo"')
  })

  it('decodes an entity-encoded ampersand in the URL', () => {
    const doc = '<p><code>@@video:https://player.vimeo.com/video/123456789?h=abc123def4&amp;x=1@@</code></p>'
    const out = substituteMarkers(doc)
    expect(out.replaced).toBe(1)
    expect(out.html).toContain('h=abc123def4')
  })
})

describe('substituteMarkers — fail safe', () => {
  it('leaves a hostile marker as inert literal text', () => {
    const out = substituteMarkers(PUBLISHED.hostile)
    expect(out.replaced).toBe(0)
    expect(out.skipped).toBe(1)
    // Unchanged: still an escaped code span, never a player, never live markup.
    expect(out.html).toBe(PUBLISHED.hostile)
    expect(out.html).not.toContain('<iframe')
    expect(out.html).not.toContain('<script>alert(1)</script>')
  })

  it('leaves an unsupported provider inert', () => {
    const doc = '<p><code>@@video:https://dailymotion.com/video/x8abcde@@</code></p>'
    expect(substituteMarkers(doc)).toMatchObject({ html: doc, replaced: 0, skipped: 1 })
  })

  it('leaves a malformed id inert', () => {
    const doc = '<p><code>@@video:https://vimeo.com/not-a-number@@</code></p>'
    expect(substituteMarkers(doc)).toMatchObject({ html: doc, replaced: 0, skipped: 1 })
  })

  it('leaves an empty marker inert', () => {
    const doc = '<p><code>@@video:@@</code></p>'
    expect(substituteMarkers(doc)).toMatchObject({ html: doc, replaced: 0, skipped: 1 })
  })

  it('leaves a dangerous scheme inert', () => {
    const doc = '<p><code>@@video:javascript:alert(1)@@</code></p>'
    const out = substituteMarkers(doc)
    expect(out.replaced).toBe(0)
    expect(out.html).toBe(doc)
  })

  it('leaves a credential-smuggling host inert', () => {
    const doc = '<p><code>@@video:https://vimeo.com@evil.example/123456789@@</code></p>'
    expect(substituteMarkers(doc).replaced).toBe(0)
  })

  it('ignores ordinary code spans that are not markers', () => {
    const doc = '<p><code>npm install</code></p>'
    expect(substituteMarkers(doc)).toMatchObject({ html: doc, replaced: 0, skipped: 0 })
  })

  it('does not let a marker span element boundaries', () => {
    // The capture group excludes '<', so a marker cannot swallow markup.
    const doc = '<p><code>@@video:https://vimeo.com/1</code><b>x</b><code>23456789@@</code></p>'
    expect(substituteMarkers(doc).replaced).toBe(0)
  })

  it('is defensive about empty and non-string input', () => {
    expect(substituteMarkers('')).toMatchObject({ html: '', replaced: 0 })
    expect(substituteMarkers(undefined as unknown as string)).toMatchObject({ replaced: 0 })
  })

  it('counts a mix of valid and invalid markers correctly', () => {
    const doc =
      '<p><code>@@video:https://vimeo.com/123456789@@</code></p>' +
      '<p><code>@@video:https://evil.example/x@@</code></p>'
    const out = substituteMarkers(doc)
    expect(out.replaced).toBe(1)
    expect(out.skipped).toBe(1)
    expect(out.html).toContain('https://evil.example/x')
    expect(out.html).not.toContain('<iframe src="https://evil.example')
  })
})

describe('decodeEntities', () => {
  it('decodes the entities a markdown code span introduces', () => {
    expect(decodeEntities('a&amp;b')).toBe('a&b')
    expect(decodeEntities('&lt;x&gt;')).toBe('<x>')
    expect(decodeEntities('&quot;q&quot;')).toBe('"q"')
    expect(decodeEntities('&#39;')).toBe("'")
  })

  it('decodes &amp; last so nothing is double-decoded', () => {
    // If &amp; were decoded first, this would collapse to '<'.
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
  })
})

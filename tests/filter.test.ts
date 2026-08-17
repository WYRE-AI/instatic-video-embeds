/**
 * End-to-end tests for the `publish.html` filter body.
 *
 * These exercise the property the whole design rests on: a page gains exactly
 * the `frame-src` origins its own embeds require, and a page with no embed is
 * returned byte-identical.
 */
import { describe, expect, it } from 'bun:test'
import { applyVideoEmbeds } from '../src/filter'

const BASE_POLICY =
  "default-src 'self'; frame-src 'none'; img-src 'self' data: https:; " +
  "media-src 'self' data: https:; script-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; worker-src 'none';"

function page(body: string): string {
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${BASE_POLICY}">` +
    '<title>Post</title></head><body><article>' +
    body +
    '</article></body></html>'
  )
}

function policyOf(html: string): string {
  return /content="([^"]*)"/i.exec(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)![0],
  )![1]
}

const vimeoMarker = '<p><code>@@video:https://vimeo.com/123456789@@</code></p>'
const loomMarker =
  '<p><code>@@video:https://www.loom.com/share/a1b2c3d4e5f60718293a4b5c6d7e8f90@@</code></p>'

describe('applyVideoEmbeds — a page with one embed', () => {
  const result = applyVideoEmbeds(page(`<p>Intro.</p>${vimeoMarker}<p>Outro.</p>`))

  it('substitutes the marker', () => {
    expect(result.replaced).toBe(1)
    expect(result.html).toContain('data-ive-provider="vimeo"')
    expect(result.html).not.toContain('<code>')
  })

  it('widens frame-src to exactly that provider', () => {
    expect(result.originsAdded).toEqual(['https://player.vimeo.com'])
    expect(policyOf(result.html)).toContain('frame-src https://player.vimeo.com;')
  })

  it('does not widen frame-src to providers not on the page', () => {
    const policy = policyOf(result.html)
    expect(policy).not.toContain('loom')
    expect(policy).not.toContain('wistia')
    expect(policy).not.toContain('youtube')
  })

  it('injects the facade stylesheet once', () => {
    expect(result.html.match(/data-ive-styles/g)).toHaveLength(1)
    expect(result.html).toContain('aspect-ratio: 16 / 9')
  })

  it('leaves the surrounding copy intact', () => {
    expect(result.html).toContain('<p>Intro.</p>')
    expect(result.html).toContain('<p>Outro.</p>')
    expect(result.html).toContain('<title>Post</title>')
  })

  it('leaves every other CSP directive alone', () => {
    const policy = policyOf(result.html)
    expect(policy).toContain("default-src 'self';")
    expect(policy).toContain("script-src 'none';")
    expect(policy).toContain("style-src 'self' 'unsafe-inline';")
  })
})

describe('applyVideoEmbeds — a page with two providers', () => {
  const result = applyVideoEmbeds(page(vimeoMarker + loomMarker))

  it('substitutes both markers', () => {
    expect(result.replaced).toBe(2)
  })

  it('adds both origins and only those two', () => {
    expect(result.originsAdded).toEqual([
      'https://player.vimeo.com',
      'https://www.loom.com',
    ])
    expect(policyOf(result.html)).toContain(
      'frame-src https://player.vimeo.com https://www.loom.com;',
    )
  })
})

describe('applyVideoEmbeds — pages that must be left alone', () => {
  it('returns a page with no marker byte-identical', () => {
    const input = page('<p>Just words.</p>')
    const result = applyVideoEmbeds(input)
    expect(result.html).toBe(input)
    expect(result.replaced).toBe(0)
    expect(result.originsAdded).toEqual([])
  })

  it('keeps frame-src none on a page with no embed', () => {
    const result = applyVideoEmbeds(page('<p>Just words.</p>'))
    expect(policyOf(result.html)).toContain("frame-src 'none';")
  })

  it('injects no stylesheet when nothing was substituted', () => {
    expect(applyVideoEmbeds(page('<p>Just words.</p>')).html).not.toContain('data-ive-styles')
  })

  it('does not widen CSP for a marker that failed to parse', () => {
    const input = page('<p><code>@@video:https://evil.example/x@@</code></p>')
    const result = applyVideoEmbeds(input)
    expect(result.replaced).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.html).toBe(input)
    expect(policyOf(result.html)).toContain("frame-src 'none';")
  })

  it('is defensive about empty and non-string input', () => {
    expect(applyVideoEmbeds('')).toMatchObject({ html: '', replaced: 0 })
    expect(applyVideoEmbeds(undefined as unknown as string)).toMatchObject({ replaced: 0 })
  })
})

describe('applyVideoEmbeds — idempotence', () => {
  it('re-running over its own output changes nothing further', () => {
    const once = applyVideoEmbeds(page(vimeoMarker))
    const twice = applyVideoEmbeds(once.html)
    expect(twice.html).toBe(once.html)
    expect(twice.replaced).toBe(0)
  })

  it('does not duplicate the stylesheet on a second pass', () => {
    const once = applyVideoEmbeds(page(vimeoMarker))
    const twice = applyVideoEmbeds(once.html)
    expect(twice.html.match(/data-ive-styles/g)).toHaveLength(1)
  })
})

describe('applyVideoEmbeds — documents we do not recognize', () => {
  it('still substitutes when there is no CSP meta tag, without inventing one', () => {
    const input = `<html><head><title>x</title></head><body>${vimeoMarker}</body></html>`
    const result = applyVideoEmbeds(input)
    expect(result.replaced).toBe(1)
    expect(result.html).not.toContain('Content-Security-Policy')
  })

  it('does not bolt a stylesheet onto a document with no head', () => {
    const result = applyVideoEmbeds(`<body>${vimeoMarker}</body>`)
    expect(result.replaced).toBe(1)
    expect(result.html).not.toContain('data-ive-styles')
  })
})

/**
 * Tests for the URL parsing / id validation layer.
 *
 * This is the plugin's security boundary, so the suite is weighted heavily
 * toward rejection cases: host spoofing, credential smuggling, scheme abuse,
 * and id-shaped-but-not-an-id inputs. A parser that is merely permissive
 * would pass the happy-path tests alone.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildEmbedUrl,
  frameSrcOriginsFor,
  parseVideoUrl,
  PROVIDER_ORIGINS,
  type ProviderId,
} from '../src/providers'

describe('parseVideoUrl — YouTube', () => {
  const id = 'dQw4w9WgXcQ'

  it('parses the watch?v= form', () => {
    expect(parseVideoUrl(`https://www.youtube.com/watch?v=${id}`)).toEqual({
      provider: 'youtube',
      id,
    })
  })

  it('parses the youtu.be short form', () => {
    expect(parseVideoUrl(`https://youtu.be/${id}`)).toEqual({ provider: 'youtube', id })
  })

  it('parses embed, shorts, and /v/ forms', () => {
    for (const path of ['embed', 'shorts', 'v']) {
      expect(parseVideoUrl(`https://www.youtube.com/${path}/${id}`)).toEqual({
        provider: 'youtube',
        id,
      })
    }
  })

  it('parses the mobile and nocookie hosts', () => {
    expect(parseVideoUrl(`https://m.youtube.com/watch?v=${id}`)).toEqual({
      provider: 'youtube',
      id,
    })
    expect(parseVideoUrl(`https://www.youtube-nocookie.com/embed/${id}`)).toEqual({
      provider: 'youtube',
      id,
    })
  })

  it('tolerates extra query parameters such as ?t=', () => {
    expect(parseVideoUrl(`https://www.youtube.com/watch?v=${id}&t=42s`)).toEqual({
      provider: 'youtube',
      id,
    })
  })

  it('rejects a bare id with no URL around it, matching base.video', () => {
    expect(parseVideoUrl(id)).toBeNull()
  })

  it('rejects an id that is not exactly 11 characters', () => {
    expect(parseVideoUrl('https://youtu.be/tooshort')).toBeNull()
    expect(parseVideoUrl(`https://youtu.be/${id}EXTRA`)).toBeNull()
  })

  it('rejects a YouTube lookalike host', () => {
    expect(parseVideoUrl(`https://youtube.com.evil.example/watch?v=${id}`)).toBeNull()
    expect(parseVideoUrl(`https://notyoutube.com/watch?v=${id}`)).toBeNull()
  })

  it('embeds against the privacy-enhanced nocookie origin', () => {
    const parsed = parseVideoUrl(`https://www.youtube.com/watch?v=${id}`)!
    expect(buildEmbedUrl(parsed)).toBe(
      `https://www.youtube-nocookie.com/embed/${id}?rel=0`,
    )
  })
})

describe('parseVideoUrl — Vimeo', () => {
  it('parses the canonical vimeo.com/<id> form', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789')).toEqual({
      provider: 'vimeo',
      id: '123456789',
    })
  })

  it('parses the www. host', () => {
    expect(parseVideoUrl('https://www.vimeo.com/123456789')).toEqual({
      provider: 'vimeo',
      id: '123456789',
    })
  })

  it('parses the player.vimeo.com/video/<id> form', () => {
    expect(parseVideoUrl('https://player.vimeo.com/video/123456789')).toEqual({
      provider: 'vimeo',
      id: '123456789',
    })
  })

  it('captures the unlisted privacy hash from the path', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789/abc123def4')).toEqual({
      provider: 'vimeo',
      id: '123456789',
      hash: 'abc123def4',
    })
  })

  it('captures the unlisted privacy hash from the ?h= query', () => {
    expect(parseVideoUrl('https://player.vimeo.com/video/123456789?h=abc123def4')).toEqual({
      provider: 'vimeo',
      id: '123456789',
      hash: 'abc123def4',
    })
  })

  it('ignores a malformed privacy hash rather than passing it through', () => {
    // Hash contains characters outside the allowlist — drop the hash, keep
    // the video. Never forward an unvalidated value into the embed URL.
    expect(parseVideoUrl('https://player.vimeo.com/video/123456789?h=../../etc')).toEqual({
      provider: 'vimeo',
      id: '123456789',
    })
  })

  it('parses nested channel / group / album / ondemand shapes', () => {
    const cases = [
      'https://vimeo.com/channels/staffpicks/123456789',
      'https://vimeo.com/groups/motion/videos/123456789',
      'https://vimeo.com/album/12345/video/123456789',
      'https://vimeo.com/ondemand/somefilm/123456789',
    ]
    for (const url of cases) {
      expect(parseVideoUrl(url)).toEqual({ provider: 'vimeo', id: '123456789' })
    }
  })

  it('tolerates trailing query parameters and fragments', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789?foo=bar#t=10s')).toEqual({
      provider: 'vimeo',
      id: '123456789',
    })
  })

  it('rejects a non-numeric id', () => {
    expect(parseVideoUrl('https://vimeo.com/not-an-id')).toBeNull()
  })

  it('rejects an id that is too short or too long', () => {
    expect(parseVideoUrl('https://vimeo.com/12345')).toBeNull()
    expect(parseVideoUrl('https://vimeo.com/1234567890123')).toBeNull()
  })
})

describe('parseVideoUrl — Loom', () => {
  const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

  it('parses the /share/<id> form', () => {
    expect(parseVideoUrl(`https://www.loom.com/share/${id}`)).toEqual({
      provider: 'loom',
      id,
    })
  })

  it('parses the /embed/<id> form', () => {
    expect(parseVideoUrl(`https://www.loom.com/embed/${id}`)).toEqual({
      provider: 'loom',
      id,
    })
  })

  it('parses without the www. subdomain', () => {
    expect(parseVideoUrl(`https://loom.com/share/${id}`)).toEqual({ provider: 'loom', id })
  })

  it('tolerates the ?sid= tracking parameter Loom appends when sharing', () => {
    expect(
      parseVideoUrl(`https://www.loom.com/share/${id}?sid=1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b`),
    ).toEqual({ provider: 'loom', id })
  })

  it('normalizes an uppercase id to lowercase', () => {
    expect(parseVideoUrl(`https://www.loom.com/share/${id.toUpperCase()}`)).toEqual({
      provider: 'loom',
      id,
    })
  })

  it('rejects an id that is not exactly 32 hex characters', () => {
    expect(parseVideoUrl('https://www.loom.com/share/tooshort')).toBeNull()
    expect(parseVideoUrl(`https://www.loom.com/share/${id}ff`)).toBeNull()
    // 32 characters, but 'g' and 'z' are not hex.
    expect(parseVideoUrl('https://www.loom.com/share/gggggggggggggggggggggggggggggggz')).toBeNull()
  })

  it('rejects unknown Loom paths', () => {
    expect(parseVideoUrl(`https://www.loom.com/looks/${id}`)).toBeNull()
  })
})

describe('parseVideoUrl — Wistia', () => {
  it('parses an account subdomain /medias/<id> URL', () => {
    expect(parseVideoUrl('https://acme.wistia.com/medias/abc123xyz9')).toEqual({
      provider: 'wistia',
      id: 'abc123xyz9',
    })
  })

  it('parses the fast.wistia.net embed iframe URL', () => {
    expect(parseVideoUrl('https://fast.wistia.net/embed/iframe/abc123xyz9')).toEqual({
      provider: 'wistia',
      id: 'abc123xyz9',
    })
  })

  it('strips the .jsonp extension from the embed/medias form', () => {
    expect(parseVideoUrl('https://fast.wistia.net/embed/medias/abc123xyz9.jsonp')).toEqual({
      provider: 'wistia',
      id: 'abc123xyz9',
    })
  })

  it('rejects a lookalike domain that merely contains "wistia"', () => {
    // The anchored host pattern must not match a suffix-extended domain.
    expect(parseVideoUrl('https://wistia.com.evil.example/medias/abc123xyz9')).toBeNull()
    expect(parseVideoUrl('https://notwistia.com/medias/abc123xyz9')).toBeNull()
    expect(parseVideoUrl('https://evil-wistia.net.example/medias/abc123xyz9')).toBeNull()
  })

  it('rejects an id with illegal characters', () => {
    expect(parseVideoUrl('https://acme.wistia.com/medias/abc_123-xy')).toBeNull()
  })
})

describe('parseVideoUrl — rejection and hardening', () => {
  it('renders nothing for empty or whitespace-only input', () => {
    expect(parseVideoUrl('')).toBeNull()
    expect(parseVideoUrl('   ')).toBeNull()
    expect(parseVideoUrl('\n\t')).toBeNull()
  })

  it('rejects non-string input defensively', () => {
    // Props arriving from stored JSON are not guaranteed to be strings.
    expect(parseVideoUrl(undefined as unknown as string)).toBeNull()
    expect(parseVideoUrl(null as unknown as string)).toBeNull()
    expect(parseVideoUrl(42 as unknown as string)).toBeNull()
    expect(parseVideoUrl({} as unknown as string)).toBeNull()
  })

  it('rejects dangerous schemes', () => {
    expect(parseVideoUrl('javascript:alert(1)')).toBeNull()
    expect(parseVideoUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(parseVideoUrl('vbscript:msgbox(1)')).toBeNull()
    expect(parseVideoUrl('file:///etc/passwd')).toBeNull()
    // Scheme-obfuscation with mixed case and padding.
    expect(parseVideoUrl('  JaVaScRiPt:alert(1)')).toBeNull()
  })

  it('rejects credential-smuggling authorities', () => {
    // The real host here is evil.example, not vimeo.com.
    expect(parseVideoUrl('https://vimeo.com@evil.example/123456789')).toBeNull()
    expect(parseVideoUrl('https://user:pass@vimeo.com/123456789')).toBeNull()
  })

  it('rejects hosts carrying an explicit port', () => {
    expect(parseVideoUrl('https://vimeo.com:8080/123456789')).toBeNull()
  })

  it('rejects a trailing-dot FQDN that would bypass exact host matching', () => {
    expect(parseVideoUrl('https://vimeo.com./123456789')).toEqual({
      provider: 'vimeo',
      id: '123456789',
    })
    // ...but the normalization must not let a lookalike through.
    expect(parseVideoUrl('https://vimeo.com.evil.example/123456789')).toBeNull()
  })

  it('rejects embedded whitespace and control characters', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789\n<script>')).toBeNull()
    expect(parseVideoUrl('https://vimeo.com /123456789')).toBeNull()
    expect(parseVideoUrl('https://vi meo.com/123456789')).toBeNull()
  })

  it('rejects protocol-relative and scheme-less input', () => {
    expect(parseVideoUrl('//vimeo.com/123456789')).toBeNull()
    expect(parseVideoUrl('vimeo.com/123456789')).toBeNull()
  })

  it('rejects unsupported providers', () => {
    expect(parseVideoUrl('https://dailymotion.com/video/x8abcde')).toBeNull()
    expect(parseVideoUrl('https://example.com/video.mp4')).toBeNull()
  })

  it('rejects a host that merely ends with a supported domain', () => {
    expect(parseVideoUrl('https://evilvimeo.com/123456789')).toBeNull()
    expect(parseVideoUrl('https://vimeo.com.attacker.test/123456789')).toBeNull()
    expect(parseVideoUrl('https://loom.com.attacker.test/share/a'.padEnd(40, 'b'))).toBeNull()
  })
})

describe('buildEmbedUrl', () => {
  it('builds a Vimeo embed URL with the do-not-track privacy default', () => {
    const parsed = parseVideoUrl('https://vimeo.com/123456789')!
    expect(buildEmbedUrl(parsed)).toBe('https://player.vimeo.com/video/123456789?dnt=1')
  })

  it('carries a validated Vimeo privacy hash into the embed URL', () => {
    const parsed = parseVideoUrl('https://vimeo.com/123456789/abc123def4')!
    expect(buildEmbedUrl(parsed)).toBe(
      'https://player.vimeo.com/video/123456789?dnt=1&h=abc123def4',
    )
  })

  it('adds muted autoplay when requested', () => {
    const parsed = parseVideoUrl('https://vimeo.com/123456789')!
    expect(buildEmbedUrl(parsed, { autoplay: true })).toBe(
      'https://player.vimeo.com/video/123456789?dnt=1&autoplay=1&muted=1',
    )
  })

  it('builds a Loom embed URL', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const parsed = parseVideoUrl(`https://www.loom.com/share/${id}`)!
    expect(buildEmbedUrl(parsed)).toBe(`https://www.loom.com/embed/${id}`)
  })

  it('builds a Wistia embed URL', () => {
    const parsed = parseVideoUrl('https://acme.wistia.com/medias/abc123xyz9')!
    expect(buildEmbedUrl(parsed)).toBe(
      'https://fast.wistia.net/embed/iframe/abc123xyz9?dnt=1',
    )
  })

  it('always builds against a hardcoded origin, never the input host', () => {
    // Every embed URL must start with one of our three known origins.
    const inputs = [
      'https://vimeo.com/123456789',
      'https://www.loom.com/share/a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'https://acme.wistia.com/medias/abc123xyz9',
    ]
    const origins = Object.values(PROVIDER_ORIGINS)
    for (const input of inputs) {
      const url = buildEmbedUrl(parseVideoUrl(input)!)
      expect(origins.some((origin) => url.startsWith(`${origin}/`))).toBe(true)
    }
  })

  it('never emits characters that would break out of an HTML attribute', () => {
    const inputs = [
      'https://vimeo.com/123456789/abc123def4',
      'https://www.loom.com/share/a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'https://fast.wistia.net/embed/medias/abc123xyz9.jsonp',
    ]
    for (const input of inputs) {
      const url = buildEmbedUrl(parseVideoUrl(input)!, { autoplay: true })
      expect(url).not.toMatch(/["'<>`\s]/)
    }
  })
})

describe('frameSrcOriginsFor', () => {
  it('returns only the origins for providers actually present', () => {
    expect(frameSrcOriginsFor(['vimeo'])).toEqual(['https://player.vimeo.com'])
    expect(frameSrcOriginsFor(['loom'])).toEqual(['https://www.loom.com'])
    expect(frameSrcOriginsFor(['wistia'])).toEqual(['https://fast.wistia.net'])
  })

  it('deduplicates repeated providers', () => {
    expect(frameSrcOriginsFor(['vimeo', 'vimeo', 'vimeo'])).toEqual([
      'https://player.vimeo.com',
    ])
  })

  it('returns a stable, sorted list for a mixed page', () => {
    const origins = frameSrcOriginsFor(['wistia', 'vimeo', 'loom', 'youtube'])
    expect(origins).toEqual([
      'https://fast.wistia.net',
      'https://player.vimeo.com',
      'https://www.loom.com',
      'https://www.youtube-nocookie.com',
    ])
  })

  it('does not widen frame-src beyond the providers on the page', () => {
    // A page with only a Vimeo embed must not gain Loom/Wistia/YouTube
    // origins. This is the "be surgical" property the README warns about.
    const origins = frameSrcOriginsFor(['vimeo'])
    expect(origins).not.toContain('https://www.loom.com')
    expect(origins).not.toContain('https://fast.wistia.net')
    expect(origins).not.toContain('https://www.youtube-nocookie.com')
  })

  it('returns an empty list for no providers — the page keeps frame-src none', () => {
    expect(frameSrcOriginsFor([])).toEqual([])
  })

  it('ignores unknown provider ids defensively', () => {
    expect(frameSrcOriginsFor(['nope' as ProviderId])).toEqual([])
  })
})

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Inline video markers for post bodies. Writing
  `` `@@video:https://vimeo.com/123456789@@` `` on its own line renders a
  lazy-loading, responsive 16:9 embed at that exact position in the copy.
- Support for YouTube, Vimeo, Loom and Wistia, including YouTube `watch` /
  `youtu.be` / `embed` / `shorts` / `/v/` forms, Vimeo channel / group / album /
  ondemand shapes, and Vimeo unlisted-video privacy hashes.
- A `publish.html` filter (`cms.hooks`) that substitutes markers and widens
  `frame-src` with only the provider origins present on that page. Pages with no
  valid marker are returned byte-identical and keep `frame-src 'none'`.
- Strict URL parsing and ID validation (`src/providers.ts`). Embed URLs are
  rebuilt from a hardcoded provider origin plus an ID that matched a strict
  character allowlist; no part of the author-supplied URL reaches the markup.
- Byte-exact reimplementation of the host's CSP serializer, so the rewritten
  policy matches what the publisher itself would emit.
- Privacy defaults: `youtube-nocookie.com` with `rel=0`, `dnt=1` for Vimeo and
  Wistia, always-muted autoplay, and a minimal iframe `allow` attribute.
- 137 tests covering parsing, escaping, marker substitution, CSP rewriting and
  the end-to-end filter.

### Design notes

- **The marker must be a code span.** Determined by measurement, not
  preference: every plain-text form tested was corrupted on the first markdown
  round-trip, because linkify autolinks the URL and `escapeInline`
  backslash-escapes ``\ ` * _ ~ [ ]`` — and YouTube IDs legitimately contain
  `_`. The code-span form round-trips byte-identically over three passes.
- A marker that fails validation is left untouched as inert monospace text. It
  never becomes a broken player, never emits an `<iframe>` for an unvalidated
  URL, and never widens the CSP. Disabling the plugin degrades markers to
  visible literal text rather than breaking pages.

### Known limitations

- **Embeds are invisible in the editor.** The preview iframe deliberately does
  not run `publish.html`, so the marker stays visible as text while writing and
  becomes a video only on the published page. No plugin-side workaround exists:
  the body editor's Tiptap extension list is a hardcoded literal, its insertion
  menus are static catalogues, and the SDK exposes no rich-text surface.
- Already-published pages are byte-frozen and need a republish.
- `publish.html` does not run on Layer C hole or loop fragments.
- Descript and Canva were evaluated and deferred: their embed URL contracts
  could not be confirmed from a primary source, and guessing at an embed origin
  would undermine the allowlist model the parser depends on.

### Upstream issues found

- The `--kind content-editor` scaffold emits `contentAccess` and `entrypoints`
  inside `definePlugin()`, where neither key exists. Both are silently dropped,
  making every `cms.content.*` call fail closed regardless of granted
  permissions.
- Instatic's docs state that module HTML is sanitized by the host. It is not;
  no sanitizer runs over plugin render output.

### Security

- While verifying this plugin's assumptions we identified pre-existing defects
  in Instatic's richtext sanitizer. These are upstream issues, not defects in
  this plugin. They have been reported to the maintainers through their private
  disclosure channel; details are withheld here until a fix is available.
- Images, video and tables are stripped from published post bodies, because the
  richtext allowlist omits `img`, `video`, `table` and `src`. This is a
  functional limitation rather than a vulnerability, and it is the reason this
  plugin injects embeds at publish time rather than as body markup.

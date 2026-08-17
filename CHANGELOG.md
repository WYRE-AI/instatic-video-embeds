# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- URL parsing and ID validation for YouTube, Vimeo, Loom and Wistia
  (`src/providers.ts`). Embed URLs are rebuilt from a hardcoded provider origin
  plus an ID that matched a strict character allowlist; no part of the
  author-supplied URL reaches the markup.
- Lazy-loading 16:9 embed markup with an optional poster facade, an accessible
  iframe `title`, and a minimal `allow` attribute (`src/embed.ts`).
- Surgical `frame-src` widening for a `publish.html` filter (`src/csp.ts`),
  mirroring the host's own CSP serialization so the emitted policy stays
  byte-identical to what the publisher would produce.
- 101 tests covering the parsing, escaping and CSP logic.

### Known limitations

- **The plugin is not yet wired together.** The canvas module and server
  entrypoint are deliberately unwritten pending a decision on how to reach
  inline placement — see the README.
- **Inline placement inside a post body is not achievable** with any plugin
  surface Instatic exposes at `6b055cf` (v0.0.16). The body editor's Tiptap
  extension list is a hardcoded literal, the insertion menus are static
  catalogues, and the SDK has no rich-text surface. Raw HTML in a body is
  stripped by DOMPurify, not escaped.
- CSP-dependent behaviour does not appear in the editor canvas, because the
  preview iframe does not run `publish.html`.
- Descript and Canva were evaluated and deferred: their embed URL contracts
  could not be confirmed from a primary source, and guessing at an embed origin
  would undermine the allowlist model the rest of the parser depends on.

### Security

- Independently reproduced two pre-existing defects in Instatic itself while
  verifying this plugin's assumptions. Both are upstream issues, not defects in
  this plugin, and are reported in full in the handover notes:
  - A pre-existing defect in Instatic's richtext sanitizer was identified while
  verifying this plugin. It is an upstream issue, not a defect in this plugin,
  and has been reported through the maintainers' private disclosure channel.
  Details are withheld until a fix is available.
  - Images, video and tables are stripped from published post bodies, because
    the richtext allowlist omits `img`, `video`, `table` and `src`.

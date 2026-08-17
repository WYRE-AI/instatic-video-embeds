# instatic-video-embeds

Multi-provider video embeds (YouTube, Vimeo, Loom, Wistia) for the
[Instatic](https://github.com/CoreBunch/Instatic) CMS, paired with the
`publish.html` CSP filter that plugin modules cannot perform on their own.

> **Status: incomplete, blocked on a product decision.** The primary
> requirement — let an author place a video *inline, at an arbitrary position
> inside a blog post body* — cannot be met by any plugin surface Instatic
> currently exposes. This is a verified negative result, documented in
> [Inline placement is not supported](#inline-placement-is-not-supported)
> below. What is in this repo is the verified, tested core (URL parsing, embed
> markup, CSP widening); the module and server entrypoint that would wire it
> together are deliberately not written yet, because their shape depends on
> which fallback is chosen.

---

## Inline placement is not supported

Verified against `CoreBunch/Instatic` @ `6b055cf` (v0.0.16).

**A plugin cannot register a custom block or node in the post-body editor.**
All three things that would be required fail independently:

1. **The body editor's extension list is a hardcoded literal.**
   `src/admin/pages/content/TiptapBodyEditor.tsx:126-231` passes a static array
   to `useEditor({ extensions: [...] })`. It is not spread from any variable,
   registry, or context, and nothing under `src/admin/pages/content/` references
   the plugin runtime.

2. **The insertion menus are static catalogues.** The slash menu is built by
   `buildSlashItems()` in
   `src/admin/pages/content/components/BodySlashMenu/SlashCommand.ts:86-186`
   (11 fixed items). The canvas notch is four fixed items in
   `src/admin/pages/content/ContentPage.tsx:428-455`. The gutter menu is a
   module-level `QUICK_INSERT` array in
   `src/admin/pages/content/components/BodyFloatingMenu/BodyFloatingMenu.tsx:78-181`.
   None performs a registry lookup. `docs/features/content-workspace.md:82`
   states plainly that the notch *"does not show the Site editor's module
   picker."*

3. **The plugin SDK has no rich-text surface at all.** `tiptap`, `prosemirror`,
   `registerBlock`, `registerNode`, `nodeView`, `blockMenu` and `editorExtension`
   return zero hits across `src/core/plugin-sdk/`, `src/core/plugins/`,
   `server/plugins/` and `examples/`. The complete browser-side API
   (`src/core/plugin-sdk/types/editorApi.ts:17-117`) is commands, toolbar,
   panels, canvas overlays, store, palette and dashboard widgets. The manifest
   is a closed TypeBox schema with exactly four entrypoints —
   `server`, `editor`, `admin`, `modules` (`src/core/plugins/manifest.ts:293-298`).

**And raw HTML in a body is stripped, not escaped.** Post bodies are stored as
markdown and rendered through `renderMarkdownToHtml`, then passed through
DOMPurify with an allowlist that contains no `iframe`, `video`, `img`, `figure`
or `table` (`RICHTEXT_CONFIG.ALLOWED_TAGS`, `src/core/sanitize.ts:123-138`). A
pasted `<iframe>` is silently deleted at publish. It only *looks* like visible
text in the editor, because `src/core/markdown/markdownDocument.ts:144-150`
turns a block-HTML token into a plain text node.

`base.video` does not help: it is a site-canvas module usable only in page and
template trees, so it can sit above or below the body outlet but never *within*
the copy.

### The one path that would actually satisfy inline placement

A plain-text marker in the body (e.g. `@@video:https://vimeo.com/123@@`),
substituted for real markup by a `publish.html` server filter. That filter runs
after DOMPurify and after the CSP `<meta>` is already in the document
(`server/publish/publishedHtmlPipeline.ts:41-71`), so it can insert an
`<iframe>` *and* widen `frame-src` in the same pass.

Honest costs, so this is a decision and not a recommendation dressed up as one:

- **No editor preview.** The author sees raw marker text while writing. The
  preview iframe deliberately does not run `publish.before / publish.html /
  publish.after` (`server/publish/runtime/previewRuntime.ts:106`).
- It is a string rewrite over the whole page, not a first-class block.
- Marker syntax must avoid `` \ ` * _ ~ [ ] `` — `escapeInline`
  (`src/core/markdown/markdownDocument.ts:667-672`) backslash-escapes those
  inside a raw-text node on every editor round-trip.
- An `entrypoints.editor` plugin could add a ⌘K command that inserts the marker.
  That is the closest thing to a block-menu item the SDK allows, and it lands in
  Spotlight and the toolbar, not in the `/` menu.

The alternative is to accept a fixed template slot via `base.video`, which
renders correctly but cannot be positioned in the copy.

---

## Why a CSP filter is required at all

A plugin-registered module **cannot** lift the page's Content-Security-Policy.

Instatic's own `base.video` returns `cspSources` from `render()` to allow
YouTube frames. For *plugin* modules that field is stripped at two independent
boundaries before it ever reaches the publisher:

| Boundary | File | What survives |
| --- | --- | --- |
| QuickJS wire normalizer | `server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts` (`normalizeRenderOutput`) | `{ html, css, js }` |
| Host module adapter | `src/core/plugins/moduleAdapter.ts` (render wrapper) | `{ html, css, js }` |

The published base policy sets `frame-src 'none'`
(`createBaseCspPlan`, `src/core/publisher/cspPlan.ts`). So a plugin module that
emits an `<iframe>` and nothing else produces a frame the browser refuses to
load — silently, with only a console message.

The fix is to pair the module with a **`publish.html` filter** (permission
`cms.hooks`) that adds the required provider origins to `frame-src` **only on
pages that actually contain an embed**. `src/csp.ts` implements this.

### The CSP is a derived value — handle with care

The published policy is built as data and serialized deterministically so the
same inputs always produce byte-identical output, which feeds content hashing.
Clobbering the `<meta>` tag with a naive regex would break that.

`src/csp.ts` therefore mirrors the host's own algorithm rather than inventing
one: parse the policy back into `directive → sources`, union in the new origins,
drop `'none'` (only valid as a sole value), then re-serialize with directives
sorted by name and sources sorted within each directive, joined by `'; '` with a
trailing `';'`. That reproduces `addCspSources` + `serializeCsp` + `cspMetaTag`
from `src/core/publisher/cspPlan.ts` exactly, and `tests/csp.test.ts` pins the
byte-level format.

The host exports a `rewriteCspMeta` helper that does this, but it lives in
`@core/publisher` — a host module that is **not** re-exported from the plugin
SDK and is not reachable from inside the QuickJS sandbox where the filter runs.
Reimplementing it faithfully is the only option.

**Only `frame-src` is ever touched**, and only with the origins for providers
actually present on that page. A page embedding one Vimeo video does not get its
policy widened to Loom, Wistia and YouTube. A page with no embed keeps
`frame-src 'none'`. If a document has no CSP `<meta>` tag, it is returned
unchanged — we never invent a policy.

---

## Security notes

### ID validation is the security boundary

`src/providers.ts` is pure functions over strings, and everything else depends
on it being right:

- **The author's URL is parsed, then discarded.** The only things that survive
  are a provider id from a closed enum and an opaque media id that matched a
  strict character allowlist. Embed URLs are rebuilt from a hardcoded origin
  plus that validated id. **The raw URL is never interpolated into markup.**
- **Allowlist, never blocklist.** Hosts are compared against an exact set (or,
  for Wistia's per-account subdomains, an anchored pattern). Paths must match a
  known shape. Ids must match a strict regex.
- Rejected: credential smuggling (`https://vimeo.com@evil.example/123`),
  lookalike hosts (`vimeo.com.evil.example`), explicit ports, `javascript:` /
  `data:` / `file:` schemes, embedded whitespace and control characters,
  protocol-relative URLs, and bare ids with no URL around them.

| Provider | ID shape | Embed origin |
| --- | --- | --- |
| YouTube | 11 base64-url chars | `https://www.youtube-nocookie.com` |
| Vimeo | 6–12 digits (+ optional privacy hash) | `https://player.vimeo.com` |
| Loom | 32 lowercase hex | `https://www.loom.com` |
| Wistia | 8–12 lowercase alphanumeric | `https://fast.wistia.net` |

### The host does not sanitize module HTML

Instatic's docs state that module output is sanitized. **It is not.**
`applyPublishedHtmlPipeline` runs no sanitizer over the assembled document —
DOMPurify is applied at the prop / richtext / SVG boundary and on media upload,
never to module `render()` output. Escaping is the module's job, and
`src/embed.ts` does it.

### The pre-escaping asymmetry

The publisher runs `escapeProps` over props **before** calling `render()`, and
dispatches on the declared control type:

- `url` / `image` props are scheme-checked but **not** HTML-escaped
- every other type is `escapeHtml`-ed

The editor canvas runs the same module in the admin browser with **raw** props
and no such pass. So the same string arrives pre-escaped on the publish path and
unescaped on the canvas path. Escaping unconditionally would double-encode an
author's "Q&A" into "Q&amp;A"; not escaping would let the canvas break out of
the attribute. `renderEmbed` takes an `escapeText` flag so `render()` and
`preview()` can each do the right thing.

### Privacy defaults

YouTube is embedded against `youtube-nocookie.com` with `rel=0`; Vimeo and
Wistia get `dnt=1`. Autoplay, when enabled, is always muted. The iframe `allow`
attribute grants only what a player needs — never `camera`, `microphone`,
`geolocation` or `payment`.

---

## Editor preview caveat

CSP-dependent behaviour will **not** appear in the editor canvas. The preview
iframe deliberately does not run the publish filters
(`server/publish/runtime/previewRuntime.ts:106`):

> The preview iframe does NOT fire `publish.before / publish.html /
> publish.after` — those mutate persisted state and aren't safe to run on every
> keystroke.

Two further consequences worth knowing:

- **Already-published pages are byte-frozen.** Installing or enabling this
  plugin does not retroactively patch pages baked before it existed; they need a
  republish (`server/publish/republish.ts`).
- **Lazily-hydrated fragments are not covered.** `publish.html` does not run on
  Layer C hole or loop fragments, and those paths discard `cspSources` entirely.

---

## Install

`@instatic/plugin-sdk` is **not published to npm**, and neither is `instatic`
(its `package.json` sets `private: true`). The `instatic-plugin` CLI is a
package.json script inside the Instatic checkout:

```json
"instatic-plugin": "bun run src/core/plugin-sdk/cli/index.ts"
```

So building any plugin requires a local Instatic checkout. For a plugin that
lives outside that checkout — like this one — the SDK must be linked in, or the
build fails with `Cannot find module '@instatic/plugin-sdk'`:

```bash
git clone https://github.com/CoreBunch/Instatic.git ../instatic
cd ../instatic && bun install

# Link the SDK into this plugin so its imports resolve.
cd ../instatic-video-embeds
mkdir -p node_modules/@instatic
ln -s ../../../instatic/src/core/plugin-sdk node_modules/@instatic/plugin-sdk

# Build from the Instatic checkout, pointing at this directory.
cd ../instatic
bun instatic-plugin lint  ../instatic-video-embeds
bun instatic-plugin build ../instatic-video-embeds
```

Then upload the emitted `.plugin.zip` via the admin UI at `/admin/plugins` →
Upload Plugin, and approve the `modules.register` and `cms.hooks` permissions.

### Permissions

| Permission | Why it is required |
| --- | --- |
| `modules.register` | Register the canvas module that renders the embed. |
| `cms.hooks` | Register the `publish.html` filter. **This is the only way to widen `frame-src`** — see above. It is a high-risk permission: the filter receives the entire rendered HTML of every published page and its return value replaces that page. |

## Develop

```bash
bun install
bun test        # 101 tests, no CMS required
bun run typecheck
```

The parsing, escaping and CSP logic are pure functions with no SDK imports, so
they are testable standalone.

## License

MIT — see [LICENSE](LICENSE).

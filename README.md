# instatic-video-embeds

Inline video embeds (YouTube, Vimeo, Loom, Wistia) for
[Instatic](https://github.com/CoreBunch/Instatic) blog post bodies, with a
per-page CSP `frame-src` lift that plugin code cannot otherwise perform.

Write this on its own line anywhere in a post body — **the backticks are
required**:

```markdown
`@@video:https://vimeo.com/123456789@@`
```

At publish time that becomes a lazy-loading, responsive 16:9 embed. Everything
else in the post is untouched.

> **Read [Editor preview caveat](#editor-preview-caveat) before using this.**
> The embed is **invisible while you are writing** — you see the marker text.
> It only becomes a video on the published page. That is a hard constraint of
> Instatic's plugin system, not a bug here.

---

## Supported providers

| Provider | Example URL | ID shape | Embed origin |
| --- | --- | --- | --- |
| YouTube | `https://youtu.be/dQw4w9WgXcQ` | 11 base64-url chars | `https://www.youtube-nocookie.com` |
| Vimeo | `https://vimeo.com/123456789` | 6–12 digits (+ optional privacy hash) | `https://player.vimeo.com` |
| Loom | `https://www.loom.com/share/<32-hex>` | 32 lowercase hex | `https://www.loom.com` |
| Wistia | `https://acme.wistia.com/medias/abc123xyz9` | 8–12 lowercase alphanumeric | `https://fast.wistia.net` |

YouTube `watch` / `youtu.be` / `embed` / `shorts` / `/v/` forms are all
accepted, as are Vimeo's channel, group, album and ondemand URL shapes and
unlisted-video privacy hashes.

Descript and Canva were evaluated and deferred: their embed URL contracts could
not be confirmed from a primary source, and guessing at an embed origin would
undermine the allowlist model the rest of the parser depends on.

### Failure behaviour

An unrecognized or malformed marker is **left exactly as it was** — inert
monospace text. It never becomes a broken player, never emits an `<iframe>` for
an unvalidated URL, and never widens the page's CSP. The same is true if this
plugin is later disabled or uninstalled: markers degrade to visible literal
text rather than breaking the page.

---

## Why the backticks are required

The marker must be an inline **code span**. This was determined by measurement
against Instatic's real markdown round-trip, not by preference.

A marker written as plain text does **not** survive the editor's
markdown → ProseMirror → markdown cycle, for two independent reasons:

1. **Linkify autolinks the URL.** `@@video:https://vimeo.com/123@@` comes back
   as `@@video:[https://vimeo.com/123@@](https://vimeo.com/123@@)` — the
   closing delimiter is swallowed into the href.
2. **`escapeInline` backslash-escapes ``\ ` * _ ~ [ ]``**
   (`src/core/markdown/markdownDocument.ts`). YouTube IDs are
   `[A-Za-z0-9_-]{11}`, so any ID containing `_` returns as `dQw4w9\_gXcQ`.

A code span sidesteps both: `escapeInline` returns text untouched inside a code
mark, and linkify does not autolink within code.

**Measured**, at `v0.0.16-3-g6b055cf7`:

| Marker form | Survives round-trip |
| --- | --- |
| `` `@@video:URL@@` `` (code span) | **yes** — byte-identical over 3 passes |
| `@@video:URL@@` | no — autolinked |
| `::video URL::` | no — autolinked |
| `!video[URL]` | no — autolinked + `[` `]` escaped |
| `{{video URL}}` | no — autolinked |
| bare URL | no — autolinked |

The code span buys a second property for free: it is what makes the
uninstall/disable path degrade to inert text rather than broken markup.

---

## Why a CSP filter is required at all

A plugin-registered module **cannot** lift the page's Content-Security-Policy.

Instatic's own `base.video` returns `cspSources` from `render()` to allow
YouTube frames. That capability is **host-only**: `cspSources` lives on the host
`RenderOutput` and is **absent from the plugin SDK entirely** — it appears
nowhere under `src/core/plugin-sdk/`, and neither `DefineModuleConfig` nor
`PluginRenderOutput` accepts it. A plugin cannot declare it in the first place.

Two runtime normalizers enforce the same conclusion for anything smuggled past
the type layer, each rebuilding a fresh object with exactly `{ html, css, js }`:

| Boundary | File |
| --- | --- |
| QuickJS wire normalizer | `server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts` (`normalizeRenderOutput`) |
| Host module adapter | `src/core/plugins/moduleAdapter.ts` (render wrapper) |

The published base policy sets `frame-src 'none'` (`createBaseCspPlan`,
`src/core/publisher/cspPlan.ts`). So an `<iframe>` emitted by plugin code alone
produces a frame the browser refuses to load — silently, with only a console
message.

The `publish.html` filter is the only route, because the CSP is emitted as a
`<meta http-equiv="Content-Security-Policy">` tag **inside the document**, and
`publish.html` runs last in the pipeline with no sanitizer after it.

### The CSP is a derived value — handled with care

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
`@core/publisher` — not re-exported from the plugin SDK and not reachable from
inside the QuickJS sandbox where the filter runs. Reimplementing it faithfully
is the only option.

**Only `frame-src` is ever touched**, and only with origins for providers
actually present on that page. A page with one Vimeo video does not get widened
to Loom, Wistia and YouTube. A page with no valid marker is returned
**byte-identical** and keeps `frame-src 'none'`. A document with no CSP `<meta>`
tag is returned unchanged — we never invent a policy.

---

## Editor preview caveat

**The embed does not appear while you are editing.** You see the marker text in
the body editor, and the video only exists on the published page.

This is deliberate on Instatic's side. The preview iframe does not run the
publish hooks (`server/publish/runtime/previewRuntime.ts:106`):

> The preview iframe does NOT fire `publish.before / publish.html /
> publish.after` — those mutate persisted state and aren't safe to run on every
> keystroke.

There is no workaround available to a plugin: the body editor's Tiptap
extension list is a hardcoded literal, its insertion menus are static
catalogues, and the plugin SDK has no rich-text surface at all. That is also why
this plugin uses a marker instead of a proper editor block — see
[Why not a real editor block](#why-not-a-real-editor-block).

Two further consequences worth knowing:

- **Already-published pages are byte-frozen.** Installing this plugin does not
  retroactively patch pages baked before it existed; they need a republish
  (`server/publish/republish.ts`).
- **Lazily-hydrated fragments are not covered.** `publish.html` does not run on
  Layer C hole or loop fragments.

---

## Security notes

### ID validation is the security boundary

`src/providers.ts` is pure functions over strings, and everything else depends
on it being right:

- **The author's URL is parsed, then discarded.** The only things that survive
  are a provider ID from a closed enum and an opaque media ID that matched a
  strict character allowlist. Embed URLs are rebuilt from a hardcoded origin
  plus that validated ID. **The raw URL is never interpolated into markup.**
- **Allowlist, never blocklist.** Hosts are compared against an exact set (or,
  for Wistia's per-account subdomains, an anchored pattern). Paths must match a
  known shape. IDs must match a strict regex.
- Rejected: credential smuggling (`https://vimeo.com@evil.example/123`),
  lookalike hosts (`vimeo.com.evil.example`), explicit ports, `javascript:` /
  `data:` / `file:` schemes, embedded whitespace and control characters,
  protocol-relative URLs, and bare IDs with no URL around them.
- Parsing uses an anchored regex, **not** `new URL()` — see
  [the per-VM globals split](#fetch-and-url-availability-depend-on-which-vm-you-are-in).

### The host does not sanitize module HTML

Instatic's docs state that module output is sanitized. **It is not.**
`applyPublishedHtmlPipeline` runs no sanitizer over the assembled document —
DOMPurify is applied at the prop / richtext / SVG boundary and on media upload,
never to what a plugin emits. Escaping is this plugin's job, and `src/embed.ts`
does it.

### The pre-escaping asymmetry

The publisher runs `escapeProps` **before** `render()`, dispatching on control
type: `url` / `image` props are scheme-checked but **not** HTML-escaped, while
every other type is `escapeHtml`-ed. The editor canvas passes props through
**raw**. So the same string arrives pre-escaped on one path and unescaped on the
other. Escaping unconditionally would double-encode an author's "Q&A" into
"Q&amp;A"; not escaping would allow attribute breakout. `renderEmbed` takes an
`escapeText` flag so each path does the right thing.

### Privacy defaults

YouTube is embedded against `youtube-nocookie.com` with `rel=0`; Vimeo and
Wistia get `dnt=1`. Autoplay, when enabled, is always muted. The iframe `allow`
attribute grants only what a player needs — never `camera`, `microphone`,
`geolocation` or `payment`.

---

## Why not a real editor block

Verified against `v0.0.16-3-g6b055cf7`. **A plugin cannot register a custom
block or node in the post-body editor.** Three independent blockers:

1. **The extension list is a hardcoded literal.**
   `src/admin/pages/content/TiptapBodyEditor.tsx:126-231` passes a static array
   to `useEditor({ extensions: [...] })` — not spread from any variable,
   registry or context.
2. **The insertion menus are static catalogues.** `buildSlashItems()`
   (`BodySlashMenu/SlashCommand.ts:86-186`, 11 fixed items), a 4-item notch
   (`ContentPage.tsx:428-455`), and a module-level `QUICK_INSERT` array
   (`BodyFloatingMenu.tsx:78-181`). None performs a registry lookup.
   `docs/features/content-workspace.md:82` states the notch *"does not show the
   Site editor's module picker."*
3. **The SDK has no rich-text surface.** `tiptap`, `prosemirror`,
   `registerBlock`, `registerNode`, `nodeView`, `blockMenu` and
   `editorExtension` return zero hits across the SDK and plugin host. The
   manifest is a closed TypeBox schema with exactly four entrypoints.

**And raw HTML in a body is stripped, not escaped.** The richtext allowlist
(`RICHTEXT_CONFIG.ALLOWED_TAGS`, `src/core/sanitize.ts:123-138`) contains no
`iframe`, `video`, `img`, `figure` or `table`, so a pasted `<iframe>` is
silently deleted at publish.

`base.video` does not help either: it is a site-canvas module usable only in
page and template trees, so it can sit above or below the body outlet but never
*within* the copy.

The marker is therefore the only mechanism that achieves arbitrary inline
placement. Its cost is the preview caveat above.

---

## Install

`@instatic/plugin-sdk` is **not published to npm**, and neither is `instatic`
(its `package.json` sets `private: true`). The `instatic-plugin` CLI is a
package.json script inside the Instatic checkout:

```json
"instatic-plugin": "bun run src/core/plugin-sdk/cli/index.ts"
```

So building requires a local Instatic checkout, and a plugin living outside that
checkout must have the SDK linked in — otherwise the build fails with
`Cannot find module '@instatic/plugin-sdk'`:

```bash
git clone https://github.com/CoreBunch/Instatic.git ../instatic
cd ../instatic && bun install     # must fully succeed; a partial install
                                  # leaves @sinclair/typebox missing

# Link the SDK into this plugin so its imports resolve.
cd ../instatic-video-embeds
mkdir -p node_modules/@instatic
ln -s ../../../instatic/src/core/plugin-sdk node_modules/@instatic/plugin-sdk

# Build from the Instatic checkout, pointing at this directory.
cd ../instatic
bun instatic-plugin lint  ../instatic-video-embeds
bun instatic-plugin build ../instatic-video-embeds
```

That emits `instatic-video-embeds.plugin.zip`. Upload it via the admin UI at
`/admin/plugins` → Upload Plugin and approve the `cms.hooks` permission.

Existing posts need a republish before markers in them take effect.

### Permission: `cms.hooks` — and why it is high-risk

This plugin requests exactly one permission.

| Permission | Why |
| --- | --- |
| `cms.hooks` | Register the `publish.html` filter. **This is the only way to widen `frame-src`** — plugin render output cannot carry CSP. |

Be clear-eyed about what that grant means: a `publish.html` filter receives the
**entire rendered HTML of every published page**, and its return value
**replaces that page**. Nothing sanitizes the output afterwards. Grant it only
to plugin code you have read.

This plugin does **not** request `modules.register`: there is no canvas module,
because a canvas module cannot be placed inside a post body.

---

## Upstream gotchas worth knowing

None of these are defects in this plugin, but each cost real debugging time and
all are worth filing upstream — Instatic is MIT and actively maintained.

### The `content-editor` scaffold is broken out of the box

`bun instatic-plugin init <name> --kind content-editor` emits a config
containing both `contentAccess` and `entrypoints` **inside** `definePlugin()`:

```ts
export default definePlugin({
  // …
  contentAccess: [{ table: 'pages', modes: ['read', 'write'] }],
  entrypoints: { server: 'server/index.js' },
})
```

Neither key exists on `DefinePluginConfig`
(`src/core/plugin-sdk/builders/definePlugin.ts` — zero hits for either), so both
are silently dropped. The consequence: every `cms.content.*` call fails closed
**no matter which permissions were granted**, and it presents as a
misconfigured grant rather than a dropped manifest key. Do not chase it as your
own bug, and do not paper over it by over-granting.

Entrypoints are **auto-detected from directory layout** by the build CLI — a
`server/index.ts` yields `entrypoints.server`, a `modules/` directory yields
`entrypoints.modules`. Declaring them by hand does nothing either way.

### `fetch` and `URL` availability depend on which VM you are in

Plugins run in **two different QuickJS VMs** with different globals:

- **Full plugin VM** (server entrypoint, hooks — where this plugin runs):
  `fetch` **is** available, gated on the `network.outbound` permission plus a
  `networkAllowedHosts` allowlist, and SSRF-guarded.
- **Module-pack VM** (canvas module `render()`): `fetch` is **not** available —
  zero occurrences in the generated module-pack bootstrap. Neither are `URL`,
  `URLSearchParams`, `setTimeout`, `crypto` or `TextEncoder`. `console` exists
  but is a silent no-op.

`URL` is the trap: the editor canvas runs the *same* module code in the admin
browser with full browser globals, so `new URL(...)` works in preview and throws
only at publish. `src/providers.ts` parses with an anchored regex for that
reason.

---

## Develop

```bash
bun install
bun test          # 137 tests, no CMS required
bun run typecheck
```

The parsing, escaping, marker and CSP logic are pure functions with no SDK
imports, so they are testable standalone. `bun run typecheck` is scoped to
`src/` and `tests/` so it passes in a fresh clone;
`instatic-plugin.config.ts` and `server/index.ts` import the SDK and are
typechecked by `instatic-plugin lint` / `build` instead.

### Layout

| Path | Role |
| --- | --- |
| `src/providers.ts` | URL parsing, ID validation, embed URL construction |
| `src/embed.ts` | Facade markup, escaping, poster vetting |
| `src/marker.ts` | Marker matching and substitution |
| `src/csp.ts` | `frame-src` widening |
| `src/filter.ts` | The `publish.html` filter body, as a pure function |
| `server/index.ts` | Thin binding of that function to the hook bus |

## License

MIT — see [LICENSE](LICENSE).

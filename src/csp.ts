/**
 * Surgical `frame-src` widening for published pages.
 *
 * ## Why this file exists
 *
 * A plugin-registered canvas module cannot lift the page's CSP. A module's
 * `render()` may return `cspSources`, and Instatic's own `base.video` uses
 * exactly that to allow YouTube frames — but for *plugin* modules that field is
 * stripped at two independent boundaries before it ever reaches the publisher:
 *
 *   1. The QuickJS wire normalizer keeps only `{ html, css, js }`
 *      (`server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts`,
 *      `normalizeRenderOutput`).
 *   2. The host module adapter returns only `{ html, css, js }`
 *      (`src/core/plugins/moduleAdapter.ts`, in the `render` wrapper).
 *
 * The published base policy sets `frame-src 'none'`
 * (`src/core/publisher/cspPlan.ts`, `createBaseCspPlan`). So a plugin module
 * that emits an `<iframe>` and nothing else produces a frame the browser
 * refuses to load. The module must therefore be paired with a `publish.html`
 * filter — this file — which widens `frame-src` on the pages that actually
 * contain an embed.
 *
 * ## Why the rewrite is shaped the way it is
 *
 * The published CSP is a derived value: the publisher builds it as data and
 * serializes it with deterministic ordering so the same inputs always produce a
 * byte-identical policy (that determinism feeds content hashing). Clobbering
 * the tag with a naive regex would break that.
 *
 * So this module mirrors the host's own algorithm rather than inventing one:
 * parse the policy back into directive → sources, union in the new origins,
 * drop `'none'` (which is only valid as a sole value), then re-serialize with
 * directives sorted by name and sources sorted within each directive, joined by
 * `'; '` with a trailing `';'`. That reproduces `serializeCsp` +
 * `addCspSources` + `cspMetaTag` from `src/core/publisher/cspPlan.ts` exactly.
 *
 * The host exports a `rewriteCspMeta` helper that does this, but it lives in
 * `@core/publisher` — a host module that is NOT re-exported from the plugin
 * SDK and is not reachable from inside the QuickJS sandbox where the filter
 * runs. Reimplementing it faithfully is the only option; `tests/csp.test.ts`
 * pins the output format against the host's documented behaviour.
 */

/**
 * Matches the published-page CSP `<meta>` tag.
 *
 * Deliberately identical to `CSP_META_PATTERN` in
 * `src/core/publisher/cspPlan.ts`. Keeping the emitted tag in the same shape
 * matters: later host stages match this pattern too, and a tag we rewrote into
 * a different shape would stop being matchable.
 */
const CSP_META_PATTERN =
  /<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i

type CspPlan = Map<string, Set<string>>

/**
 * Parse a serialized policy (the `content="…"` value) into directive → sources.
 *
 * Splits on `;` for directives and whitespace for the name and its sources. No
 * dynamic `RegExp` is ever built from the input, so a hostile directive name
 * cannot inject regex metacharacters.
 */
function parseCspContent(content: string): CspPlan {
  const plan: CspPlan = new Map()
  for (const chunk of content.split(';')) {
    const trimmed = chunk.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    const directive = parts[0]
    if (!directive) continue
    plan.set(directive, new Set(parts.slice(1)))
  }
  return plan
}

/**
 * Serialize a plan with deterministic ordering: directives sorted by name,
 * sources sorted within each directive, empty directives dropped.
 */
function serializeCsp(plan: CspPlan): string {
  const directives = [...plan.entries()]
    .filter(([, sources]) => sources.size > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (directives.length === 0) return ''
  return (
    directives
      .map(([name, sources]) => `${name} ${[...sources].sort().join(' ')}`)
      .join('; ') + ';'
  )
}

/**
 * Union sources into a directive. Adding a real source to a `'none'` directive
 * drops `'none'` — it is only valid as the sole value, and mixing it with a
 * real origin is a contradiction the browser resolves unpredictably.
 */
function addCspSources(plan: CspPlan, directive: string, sources: Iterable<string>): void {
  const set = plan.get(directive) ?? new Set<string>()
  set.delete("'none'")
  for (const source of sources) set.add(source)
  plan.set(directive, set)
}

/**
 * Add the given origins to `frame-src` in a published HTML document.
 *
 * Fails safe in both directions:
 *   - No origins to add → the document is returned byte-identical.
 *   - No CSP `<meta>` tag present → the document is returned unchanged. We do
 *     NOT invent a policy. A page without the publisher's meta tag is one we
 *     do not understand, and manufacturing a CSP for it could just as easily
 *     break the page as protect it.
 *
 * Only `frame-src` is ever touched. Every other directive round-trips through
 * parse → serialize unchanged apart from the canonical re-sorting the host
 * itself applies.
 */
export function addFrameSrcOrigins(html: string, origins: readonly string[]): string {
  if (origins.length === 0) return html
  if (typeof html !== 'string' || html.length === 0) return html

  return html.replace(CSP_META_PATTERN, (_full, content: string) => {
    const plan = parseCspContent(content)
    addCspSources(plan, 'frame-src', origins)
    return `<meta http-equiv="Content-Security-Policy" content="${serializeCsp(plan)}">`
  })
}

/**
 * Server entrypoint — registers the `publish.html` filter.
 *
 * Kept deliberately thin. All the logic lives in `src/`, as pure functions
 * over strings, so it is testable without a CMS, a sandbox, or a network. This
 * file exists only to bind that logic to the host's hook bus.
 *
 * The handler runs inside the plugin's QuickJS sandbox, once per published
 * page, with the entire rendered document marshalled in and out as JSON. It is
 * therefore written to do nothing expensive on the common path: a page with no
 * marker falls out of `applyVideoEmbeds` after a single failed regex scan and
 * is returned byte-identical.
 *
 * The handler is synchronous and never throws: `applyVideoEmbeds` is total over
 * its input (including non-string input). A filter that threw would risk taking
 * the publish of that page with it.
 */
import type { ServerPluginModule } from '@instatic/plugin-sdk'
import { applyVideoEmbeds } from '../src/filter'

const mod: ServerPluginModule = {
  activate(api) {
    api.cms.hooks.filter('publish.html', (html) => applyVideoEmbeds(String(html)).html)
  },
}

export default mod
export const activate = mod.activate

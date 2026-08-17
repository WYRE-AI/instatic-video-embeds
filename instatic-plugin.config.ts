import { definePlugin, permissions } from '@instatic/plugin-sdk'

/**
 * Note the permission set: `cms.hooks` ONLY.
 *
 * There is no `modules.register` here because there is no canvas module. A
 * canvas module cannot be placed inside a post body, which is the whole point
 * of this plugin — see the README. The entire feature is the `publish.html`
 * filter, so `cms.hooks` is the only capability required.
 *
 * `entrypoints` is deliberately absent: it is not a field on
 * `DefinePluginConfig`, and the build CLI derives entrypoints from directory
 * layout instead (`server/index.ts` → `entrypoints.server`). Declaring it here
 * would be silently dropped.
 */
export default definePlugin({
  id: 'wyre.video-embeds',
  name: 'Video Embeds',
  version: '0.1.0',
  description:
    'Embed Vimeo, Loom, Wistia and YouTube videos inline in post bodies, with a per-page CSP frame-src lift.',
  permissions: [permissions.cmsHooks],
  license: 'MIT',
  keywords: ['video', 'embed', 'vimeo', 'loom', 'wistia', 'youtube'],
})

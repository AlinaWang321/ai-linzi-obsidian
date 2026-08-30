import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/plugin-update-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const update = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

assert.equal(update.isPluginUpdateAvailable('0.7.103', '0.7.104'), true)
assert.equal(update.isPluginUpdateAvailable('0.7.104', '0.7.104'), false)
assert.equal(update.isPluginUpdateAvailable('0.7.105', '0.7.104'), false)
assert.equal(update.isPluginUpdateAvailable('broken', '0.7.104'), false)
assert.equal(update.isPluginBundleVersionMismatch('0.7.104', '0.7.104'), false)
assert.equal(update.isPluginBundleVersionMismatch('0.7.104', '0.7.103'), true)
assert.equal(update.PLUGIN_UPDATE_NOTICE_TEXT, 'AI霖子插件有新的更新了，请及时更新重启')

console.log('plugin update tests: ok')

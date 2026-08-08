import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/output-routing.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
})
const module = { exports: {} }
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
const routing = module.exports

assert.equal(routing.outputSubfolder('选题', '通用'), '选题')
assert.equal(routing.outputSubfolder('公众号文章', '公众号'), '公众号文章')
assert.equal(routing.outputSubfolder(undefined, '小红书'), '小红书')
assert.equal(routing.outputSubfolder(undefined, '口播'), '口播脚本')
assert.equal(routing.outputSubfolder(undefined, '朋友圈'), '朋友圈')
assert.equal(routing.outputSubfolder(undefined, '通用'), '')

console.log('output folder routing tests passed')

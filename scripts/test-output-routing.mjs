import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
assert.equal(routing.outputSubfolder(undefined, '内部', '谈单复盘'), '销售复盘')
assert.equal(routing.outputSubfolder(undefined, '内部', '销售复盘'), '销售复盘')
assert.equal(routing.outputSubfolder(undefined, '通用'), '')

const actions = await readFile(new URL('../src/actions.ts', import.meta.url), 'utf8')
assert.match(
  actions,
  /outputSubfolder\(contentType, spec\.platform, spec\.skill\)/,
  'writeOutput 必须把来源技能交给输出目录路由',
)
assert.match(
  actions,
  /runSalesReview[\s\S]+?skill: '谈单复盘'[\s\S]+?platform: '内部'/,
  '销售复盘必须保留可被目录路由识别的技能名',
)

console.log('output folder routing tests passed')

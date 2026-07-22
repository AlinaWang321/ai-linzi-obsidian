import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(main, /🖼️ 用 AI 生图/)
assert.match(actions, /\/api\/plugin\/v1\/images\/generate/)
assert.match(actions, /参考图（可选）/)
assert.match(actions, /确认替换原图/)
assert.match(actions, /decision !== 'replace'/)
assert.ok(
  actions.indexOf("decision !== 'replace'") < actions.indexOf('modifyBinary(request.image.file'),
  '必须先确认替换，再修改原图文件',
)
assert.doesNotMatch(actions, /生成修改版并覆盖原图/)
assert.doesNotMatch(actions, /预计最多\s*\$\{?.*积分/)
assert.doesNotMatch(`${actions}\n${main}`, /Seedream/i)

console.log('AI image preview and confirmation tests passed')

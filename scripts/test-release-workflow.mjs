import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

const install = workflow.indexOf('run: npm ci')
const tests = workflow.indexOf('run: npm test')
const marketplace = workflow.indexOf('run: npm run check:marketplace')
const release = workflow.indexOf('run: npm run package:release')

assert.ok(install >= 0, 'release workflow 必须使用 npm ci 恢复锁定依赖')
assert.ok(tests > install, '完整 npm test 必须在安装依赖后、打包前执行')
assert.ok(marketplace > tests, '严格 lint 与 marketplace 检查必须在完整测试后执行')
assert.ok(release > marketplace, '只有全部质量门通过后才能生成 Release 资产')
assert.match(workflow, /GITHUB_REF_NAME[^\n]+manifest version/, 'Release tag 必须与 manifest version 完全一致')

console.log('release workflow quality-gate tests passed')

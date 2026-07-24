import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/vault-search-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const core = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const docs = [
  {
    path: '客户咨询/张老师咨询记录.md',
    filename: '张老师咨询记录.md',
    text: '# 咨询结论\n张老师目前最需要解决的是高客单产品定位和成交路径。',
  },
  {
    path: '内容素材/高客单产品案例.md',
    filename: '高客单产品案例.md',
    text: '# 产品案例\n先明确客户问题，再设计交付路径，最后完成高客单产品定位。',
  },
  {
    path: '生活/旅行.md',
    filename: '旅行.md',
    text: '周末去了海边散步。',
  },
  {
    path: '㊙️财务/收入.md',
    filename: '收入.md',
    text: '高客单产品定位收入记录。',
  },
  {
    path: '.obsidian/plugins/private.md',
    filename: 'private.md',
    text: '高客单产品定位。',
  },
]

const results = core.searchVaultDocuments('帮我找张老师的高客单产品定位', docs)
assert.ok(results.length >= 1)
assert.equal(results[0].path, '客户咨询/张老师咨询记录.md')
assert.ok(results.every((result) => !result.path.includes('㊙️')))
assert.ok(results.every((result) => !result.path.startsWith('.obsidian/')))
assert.ok(results[0].excerpt.includes('高客单产品定位'))
assert.deepEqual(core.searchVaultDocuments('你好', docs), [])

const limited = core.searchVaultDocuments('高客单产品定位', docs, {
  maxSources: 1,
  maxExcerptChars: 240,
  maxTotalChars: 240,
  excludedFolders: ['客户咨询'],
})
assert.equal(limited.length, 1)
assert.equal(limited[0].path, '内容素材/高客单产品案例.md')
assert.ok(limited[0].excerpt.length <= 240)

assert.deepEqual(
  core.normalizeVaultFolderExclusions(' 私人日记\n财务资料,私人日记 '),
  ['私人日记', '财务资料'],
)
assert.equal(core.isVaultSearchPathExcluded('私人日记/今天.md', ['私人日记']), true)

console.log('vault search tests passed')

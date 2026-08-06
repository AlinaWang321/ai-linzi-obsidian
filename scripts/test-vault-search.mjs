import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

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
    text: '内部年度预算秘密，只用于确认普通用户文章不会被名称符号排除。',
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
assert.ok(results.every((result) => !result.path.startsWith('.obsidian/')))
assert.ok(results[0].excerpt.includes('高客单产品定位'))
assert.deepEqual(core.searchVaultDocuments('你好', docs), [])

const privateNamedResults = core.searchVaultDocuments('内部年度预算秘密', docs)
assert.equal(privateNamedResults[0]?.path, '㊙️财务/收入.md')

const limited = core.searchVaultDocuments('高客单产品定位', docs, {
  maxSources: 1,
  maxExcerptChars: 240,
  maxTotalChars: 240,
})
assert.equal(limited.length, 1)
assert.equal(limited[0].path, '内容素材/高客单产品案例.md')
assert.ok(limited[0].excerpt.length <= 240)

const transcriptNow = new Date(2026, 6, 24, 18, 0, 0).getTime()
const transcriptResults = core.searchVaultDocuments(
  '总结今天跟雷琼的咨询逐字稿，在raw文件夹里',
  [
    {
      path: '01_Raw/课程与密训逐字稿/2025.05_运营逐字稿.txt',
      filename: '2025.05_运营逐字稿.txt',
      text: '咨询逐字稿需要从 Raw 文件夹整理，总结咨询内容并更新工作流。'.repeat(80),
      mtime: new Date(2025, 4, 10).getTime(),
    },
    {
      path: '01_Raw/学员商业私教咨询逐字稿/2026.07/20260724133543-雷琼老师第二次商业私教课-逐字稿文本-1.txt',
      filename: '20260724133543-雷琼老师第二次商业私教课-逐字稿文本-1.txt',
      text: '今天与雷琼老师讨论第二次商业私教课，包含定位、产品和下一步行动。',
      mtime: new Date(2026, 6, 24, 16, 51, 15).getTime(),
    },
    {
      path: '01_Raw/学员商业私教咨询逐字稿/2026.03/20260312-雷琼老师第一次咨询-逐字稿.txt',
      filename: '20260312-雷琼老师第一次咨询-逐字稿.txt',
      text: '雷琼老师第一次咨询逐字稿，讨论初始定位。',
      mtime: new Date(2026, 2, 12).getTime(),
    },
  ],
  { nowMs: transcriptNow },
)
assert.equal(
  transcriptResults[0]?.path,
  '01_Raw/学员商业私教咨询逐字稿/2026.07/20260724133543-雷琼老师第二次商业私教课-逐字稿文本-1.txt',
)

assert.equal(core.isVaultSearchPathExcluded('㊙️财务/收入.md'), false)
assert.equal(core.isVaultSearchPathExcluded('.obsidian/plugins/private.md'), true)
assert.equal(core.isVaultSearchPathExcluded('trash/旧文章.md'), true)
assert.equal(core.isVaultSearchPathExcluded('05_System/_sub-agent-summaries.md'), true)
assert.equal(core.isVaultSearchPathExcluded('AGENTS.md'), true)
assert.equal(core.isVaultSearchPathExcluded('system/skills/咨询简报.md'), true)
assert.equal(core.isVaultSearchPathExcluded('system/skills/咨询简报/SKILL.md'), true)
assert.equal(core.isVaultSearchPathExcluded('私人日记/今天.md'), false)

const monthlyFact = core.buildVaultLocalFact(
  '2026年7月份我一共做了多少场咨询？',
  [
    {
      path: '01_Raw/咨询逐字稿/2026.07/20260701103000-甲老师咨询-逐字稿文本-1.txt',
      filename: '20260701103000-甲老师咨询-逐字稿文本-1.txt',
      text: '第一场咨询的第一段。',
    },
    {
      path: '01_Raw/咨询逐字稿/2026.07/20260701103000-甲老师咨询-逐字稿文本-2.txt',
      filename: '20260701103000-甲老师咨询-逐字稿文本-2.txt',
      text: '第一场咨询的第二段。',
    },
    {
      path: '01_Raw/咨询逐字稿/2026.07/20260715140000-乙老师商业私教课-逐字稿.txt',
      filename: '20260715140000-乙老师商业私教课-逐字稿.txt',
      text: '第二场咨询。',
    },
    {
      path: '01_Raw/课程逐字稿/2026.07/20260720-合伙人密训-逐字稿.txt',
      filename: '20260720-合伙人密训-逐字稿.txt',
      text: '课程，不是咨询。',
    },
    {
      path: '01_Raw/咨询逐字稿/2026.06/20260630140000-丙老师咨询-逐字稿.txt',
      filename: '20260630140000-丙老师咨询-逐字稿.txt',
      text: '六月份咨询。',
    },
  ],
)
assert.equal(monthlyFact?.count, 2)
assert.match(monthlyFact?.text ?? '', /2026年7月共有 2 场咨询逐字稿/)

const localSearch = await readFile(new URL('../src/vault-search.ts', import.meta.url), 'utf8')
assert.match(localSearch, /\.getFiles\(\)/)
assert.match(localSearch, /isLocalSearchExtension\(file\.extension\)/)
assert.match(localSearch, /extractPdfText/)
assert.match(localSearch, /extractDocxText/)
assert.match(localSearch, /decodePlainText/)
assert.match(localSearch, /binaryFiles\.length; offset \+= 2/)
assert.match(localSearch, /sourceId: 'V1'/)
assert.match(localSearch, /sourceId: `V\$\{index \+ 2\}`/)

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
assert.match(main, /ai-linzi-vault-source-link/)
assert.match(styles, /button\.ai-linzi-vault-source-link/)
assert.match(styles, /color: #0057ff/)
assert.match(styles, /border: 0/)

console.log('vault search tests passed')

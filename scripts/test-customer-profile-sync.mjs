import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/customer-profile-sync.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'obsidian-stub',
    setup(api) {
      api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
      api.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export class App{}; export class Modal{}; export class Notice{}; export class Setting{}; export class TFile{}',
        loader: 'js',
      }))
    },
  }],
})
const source = bundled.outputFiles[0].text
const sync = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const profile = sync.parseLocalCustomerProfile(
  '02_Wiki/客户档案/小B_客户档案.md',
  `---
tags:
  - 客户档案
客户编号: VIP-023
客户称呼: 小B
微信ID: wx_b
客户阶段: 交付中
精准度: A 精准
咨询日期: 2026.8.10
---
# 小B 客户档案`,
)
assert.ok(profile)
assert.equal(profile.fields.customerCode, 'VIP-023')
assert.equal(profile.fields.name, '小B')
assert.equal(profile.fields.wechatId, 'wx_b')
assert.equal(profile.fields.stage, 'delivering')
assert.equal(profile.fields.quality, 'A')
assert.equal(profile.fields.consultedDate, '2026-08-10')
assert.equal(profile.recommendsCode, false)

const recommendsCode = sync.parseLocalCustomerProfile(
  '02_Wiki/客户档案/客户档案.md',
  '客户称呼：小C\n档案状态：已成交',
)
assert.ok(recommendsCode)
assert.equal(recommendsCode.recommendsCode, true)

assert.equal(
  sync.parseLocalCustomerProfile(
    '01_Raw/咨询交付逐字稿/小B咨询.md',
    '客户称呼：小B\n这是咨询逐字稿正文，没有客户档案标记。',
  ),
  undefined,
  '逐字稿正文不能误触发 CRM 同步',
)

// ── 0.7.50 回归（2026-08-18 小A 档案实锤）：占位词不参与匹配 + 非法阶段不发服务端 ──
const aiGenerated = sync.parseLocalCustomerProfile(
  '02_Wiki/03_客户档案/小A.md',
  [
    '类型: 客户档案',
    '客户阶段: 潜在客户',
    '客户编号: 待补充',
    '客户称呼: 小A',
    '微信ID: 待补充',
    '咨询日期: 2026-08-05',
  ].join('\n'),
)
assert.ok(aiGenerated)
assert.equal(aiGenerated.identifiers.customerCode, undefined, '「待补充」占位编号绝不能参与匹配（小A→小B 错配案）')
assert.equal(aiGenerated.identifiers.wechatId, undefined, '「待补充」占位微信号绝不能参与匹配')
assert.equal(aiGenerated.fields.stage, 'new', '「潜在客户」应映射为合法阶段 new')
assert.equal(aiGenerated.droppedStage, undefined)
assert.equal(aiGenerated.fields.consultedDate, '2026-08-05')

const unknownStage = sync.parseLocalCustomerProfile(
  '02_Wiki/客户档案/小D.md',
  '类型: 客户档案\n客户称呼: 小D\n客户阶段: 重点跟进对象',
)
assert.ok(unknownStage)
assert.equal(unknownStage.fields.stage, undefined, '映射不了的阶段词绝不能发给服务端（阶段不合法 402 案）')
assert.equal(unknownStage.droppedStage, '重点跟进对象', '被丢弃的阶段词要留给弹窗说明')

const wonAlias = sync.parseLocalCustomerProfile(
  '02_Wiki/客户档案/小E.md',
  '类型: 客户档案\n客户称呼: 小E\n客户阶段: 成交',
)
assert.equal(wonAlias?.fields.stage, 'won')

console.log('customer profile CRM sync tests passed')

// ── 0.7.65：字段名固定 + 别名兜底（Alina 报障：写「客户姓名」匹配不上）──
// 纯文本字段：别名 → CRM 键
const aliasCases = [
  ['客户姓名', 'name'], ['客户昵称', 'name'], ['客户称呼', 'name'], ['学员姓名', 'name'],
  ['微信号', 'wechatId'], ['客户微信', 'wechatId'],
  ['渠道来源', 'channel'], ['客户来源', 'channel'],
  ['意向产品', 'intent'], ['职业背景', 'occupation'], ['核心痛点', 'painPoints'],
  ['推荐人', 'referrer'], ['备注', 'notes'], ['客户编号', 'customerCode'],
]
for (const [label, key] of aliasCases) {
  const md = `---\n客户称呼: 基准\n${label}: 测试值\n客户阶段: 已咨询\n---\n# 客户档案\n`
  const parsed = sync.parseLocalCustomerProfile('02_Wiki/客户档案/x.md', md)
  assert.ok(parsed, `${label} 应被识别为客户档案`)
  if (key !== 'name') assert.equal(parsed.fields[key], '测试值', `${label} 应映射到 ${key}`)
}

// 阶段/精准度有合法值白名单：别名认得出，非法值照旧丢弃（不发给服务端）
for (const label of ['客户阶段', '当前阶段', '跟进阶段', '客户状态']) {
  const parsed = sync.parseLocalCustomerProfile(
    '02_Wiki/客户档案/s.md', `---\n客户称呼: 基准\n${label}: 已成交\n---\n# 客户档案\n`)
  assert.equal(parsed?.fields.stage, 'won', `${label} 应映射为 won`)
}
assert.equal(
  sync.parseLocalCustomerProfile('02_Wiki/客户档案/s2.md', '---\n客户称呼: 基准\n客户阶段: 随口乱写\n---\n# 客户档案\n')?.fields.stage,
  undefined, '非法阶段不得发给服务端',
)
for (const label of ['精准度', '客户质量', '客户分级']) {
  const parsed = sync.parseLocalCustomerProfile(
    '02_Wiki/客户档案/q.md', `---\n客户称呼: 基准\n${label}: A\n---\n# 客户档案\n`)
  assert.equal(parsed?.fields.quality, 'A', `${label} 应映射到 quality`)
}

// 用户/AI 自定义的额外属性不参与映射，也不影响识别（14 个是下限不是上限）
const withCustom = sync.parseLocalCustomerProfile(
  '02_Wiki/客户档案/y.md',
  '---\n客户称呼: 小B\n宝宝月龄: 8个月\n体重目标: 减 5kg\n学习阶段: 第二周\n---\n# 客户档案\n',
)
assert.ok(withCustom)
assert.equal(withCustom.fields.name, '小B')
assert.equal(withCustom.fields.stage, undefined) // 「学习阶段」不得被当成客户阶段
assert.equal(Object.keys(withCustom.fields).length, 1) // 自定义属性不进 CRM 载荷

// 只有客户称呼、其余全空也必须能同步（Alina：提取不到就留空，别拦着）
const bare = sync.parseLocalCustomerProfile(
  '02_Wiki/客户档案/z.md',
  '---\n客户称呼: 小C\n客户编号: 待补充\n微信号: 待补充\n渠道来源: 待补充\n---\n# 客户档案\n',
)
assert.ok(bare, '只有称呼也要能建档')
assert.equal(bare.fields.name, '小C')
assert.equal(bare.fields.customerCode, undefined) // 「待补充」清成空，不写进 CRM
assert.equal(bare.fields.wechatId, undefined)

console.log('customer profile field mapping tests passed')

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

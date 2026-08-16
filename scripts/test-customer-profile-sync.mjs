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

console.log('customer profile CRM sync tests passed')

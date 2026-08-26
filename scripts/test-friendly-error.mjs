// 报错文案：只给操作建议，绝不外露技术错误码，绝不提计费/积分（2026-08-18 全产品铁律）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
await import('./test-local-skill-status.mjs')
const src = readFileSync(new URL('../src/friendly-error.ts', import.meta.url), 'utf8')
const body = /export function friendlyErrorMessage\(raw: string\): string \{([\s\S]*?)\n\}/.exec(src)
assert.ok(body, 'friendlyErrorMessage 必须存在')
const fn = new Function('raw', body[1].replace(/: string/g, ''))

// ① 木木的真实错误必须翻成人话，且不含原始错误码
const closed = fn('net::ERR_CONNECTION_CLOSED')
assert.ok(!closed.includes('ERR_'), '不得外露错误码')
assert.ok(!closed.includes('net::'), '不得外露 net:: 前缀')
assert.match(closed, /网络中断|重试/, '必须给出可操作建议')
assert.match(closed, /拆成两段/, '长内容场景必须给出拆分建议')

// ② 各类网络错误都有对应人话
for (const [raw, expect] of [
  ['ERR_CONNECTION_REFUSED', /连不上服务器/],
  ['ERR_NAME_NOT_RESOLVED', /连不上服务器/],
  ['net::ERR_NETWORK_IO_SUSPENDED', /网络中断|重试/],
  ['The operation timed out', /时间太长|拆成两段/],
  ['FUNCTION_INVOCATION_TIMEOUT', /时间太长/],
  ['net::ERR_CERT_AUTHORITY_INVALID', /拦截|代理/],
  ['ERR_SOMETHING_UNKNOWN', /网络出了点问题/],
]) {
  assert.match(fn(raw), expect, `未覆盖：${raw}`)
}

// ③ 业务错误必须原样保留（不能把有用信息也吃掉）
assert.equal(fn('逐字稿只有 200 字，谈单复盘需要 ≥500 字'), '逐字稿只有 200 字，谈单复盘需要 ≥500 字')
assert.equal(fn('“销售复盘”是 Pro 及以上会员功能'), '“销售复盘”是 Pro 及以上会员功能')

// ④ 空错误有兜底
assert.match(fn(''), /没有完成|重试/)

// ⑤ 铁律：任何输出都不许提计费/积分
for (const raw of ['net::ERR_CONNECTION_CLOSED', 'timeout', 'ERR_CONNECTION_REFUSED', '']) {
  const out = fn(raw)
  assert.ok(!/积分|扣费|扣分|计费|余额/.test(out), `报错文案不得提计费：${raw} → ${out}`)
}

// ⑥ 两个长任务技能都必须接入
for (const f of ['../src/actions.ts', '../src/customer-consultation-brief.ts']) {
  const text = readFileSync(new URL(f, import.meta.url), 'utf8')
  assert.match(text, /friendlyErrorMessage\(/, `${f} 未接入友好报错`)
}
console.log('friendly error tests: ok')

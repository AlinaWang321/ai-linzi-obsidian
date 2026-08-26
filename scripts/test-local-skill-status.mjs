import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/local-skill-status.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { recoverLocalSkillStatus } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const running = {
  kind: 'sales-review',
  state: 'running',
  startedAt: 100,
  updatedAt: 200,
}
assert.equal(recoverLocalSkillStatus('生成中', running, true, 300).recovered, false)
const interrupted = recoverLocalSkillStatus('生成中', running, false, 300)
assert.equal(interrupted.recovered, true)
assert.equal(interrupted.run.state, 'failed')
assert.equal(interrupted.run.startedAt, 100)
assert.equal(interrupted.run.updatedAt, 300)
assert.match(interrupted.text, /不能自动续跑/)

const legacy = recoverLocalSkillStatus(
  '🤖 正在生成谈单诊断：《旧逐字稿》…约 1 分钟',
  undefined,
  false,
  400,
)
assert.equal(legacy.recovered, true, '0.7.98 及更早的孤儿状态也必须修复')
assert.equal(legacy.run.state, 'failed')

assert.equal(
  recoverLocalSkillStatus('✅ 已完成', { ...running, state: 'completed' }, false).recovered,
  false,
  '完成态不能被误改',
)
assert.equal(
  recoverLocalSkillStatus('普通本地技能状态', undefined, false).recovered,
  false,
  '无关状态不能被误改',
)

const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
assert.match(actions, /const SALES_REVIEW_CLIENT_TIMEOUT_MS = 390_000/)
assert.match(actions, /}, controller\.signal\)/, '销售复盘必须把超时信号交给 apiText')
assert.doesNotMatch(
  actions.match(/export async function runSalesReview[\s\S]*?\n}\n\n\/\/ ── 一键喂库/)?.[0] ?? '',
  /for \(let attempt/,
  '销售复盘不能盲目自动重试，避免重复生成或重复结算',
)

console.log('local skill status tests: ok')

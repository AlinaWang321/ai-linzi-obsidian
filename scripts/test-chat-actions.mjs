import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const skillList = main.slice(main.indexOf('export const SKILL_ACTIONS'), main.indexOf('// ── 设置'))
const expectedOrder = [
  "id: 'topic-radar'",
  "id: 'wechat-writer'",
  "id: 'interview'",
  "id: 'illustration'",
  "id: 'wechat-copy'",
  "id: 'wechat-draft'",
  "id: 'xhs-cards'",
  "id: 'distribute'",
  "id: 'sales-review'",
]

let cursor = -1
for (const marker of expectedOrder) {
  const next = skillList.indexOf(marker)
  assert.ok(next > cursor, `调用技能顺序错误：${marker}`)
  cursor = next
}
assert.match(skillList, /name: '客户咨询简报:选择逐字稿 → 客户版 PNG 长图'/)
assert.match(skillList, /name: '销售复盘:选择逐字稿 → 销售诊断'/)
assert.match(main, /text: 'CEO驾驶舱'/)
assert.match(main, /cockpitBtn\.onclick = \(\) => void this\.plugin\.activateCockpit\(\)/)
assert.doesNotMatch(main, /const kbBtn = actionsRow\.createEl/)
const messageActionSection = main.slice(
  main.indexOf('// 只显示本轮真正需要的动作'),
  main.indexOf('private async runSuggestedSkill'),
)
assert.doesNotMatch(messageActionSection, /text: '📝 存为笔记'/)
assert.doesNotMatch(messageActionSection, /text: '✏️ 更新当前笔记'/)
assert.match(main, /feedKnowledgeWithResult\(this\.plugin, lockedFile\)/)
assert.match(main, /\/api\/plugin\/v1\/memories\/remember/)
assert.match(main, /pendingRetryReason = 'missing_tool_use'/)
assert.match(main, /vaultWriteSnapshots: this\.plugin\.captureVaultWriteSnapshots\(plan\)/)
assert.match(main, /applyVaultPlan\(plan, message\.vaultWriteSnapshots\)/)

console.log('chat action order and cockpit shortcut tests passed')

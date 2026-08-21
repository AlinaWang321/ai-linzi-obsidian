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
// 0.7.71：内容看板与 CEO驾驶舱 从底部常驻按钮收进 composer 的「工作台」菜单。
// 断言从「按钮存在」改为「入口存在且接线正确」，与承载形态解耦。
assert.match(main, /private buildWorkbenchMenu\(menu: Menu\): void/)
const workbench = main.slice(
  main.indexOf('private buildWorkbenchMenu'),
  main.indexOf('private async showLocalSkillsMenu'),
)
assert.match(workbench, /setTitle\('内容看板'\)[\s\S]{0,120}activateContentDashboard\(\)/)
assert.match(workbench, /setTitle\('CEO驾驶舱'\)[\s\S]{0,120}activateCockpit\(\)/)
// 「技能」菜单必须同时容纳官方技能、我的 Skills 和创建 Skill，一个都不能在改版中丢。
const skillMenu = main.slice(
  main.indexOf('private buildSkillMenu'),
  main.indexOf('private buildWorkbenchMenu'),
)
assert.match(skillMenu, /for \(const c of SKILL_ACTIONS\)/)
assert.match(skillMenu, /setTitle\('我的 Skills'\)/)
assert.match(skillMenu, /setTitle\('创建 Skill'\)/)
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

// 0.7.63 课件PPT 内置技能:排在销售复盘之后、存入知识库之前
assert.match(main, /id: 'deck-builder'/)
assert.match(main, /name: '课件PPT:选择文档 → 网页课件\(放映·⌘P存PDF\)'/)
assert.ok(main.indexOf("id: 'deck-builder'") > main.indexOf("id: 'sales-review'"))
assert.ok(main.indexOf("id: 'deck-builder'") < main.indexOf("id: 'feed-knowledge'"))

console.log('chat action order and cockpit shortcut tests passed')

import assert from 'node:assert/strict'
import { build } from 'esbuild'

function makeEl(tag = 'div') {
  const el = { tag, text: '', cls: '', attrs: {}, disabled: false, onclick: null, children: [] }
  const child = (nextTag, options = {}) => {
    const next = makeEl(nextTag)
    next.text = options.text || ''
    next.cls = options.cls || ''
    next.attrs = options.attr || {}
    el.children.push(next)
    return next
  }
  el.createDiv = (options) => child('div', options)
  el.createSpan = (options) => child('span', options)
  el.createEl = (nextTag, options) => child(nextTag, options)
  return el
}
function all(root, out = []) {
  for (const child of root.children) {
    out.push(child)
    all(child, out)
  }
  return out
}

const bundled = await build({
  entryPoints: ['src/local-skill-choice-card.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { renderLocalSkillChoiceCard } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const candidates = [
  {
    path: '05_System/Skills/first/SKILL.md',
    name: 'shared-name',
    displayName: '客户跟进',
    folderName: 'first',
  },
  {
    path: '05_System/Skills/second/SKILL.md',
    name: 'shared-name',
    displayName: '客户跟进',
    folderName: 'second',
  },
]

console.log('[test-local-skill-choice-card] 同显示名候选按精确路径绑定')
{
  const chosen = []
  const row = makeEl()
  const message = { localSkillChoice: { requestMessageId: 'user-1', candidates } }
  renderLocalSkillChoiceCard({
    isBusy: () => false,
    choose: async (_message, path) => { chosen.push(path) },
  }, row, message)
  const buttons = all(row).filter((el) => el.tag === 'button')
  assert.deepEqual(buttons.map((button) => button.text), ['客户跟进 · first', '客户跟进 · second'])
  buttons[1].onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(chosen, ['05_System/Skills/second/SKILL.md'])
  assert.equal(buttons.every((button) => button.disabled), true, '点击后全部候选都要锁住，防并发双选')
}

console.log('[test-local-skill-choice-card] 失败可重试、运行中与完成态不重复给按钮')
{
  const row = makeEl()
  const message = { localSkillChoice: { requestMessageId: 'user-1', candidates } }
  renderLocalSkillChoiceCard({
    isBusy: () => false,
    choose: async () => { throw new Error('入口已移动') },
  }, row, message)
  const buttons = all(row).filter((el) => el.tag === 'button')
  buttons[0].onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(buttons.every((button) => !button.disabled), true, '选择失败后必须恢复可点')

  const runningRow = makeEl()
  renderLocalSkillChoiceCard({ isBusy: () => true, choose: async () => {} }, runningRow, {
    localSkillChoice: { ...message.localSkillChoice, requestedPath: candidates[0].path },
  })
  assert.equal(all(runningRow).some((el) => el.tag === 'button'), false)
  assert.ok(all(runningRow).some((el) => el.text.includes('正在用 客户跟进 · first 继续')))

  const completedRow = makeEl()
  renderLocalSkillChoiceCard({ isBusy: () => false, choose: async () => {} }, completedRow, {
    localSkillChoice: { ...message.localSkillChoice, completedPath: candidates[1].path },
  })
  assert.equal(all(completedRow).some((el) => el.tag === 'button'), false)
  assert.ok(all(completedRow).some((el) => el.text === '✅ 已选择：客户跟进 · second'))
}

const mainSource = await (await import('node:fs/promises')).readFile('src/main.ts', 'utf8')
const resumeBody = /private async resumeLocalSkillChoice\([\s\S]*?\n  }\n\n  private async runSendTurn/.exec(mainSource)?.[0] ?? ''
assert.match(resumeBody, /this\.runSendTurn\(text, request\.id, \[\]/, '选择后应从原消息继续执行')
assert.match(resumeBody, /forcedLocalSkillPath: path/, '选择卡必须把候选的精确路径交给续跑流程')
assert.doesNotMatch(resumeBody, /this\.send\(/, '选择后绝不能再走 send() 追加第二条用户消息')
assert.doesNotMatch(resumeBody, /this\.messages\.push\(/, '恢复流程本身绝不能追加第二条消息')
assert.doesNotMatch(resumeBody, /this\.inputEl\.value\s*=/, '选择后不能把显示名填回输入框再猜一次')
assert.match(
  mainSource,
  /this\.localSkills\.resolvePath\(options\.forcedLocalSkillPath\)/,
  '续跑流程进入 sending 状态后，仍必须按候选精确路径重新核验入口',
)
assert.match(
  mainSource,
  /filter\(\(message\) =>[\s\S]{0,160}!message\.localSkillStatus && !message\.localSkillChoice/,
  '本机选择卡必须从 API 消息中剥离，让恢复请求仍以原用户消息结尾',
)
assert.match(
  mainSource,
  /localSkillChoice: \{ requestMessageId: userMessageId, candidates \}/,
  '候选卡必须绑定原用户消息 id，不能复制一份请求文本',
)

console.log('local skill choice card behavior tests: ok')

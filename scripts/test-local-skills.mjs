import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/local-skill-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const core = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

assert.equal(core.isLocalSkillPath('system/skills/咨询简报.md'), true)
assert.equal(core.isLocalSkillPath('system/skills/咨询简报/SKILL.md'), true)
assert.equal(core.isLocalSkillPath('System/Skills/咨询简报/skill.md'), true)
assert.equal(core.isLocalSkillPath('system/skills/两层/目录/SKILL.md'), false)
assert.equal(core.isLocalSkillPath('05_System/Skills/咨询简报/SKILL.md'), false)
assert.equal(
  core.isLocalSkillPath('05_System/AI工作流/consultation-brief/SKILL.md', '05_System/AI工作流'),
  true,
)
assert.equal(core.normalizeLocalSkillRoot('05_System/AI工作流/'), '05_System/AI工作流')
assert.equal(core.normalizeLocalSkillRoot('../.obsidian'), 'system/skills')

const consultation = core.buildLocalSkillDescriptor('system/skills/咨询简报/SKILL.md', {
  name: '咨询简报',
  description: '把咨询逐字稿整理成客户可读简报',
  triggers: ['整理咨询', '生成咨询简报'],
  output: '新建笔记',
})
const weekly = core.buildLocalSkillDescriptor('system/skills/每周复盘.md', {
  技能名: '每周经营复盘',
  一句话描述: '根据本周记录完成经营复盘',
  触发词: '周复盘，经营复盘',
  输出方式: '修改当前笔记',
})
assert.ok(consultation)
assert.ok(weekly)
assert.equal(consultation.output, 'create-note')
assert.equal(weekly.output, 'update-current-note')
assert.deepEqual(weekly.triggers, ['每周经营复盘', '周复盘', '经营复盘'])

const portable = core.buildLocalSkillDescriptor(
  'system/skills/weekly-review/SKILL.md',
  {
    name: 'weekly-review',
    description: '根据一周记录完成经营复盘',
  },
  '# 每周经营复盘\n\n## AI霖子输出方式\ncreate-note',
)
assert.ok(portable)
assert.equal(portable.output, 'create-note')
assert.equal(portable.displayName, '每周经营复盘')
assert.equal(
  core.matchLocalSkillInvocation('用每周经营复盘技能整理当前笔记', [portable]).kind,
  'matched',
)

assert.equal(
  core.matchLocalSkillInvocation('用咨询简报技能处理当前笔记', [consultation, weekly]).skill
    .name,
  '咨询简报',
)
assert.equal(
  core.matchLocalSkillInvocation('请调用整理咨询技能', [consultation, weekly]).skill.name,
  '咨询简报',
)
assert.equal(
  core.matchLocalSkillInvocation('/每周经营复盘', [consultation, weekly]).skill.name,
  '每周经营复盘',
)
assert.equal(
  core.matchLocalSkillInvocation('咨询简报应该怎么设计？', [consultation, weekly]).kind,
  'none',
  '只讨论 Skill 时不能静默执行',
)
assert.equal(
  core.matchLocalSkillInvocation('调用不存在的技能', [consultation, weekly]).kind,
  'missing',
)
assert.equal(core.isLocalSkillListIntent('我有哪些本地技能？'), true)
assert.equal(core.isLocalSkillListIntent('我有哪些技能？'), false)
assert.equal(core.isLocalSkillListIntent('/skills'), true)
assert.match(core.formatLocalSkillList([consultation, weekly]), /找到 2 个本地 Skill/)

const duplicate = { ...consultation, path: 'system/skills/另一个.md' }
assert.equal(
  core.matchLocalSkillInvocation('调用咨询简报技能', [consultation, duplicate]).kind,
  'ambiguous',
)

console.log('local skill tests passed')

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
assert.equal(portable.folderName, 'weekly-review')
assert.equal(core.localSkillMenuTitle(portable), '每周经营复盘 · weekly-review')
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
assert.equal(core.isLocalSkillListIntent('/skill'), true)
assert.equal(
  core.isLocalSkillListIntent('用D5 本地 Skill 链路测试技能处理当前笔记'),
  false,
  '显式调用名称里包含“本地 Skill”时不能误判为查看技能清单',
)
assert.match(core.formatLocalSkillList([consultation, weekly]), /找到 2 个本地 Skill/)
assert.doesNotMatch(
  core.formatLocalSkillList([consultation, weekly]),
  /把咨询逐字稿整理成客户可读简报/,
  'Skill 清单不应把给模型看的长 description 铺满界面',
)
assert.equal(core.LOCAL_SKILL_MAX_CONTENT_CHARS, 12_000)
assert.equal(core.LOCAL_SKILL_MAX_ENTRY_CHARS, 120_000)
assert.equal(core.extendContiguousRead(0, 8_000, 2_000), 0, '跳到文件末尾不能算已读')
assert.equal(core.extendContiguousRead(12_000, 12_000, 4_000), 16_000)
assert.equal(core.extendContiguousRead(12_000, 10_000, 4_000), 14_000, '重叠读取可连续推进')
assert.deepEqual(
  core.localSkillLinkedPathCandidates(
    '../../AI团队/工作流程/SOP/数字人口播视频制作SOP.md',
    '05_System/Skills/alina-video-writer',
    '05_System/Skills',
  ),
  ['05_System/AI团队/工作流程/SOP/数字人口播视频制作SOP.md'],
)
assert.deepEqual(
  core.localSkillLinkedPathCandidates(
    'references/style.md',
    '05_System/Skills/demo',
    '05_System/Skills',
  ),
  ['05_System/Skills/demo/references/style.md', 'references/style.md'],
)
assert.deepEqual(
  core.localSkillLinkedPathCandidates(
    '05_System/AI团队/工作流程/SOP/demo.md',
    '05_System/Skills/demo',
    '05_System/Skills',
  ),
  ['05_System/AI团队/工作流程/SOP/demo.md'],
)

const duplicate = { ...consultation, path: 'system/skills/另一个.md' }
assert.equal(
  core.matchLocalSkillInvocation('调用咨询简报技能', [consultation, duplicate]).kind,
  'ambiguous',
)

console.log('local skill tests passed')

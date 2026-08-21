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

// 0.7.54：默认根已改为 05_System/Skills（旧默认 system/skills 只在显式传参时匹配）。
assert.equal(core.isLocalSkillPath('05_System/Skills/咨询简报.md'), true)
assert.equal(core.isLocalSkillPath('05_System/Skills/咨询简报/SKILL.md'), true)
assert.equal(core.isLocalSkillPath('05_system/skills/咨询简报/skill.md'), true)
assert.equal(core.isLocalSkillPath('05_System/Skills/两层/目录/SKILL.md'), false)
assert.equal(core.isLocalSkillPath('system/skills/咨询简报/SKILL.md'), false)
assert.equal(core.isLocalSkillPath('system/skills/咨询简报/SKILL.md', 'system/skills'), true)
assert.equal(core.isLocalSkillPath('我的技能/x/SKILL.md', '我的技能'), true)
assert.equal(
  core.isLocalSkillPath('05_System/AI工作流/consultation-brief/SKILL.md', '05_System/AI工作流'),
  true,
)
assert.equal(core.normalizeLocalSkillRoot('05_System/AI工作流/'), '05_System/AI工作流')
assert.equal(core.normalizeLocalSkillRoot('../.obsidian'), '05_System/Skills')

const consultation = core.buildLocalSkillDescriptor('05_System/Skills/咨询简报/SKILL.md', {
  name: '咨询简报',
  description: '把咨询逐字稿整理成客户可读简报',
  triggers: ['整理咨询', '生成咨询简报'],
  output: '新建笔记',
})
const weekly = core.buildLocalSkillDescriptor('05_System/Skills/每周复盘.md', {
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
  '05_System/Skills/weekly-review/SKILL.md',
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
  core.matchLocalSkillInvocation('使用 weekly-review Skill 运行', [portable]).kind,
  'matched',
  '“使用 + Skill 名称”也应视为显式调用',
)

const dashboard = core.buildLocalSkillDescriptor(
  '05_System/Skills/weekly-business-dashboard/SKILL.md',
  { name: 'weekly-business-dashboard', description: '生成经营周报 HTML 看板' },
  '# 经营周报交互看板\n\n## AI霖子输出方式\ncreate-artifact',
)
assert.ok(dashboard)
assert.equal(dashboard.output, 'create-artifact')

const customerProfile = core.buildLocalSkillDescriptor(
  '05_System/Skills/customer-profile/SKILL.md',
  { name: 'customer-profile', description: '按统一模板创建或更新客户档案' },
  `# 客户档案管理

## AI霖子自动调用
- 创建客户档案
- 更新客户档案
- 补全客户档案

## AI霖子模板校验
[客户档案模板](references/客户档案模板.md)

## AI霖子输出方式
chat`,
)
assert.ok(customerProfile)
assert.deepEqual(customerProfile.autoTriggers, ['创建客户档案', '更新客户档案', '补全客户档案'])
assert.equal(customerProfile.templatePath, 'references/客户档案模板.md')
assert.equal(
  core.matchLocalSkillInvocation('根据最新逐字稿创建客户档案', [customerProfile], { allowAutomatic: true }).automatic,
  true,
)
assert.equal(
  core.matchLocalSkillInvocation('客户档案模板应该怎么设计？', [customerProfile], { allowAutomatic: true }).kind,
  'none',
)
assert.equal(
  core.matchLocalSkillInvocation('根据最新逐字稿创建客户档案', [customerProfile]).kind,
  'none',
  '没有显式开启自动触发时保持旧的安全边界',
)

const structuredTriggers = core.localSkillAutoTriggersFromMarkdown(`
## AI霖子自动调用
说明：下面只有列表项是可执行短语
例如：生成一份演示周报
- 生成本周经营周报看板
* 做最近七天经营复盘看板
\`\`\`
- 代码围栏里的假触发词
\`\`\`
`)
assert.deepEqual(
  structuredTriggers,
  ['生成本周经营周报看板', '做最近七天经营复盘看板'],
  '存在列表项时只认列表项，说明文字、示例和代码围栏不得进入自动触发',
)
assert.deepEqual(
  core.localSkillAutoTriggersFromMarkdown(`
## AI霖子自动调用
说明：
例如：生成一份演示周报
> 引用里的假触发词
生成旧版客户行动清单
整理旧版咨询跟进事项
`),
  ['生成旧版客户行动清单', '整理旧版咨询跟进事项'],
  '没有列表项的旧 Skill 保持兼容，但结构行和提示行必须过滤',
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
assert.equal(
  core.matchLocalSkillInvocation('/不存在的技能', [consultation, weekly]).kind,
  'missing',
)
for (const explanatory of [
  '这个 Skill 为什么这样设计？',
  'weekly-business-dashboard 是做什么的？',
  '咨询简报这个技能有哪些步骤？',
  '调用 API 获取客户列表',
  '使用这个模板生成结果',
  '按照这个 Skill 的说明回答问题',
]) {
  assert.equal(
    core.matchLocalSkillInvocation(explanatory, [consultation, weekly, dashboard], {
      allowAutomatic: true,
    }).kind,
    'none',
    `解释或普通工具用法不能被 Skill 失败路由劫持：${explanatory}`,
  )
}
for (const explicitMissing of [
  '调用 nonexistent Skill 处理当前笔记',
  '请使用一个不存在的技能处理当前笔记',
]) {
  assert.equal(
    core.matchLocalSkillInvocation(explicitMissing, [consultation, weekly]).kind,
    'missing',
    `明确调用不存在的 Skill 必须失败关闭：${explicitMissing}`,
  )
}
for (const normalizedInvocation of [
  '使用 WEEKLY-REVIEW Skill 运行',
  '使用 weekly review skill 运行',
  '使用 ＷＥＥＫＬＹ－ＲＥＶＩＥＷ Ｓｋｉｌｌ 运行',
]) {
  assert.equal(
    core.matchLocalSkillInvocation(normalizedInvocation, [portable]).kind,
    'matched',
    `显式名称应兼容大小写、空格/连字符与全角半角：${normalizedInvocation}`,
  )
}
assert.match(core.formatMissingLocalSkillError([consultation, weekly]), /当前可用：咨询简报、每周经营复盘/)
assert.match(core.formatMissingLocalSkillError([], '我的/Skills'), /我的\/Skills\//)
assert.equal(core.isLocalSkillListIntent('我有哪些本地技能？'), true)
assert.equal(core.isLocalSkillListIntent('我的 Skills'), true)
assert.equal(core.isLocalSkillListIntent('查看我的技能'), true)
assert.equal(core.isLocalSkillListIntent('我有哪些技能？'), false)
assert.equal(core.isLocalSkillListIntent('/skills'), true)
assert.equal(core.isLocalSkillListIntent('/skill'), true)
assert.equal(
  core.isLocalSkillListIntent('用D5 本地 Skill 链路测试技能处理当前笔记'),
  false,
  '显式调用名称里包含“本地 Skill”时不能误判为查看技能清单',
)
assert.match(core.formatLocalSkillList([consultation, weekly]), /“我的 Skills”中共有 2 个 Skill/)
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

const duplicate = { ...consultation, path: '05_System/Skills/另一个.md' }
assert.equal(
  core.matchLocalSkillInvocation('调用咨询简报技能', [consultation, duplicate]).kind,
  'ambiguous',
)

console.log('local skill tests passed')

// 0.7.64:点技能菜单时优先用 Skill 自己声明的触发短语(不同技能处理对象不同,
// 统一填「处理当前笔记」会误导——知识库日报看板处理的是整个知识库)。
import { readFileSync as __readMainForMenu } from 'node:fs'
const __mainForMenu = __readMainForMenu(new URL('../src/main.ts', import.meta.url), 'utf8')
if (!__mainForMenu.includes('skill.autoTriggers[0]?.trim()')) {
  throw new Error('技能菜单未优先使用 Skill 声明的触发短语')
}

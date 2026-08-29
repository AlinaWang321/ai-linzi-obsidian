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
  '不要联网。请生成一个名为“D6课堂讲义验收.docx”的 Word 文档，标题是“造自己的 Skill”，使用清晰的课程讲义排版。',
  '制作一份讲 Skill 的 PPT，使用课程讲解模板。',
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

assert.equal(core.isExplicitLocalSkillUpdateIntent('修改“每周经营复盘”的这个 Skill'), true)
assert.equal(core.isExplicitLocalSkillUpdateIntent('更新客户档案'), false)
assert.equal(
  core.isExplicitLocalSkillUpdateIntent(
    '请把这套流程做成一个新的 Skill。输入步骤里会更新客户档案。',
  ),
  false,
  '新建说明中另一小句的业务更新动作不能冒充修改 Skill',
)
assert.equal(
  core.isExplicitLocalSkillUpdateIntent(
    'b2c-1v1-consultation，这个技能调用后的提示词是否可以修改。之后生成一份咨询方案。',
  ),
  true,
  'Skill 与修改提示词在同一小句时必须判为更新',
)
assert.equal(core.isPotentialLocalSkillUpdateIntent('请修改 codex-daily-reflection'), true)
assert.equal(
  core.isPotentialLocalSkillUpdateIntent(
    '只回答：请同时搜索商业咨询、客户档案和 Skill，不要创建或修改文件。',
  ),
  false,
  '只读检索中的否定式“不要修改文件”不能劫持到 Skill 更新器',
)
assert.equal(
  core.matchLocalSkillUpdateIntent(
    '请同时在整个 Vault 搜索商业咨询、客户档案、经营看板、Skill、课程逐字稿、销售逐字稿；不要创建或修改文件。',
    [consultation, portable],
  ).kind,
  'none',
  '真人验收原句只把 Skill 当搜索主题，必须继续进入普通 Vault 检索',
)
assert.equal(
  core.isExplicitLocalSkillUpdateIntent('修改这个 Skill，但确认前不要真的写入。'),
  true,
  '确认前不写入不能抵消前面的明确 Skill 修改意图',
)
assert.equal(
  core.matchLocalSkillUpdateIntent(
    '你修改“每周经营复盘”的这个技能，以后输出到方法论文件夹',
    [consultation, portable],
  ).skill.path,
  portable.path,
  '自然语言修改必须命中已安装 Skill，而不是再次创建同名目录',
)
const extraction = core.buildLocalSkillDescriptor(
  '05_System/Skills/jingyancuiqu/SKILL.md',
  { name: 'jingyancuiqu', description: '萃取经验并沉淀方法论' },
  '# 经验萃取技能\n\n## AI霖子输出方式\ncreate-note',
)
assert.ok(extraction)
assert.equal(
  core.matchLocalSkillInvocation(
    '用经验萃取 Skill 搜索 01_Raw/课程逐字稿 文件夹里关于 Obsidian 的资料，列出真实文件路径，先不要写入。',
    [consultation, portable, extraction],
  ).skill.path,
  extraction.path,
  '显示名以“技能”结尾时，用户用短名 + Skill 仍必须命中，不得在读取文件夹前报找不到',
)
assert.equal(
  core.matchLocalSkillUpdateIntent(
    '你修改“经验萃取”的这个技能，以后产出的都放在“06方法论和框架”文件夹里面',
    [consultation, portable, extraction],
  ).skill.path,
  extraction.path,
  '截图中的真实说法必须进入已有 Skill 更新，不得报同名创建冲突',
)
const extractionDuplicateShortName = core.buildLocalSkillDescriptor(
  '05_System/Skills/jingyancuiqu-workflow/SKILL.md',
  { name: 'jingyancuiqu-workflow', description: '另一套经验萃取流程' },
  '# 经验萃取工作流\n\n## AI霖子输出方式\nchat',
)
assert.ok(extractionDuplicateShortName)
assert.equal(
  core.matchLocalSkillInvocation(
    '用经验萃取 Skill 处理资料',
    [extraction, extractionDuplicateShortName],
  ).kind,
  'ambiguous',
  '后缀短名发生冲突时必须让用户选择，不能猜错 Skill',
)
assert.equal(
  core.matchLocalSkillUpdateIntent('修改不存在的 Skill', [consultation, portable]).kind,
  'missing',
)
assert.equal(
  core.matchLocalSkillUpdateIntent('更新客户档案', [customerProfile]).kind,
  'none',
  '业务动作没有 Skill 字样时不能误进管理路由',
)
const codexDailyReflection = core.buildLocalSkillDescriptor(
  '05_System/Skills/codex-daily-reflection/SKILL.md',
  { name: 'codex-daily-reflection', description: '生成每日复盘笔记' },
  '# 每日复盘提炼\n\n## AI霖子输出方式\ncreate-note',
)
assert.ok(codexDailyReflection)
assert.equal(
  core.matchLocalSkillUpdateIntent(
    '请修改 codex-daily-reflection：在每次生成的复盘笔记末尾固定增加一行“本次验收版本：0.7.80”。',
    [customerProfile, codexDailyReflection],
  ).skill.path,
  codexDailyReflection.path,
  '用户写出已安装 Skill 的精确英文名时，即使省略 Skill 类型词也必须进入更新器',
)
assert.equal(
  core.matchLocalSkillUpdateIntent(
    '让 codex-daily-reflection 可以读取整个 Vault，优先看我指定的文件夹。',
    [customerProfile, codexDailyReflection],
  ).skill.path,
  codexDailyReflection.path,
  '自然权限表达也必须进入同一个 Skill 更新器，不要求用户先说“修改权限”',
)
assert.equal(
  core.matchLocalSkillUpdateIntent(
    '把 codex-daily-reflection 的读取范围收窄到当前笔记。',
    [customerProfile, codexDailyReflection],
  ).skill.path,
  codexDailyReflection.path,
)
assert.equal(
  core.matchLocalSkillUpdateIntent('开放知识库读取权限', [customerProfile, codexDailyReflection]).kind,
  'none',
  '没有点名已安装 Skill 时不能把普通权限讨论劫持成更新',
)
assert.equal(
  core.matchLocalSkillUpdateIntent('请修改“每周经营复盘”：把输出放到方法论目录', [portable]).skill.path,
  portable.path,
  '用户用引号精确点名中文 Skill 时可以省略类型词',
)

const articleToVideo = core.buildLocalSkillDescriptor(
  '05_System/Skills/article-to-video/SKILL.md',
  { name: 'article-to-video', description: '把当前文章制作成极简信息图短视频' },
  '# 文章转短视频\n\n## AI霖子自动调用\n\n- 用 Article to Video 制作当前笔记\n',
)
assert.ok(articleToVideo)
const boundedArticleVideoRun =
  '用 Article to Video 处理当前文章。严格限制本次范围：只读取当前文章和 05_System/Skills/article-to-video 内明确引用的文件；不得修改其他文件。'
assert.equal(
  core.matchLocalSkillInvocation(boundedArticleVideoRun, [articleToVideo]).kind,
  'matched',
  '显式运行 Article to Video 时，附加本轮读取边界仍必须先命中运行入口',
)
assert.equal(
  core.matchLocalSkillUpdateIntent(boundedArticleVideoRun, [articleToVideo]).kind,
  'matched',
  '该真人原句会同时命中宽松更新候选器，主对话必须显式解决这项路由冲突',
)
assert.equal(
  core.isExplicitLocalSkillUpdateIntent(
    '用 Article to Video 处理当前文章；不得修改 05_System/Skills/article-to-video 以外的文件。',
  ),
  false,
  '“不得修改其他文件”是本轮安全边界，不能被解释成修改 Skill',
)

// 0.7.64:点技能菜单时优先用 Skill 自己声明的触发短语(不同技能处理对象不同,
// 统一填「处理当前笔记」会误导——知识库日报看板处理的是整个知识库)。
import { readFileSync as __readMainForMenu } from 'node:fs'
const __mainForMenu = __readMainForMenu(new URL('../src/main.ts', import.meta.url), 'utf8')
if (!__mainForMenu.includes('skill.autoTriggers[0]?.trim()')) {
  throw new Error('技能菜单未优先使用 Skill 声明的触发短语')
}
assert.match(
  __mainForMenu,
  /if \(localSkillMatch\.kind === 'missing'\) \{[\s\S]{0,180}this\.localSkills\.list\(\)[\s\S]{0,180}formatMissingLocalSkillError\(skills, this\.localSkills\.root\(\)\)/,
  '主对话命中 missing 时必须列出当前可用 Skill，不能重新静默落回普通对话',
)
assert.match(
  __mainForMenu,
  /const requestedLocalSkillInvocation =[\s\S]{0,460}!options\.forcedLocalSkillPath[\s\S]{0,120}this\.localSkills\.resolve\(text, \{ allowAutomatic: false \}\)[\s\S]{0,420}const explicitLocalSkillInvocation =[\s\S]{0,1200}!explicitLocalSkillInvocation[\s\S]{0,260}this\.localSkills\.resolveUpdate\(text\)/,
  '主对话必须让明确运行优先于宽松更新候选器，避免“限制本次读取范围”生成 Skill 更新卡',
)
assert.match(
  __mainForMenu,
  /if \(input\.localSkillContext\) throw error/,
  '本地 Skill 原生工具通道失败时不得静默掉回无工具的散文兼容通道',
)
assert.match(
  __mainForMenu,
  /localSkillPath: activeLocalSkillPath/,
  '停止或失败后必须保留当前 Skill 路径，支持下一句继续',
)
assert.match(
  __mainForMenu,
  /const pendingLocalSkillPath = pendingVaultQuestion\.message\.localSkillPath[\s\S]{0,420}this\.localSkills\.resolvePath\(pendingLocalSkillPath\)[\s\S]{0,700}localSkillMatch = pendingLocalSkill[\s\S]{0,120}\{ kind: 'matched', skill: pendingLocalSkill \}/,
  '本地 Skill 的 ask_user 回答必须恢复精确 Skill 与本机执行上下文，不能误入普通 Vault 工作流',
)
assert.match(
  __mainForMenu,
  /const unansweredVaultQuestion = this\.recentUnansweredVaultQuestion\(\)[\s\S]{0,300}isTerminalVaultQuestionAnswer\(text, unansweredVaultQuestion\.question\)[\s\S]{0,700}不会再调用模型或执行本地动作/,
  '用户选择停止时必须在本机直接结束；即使旧问题超过续跑时限，也不能再发给模型形成澄清循环',
)
const __sendStart = __mainForMenu.indexOf('private async send(options: SendOptions = {})')
const __ordinaryTurnStart = __mainForMenu.indexOf('const attachmentSummary = this.attachmentTurnSummary()', __sendStart)
const __sendPreamble = __mainForMenu.slice(__sendStart, __ordinaryTurnStart)
assert.ok(__sendStart >= 0 && __ordinaryTurnStart > __sendStart, '必须能定位主对话发送入口与普通对话入口')
assert.match(__sendPreamble, /isTerminalVaultQuestionAnswer\(typedText, unansweredVaultQuestion\.question\)/)
assert.match(__sendPreamble, /不会再调用模型或执行本地动作/)
assert.match(__sendPreamble, /this\.renderMessages\(\)[\s\S]*?return/)
assert.ok(
  __sendPreamble.indexOf('不会再调用模型或执行本地动作') < __sendPreamble.indexOf('isBuiltInArticleVideoIntent(typedText)'),
  '终止选项必须在新任务快路由前本机收口，避免出现思考中、扣积分或再次追问',
)
assert.match(
  __mainForMenu,
  /requiredScriptRead\([\s\S]{0,260}status: 'script_read_required'[\s\S]{0,420}confirmLocalSkillAction/,
  '未读脚本必须在弹出执行确认前路由回读取，不能留下 0ms 假失败记录',
)
assert.match(
  __mainForMenu,
  /你是想创建一个新的 Skill，还是修改下面某个已有 Skill/,
  '找不到现有目标时必须让用户确认新建还是修改，不能直接报错结束',
)
assert.match(
  __mainForMenu,
  /\(!exitPendingSkillCreator && pendingSkillCreatorInterview\) \|\|\s+explicitSkillCreation/,
  'Skill Creator 必须复用已判定的新建意图，但明确文章改稿时允许退出旧流程',
)
assert.match(
  __mainForMenu,
  /source: options\.skillUpdatePath \? 'studio' : 'chat'/,
  '自然语言更新必须明确走 chat 更新源，不能伪装成 Studio 创建',
)

console.log('local skill tests passed')

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/vault-agent-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const core = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const folderFixtures = [
  { path: '01_Raw', name: '01_Raw' },
  { path: '01_Raw/课程逐字稿', name: '课程逐字稿' },
  { path: '01_Raw/销售逐字稿', name: '销售逐字稿' },
  { path: '06_Archive/课程逐字稿', name: '课程逐字稿' },
]
assert.deepEqual(
  core.resolveUserSpecifiedFolderPath(
    '用经验萃取 Skill 搜索 01_Raw/课程逐字稿 文件夹里关于 Obsidian 的资料，列出真实文件路径，先不要写入。',
    folderFixtures,
  ),
  { kind: 'matched', path: '01_Raw/课程逐字稿' },
  '用户写出完整目录时必须锁定该目录，即使 Vault 里有同名目录',
)
assert.deepEqual(
  core.resolveUserSpecifiedFolderPath('搜索课程逐字稿文件夹', folderFixtures),
  { kind: 'ambiguous', paths: ['01_Raw/课程逐字稿', '06_Archive/课程逐字稿'] },
  '只写重名目录时必须列候选，不得猜路径',
)

const calls = core.extractVaultToolCalls(`准备继续查找。
<<<VAULT_TOOL_CALLS>>>
{"calls":[{"id":"search-1","name":"vault_search","arguments":{"query":"高客单产品"}},{"id":"read-1","name":"read_note","arguments":{"path":"wiki/产品.md","maxChars":12000}}]}
<<<VAULT_TOOL_CALLS_END>>>`)
assert.equal(calls.invalid, false)
assert.equal(calls.calls.length, 2)
assert.equal(calls.calls[0].name, 'vault_search')
assert.equal(calls.cleanText, '准备继续查找。')

const roundOne = core.namespaceVaultToolCalls(calls.calls, 0)
const roundTwo = core.namespaceVaultToolCalls(calls.calls, 1)
assert.equal(roundOne[0].id, 'r1-1-search-1')
assert.equal(roundTwo[0].id, 'r2-1-search-1')
assert.equal(new Set([...roundOne, ...roundTwo].map((call) => call.id)).size, 4)
assert.equal(core.detectVaultAgentIntent('请把这篇笔记整理到归档目录'), 'organize')
assert.equal(core.detectVaultAgentIntent('请把这篇笔记删除'), 'organize')
assert.equal(core.detectVaultAgentIntent('删除这篇笔记'), 'organize')
assert.equal(core.detectVaultAgentIntent('把当前笔记移入回收站'), 'organize')
assert.equal(core.detectVaultAgentIntent('只读取，不要整理或移动任何文件'), 'answer')
assert.equal(core.detectVaultAgentIntent('不要删除这篇笔记'), 'answer')
assert.equal(core.detectVaultAgentIntent('别帮我删除这篇笔记'), 'answer')
assert.equal(core.detectVaultAgentIntent('先不要写入任何文件，只读取并生成草稿'), 'answer')
assert.equal(core.detectVaultAgentIntent('整理成可写入客户档案的草稿，先不要直接更新档案'), 'answer')
assert.equal(
  core.detectVaultAgentIntent('请把刚才确认的 Markdown 章节追加到 02_Wiki/客户档案/客户甲.md。先读取目标档案，确认前不要写入。'),
  'organize',
)
assert.equal(
  core.detectVaultAgentIntent('把这份草稿再优化一下，输出一个可以直接追加的 Markdown 章节'),
  'answer',
)
assert.equal(core.detectVaultAgentIntent('总结这篇文章'), 'answer')
assert.equal(core.detectVaultAgentIntent('把当前客户档案按统一模板补全'), 'organize')
assert.equal(core.isStructuredNoteWriteIntent('修改当前笔记的 YAML 属性'), true)
assert.equal(core.isStructuredNoteWriteIntent('把当前客户档案的咨询次数更新为 2'), true)
assert.equal(core.isStructuredNoteWriteIntent('客户档案模板应该怎么设计？'), false)
assert.equal(core.isExplicitCurrentNoteTrashRequest('请把当前这篇测试笔记删除，只能移入回收站'), true)
assert.equal(core.isExplicitCurrentNoteTrashRequest('删除这篇笔记'), true)
assert.equal(core.isExplicitCurrentNoteTrashRequest('把它移入回收站'), true)
assert.equal(core.isExplicitCurrentNoteTrashRequest('删除知识库里的重复笔记'), false)
assert.equal(core.isExplicitCurrentNoteTrashRequest('不要删除这篇笔记'), false)
assert.equal(core.isVaultMutationExplicitlyDenied('先不要写入，只生成一份草稿'), true)
assert.equal(core.isVaultMutationExplicitlyDenied('只读取并告诉我有哪些档案'), true)
assert.equal(
  core.isVaultMutationExplicitlyDenied(
    '用经验萃取 Skill 搜索 01_Raw/课程逐字稿 文件夹里关于 Obsidian 的资料，列出真实文件路径，先不要写入。',
  ),
  true,
)
assert.equal(
  core.isVaultMutationExplicitlyDenied('追加到客户甲.md，但确认前不要真的写入'),
  false,
)
assert.equal(core.isExplicitVaultTrashIntent('把知识库里的重复笔记移入回收站'), true)
assert.equal(core.isExplicitVaultTrashIntent('不要删除任何笔记'), false)
assert.equal(core.isExplicitVaultTrashIntent('如何整理重复笔记？'), false)
assert.equal(
  core.vaultAnswerRetryReason(
    '合伙人的私教咨询有多少场',
    '等我把重复沟通去重后，再给你准确场次。',
  ),
  'deferred_answer',
)
assert.equal(
  core.vaultAnswerRetryReason(
    '8月份我做了多少场合伙人私教咨询',
    '我查到的权威汇总里，8月份没有直接给出月度数字；目前只能确认累计统计口径里有187场私教咨询，但这不是8月单月数据。\n\n我继续按8月的逐条咨询记录核对，先把合伙人私教和测评、实操营咨询分开，再去重。',
  ),
  'deferred_answer',
)
assert.equal(
  core.vaultAutoAnswerRetryReason(
    '我这里没法直接改写 Obsidian 里的客户档案文件，你可以手动复制。',
    false,
  ),
  'missing_tool_use',
)
assert.equal(
  core.vaultAutoAnswerRetryReason(
    '收到，我现在把这两次咨询记录追加到小B的客户档案里。',
    false,
  ),
  'missing_tool_use',
)
assert.equal(
  core.vaultAutoAnswerRetryReason('我已经在知识库里找到小B的客户档案。', false),
  'missing_tool_use',
)
assert.equal(
  core.vaultAutoAnswerRetryReason('可以，我们先讨论客户档案模板应该包含哪些字段。', false),
  undefined,
)
assert.equal(
  core.vaultAutoAnswerRetryReason('已经依据刚刚读取的档案完成核对。', true),
  undefined,
)
assert.equal(
  core.vaultAnswerRetryReason('合伙人的私教咨询有多少场', '我找到了相关记录。'),
  'missing_count',
)
assert.equal(
  core.vaultAnswerRetryReason('合伙人的私教咨询有多少场', '共 274 场，统计到 2026 年 8 月 12 日。'),
  undefined,
)
assert.equal(
  core.vaultAnswerRetryReason('合伙人的私教咨询有多少场', '本轮找到了 8 个相关文件。'),
  'missing_count',
)
assert.equal(
  core.vaultAnswerRetryReason(
    '合伙人的私教咨询有多少场',
    '现有资料不足，无法确认准确场次；目前缺少 2024 年以前的记录。',
  ),
  undefined,
)

assert.equal(
  core.extractVaultToolCalls(`<<<VAULT_TOOL_CALLS>>>{"calls":[{"id":"x","name":"delete_file","arguments":{}}]}<<<VAULT_TOOL_CALLS_END>>>`).invalid,
  true,
)

const plan = core.extractVaultOrganizePlan(`我先给你一份待确认方案。
<<<VAULT_ORGANIZE_PLAN>>>
{"title":"整理收件箱","summary":"按主题归档","operations":[{"type":"create_folder","path":"wiki/产品"},{"type":"move","from":"inbox/产品灵感.md","to":"wiki/产品/产品灵感.md"}],"notes":["确认后才执行"]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(plan.invalid, false)
assert.equal(plan.plan?.operations.length, 2)
assert.equal(plan.plan?.operations[1].type, 'move')
assert.equal(plan.cleanText, '我先给你一份待确认方案。')

const trashPlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"删除重复笔记","summary":"只移入回收站","operations":[{"type":"trash_note","path":"inbox/重复内容.md","reason":"用户明确要求"}],"notes":["确认后执行"]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(trashPlan.invalid, false)
assert.equal(trashPlan.plan?.operations[0].type, 'trash_note')
assert.equal(core.operationLabel(trashPlan.plan.operations[0]), '移入回收站：inbox/重复内容.md')

const appendPlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"更新客户档案","summary":"追加咨询记录","operations":[{"type":"append_note","path":"02_Wiki/客户档案/客户甲.md","content":"## 2026-08-15 咨询记录\\n\\n已确认内容"}],"notes":["确认后写入"]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(appendPlan.invalid, false)
assert.equal(appendPlan.plan?.operations[0].type, 'append_note')
assert.equal(core.operationLabel(appendPlan.plan.operations[0]), '追加到笔记：02_Wiki/客户档案/客户甲.md')

const updatePlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"局部更新","summary":"精确替换","operations":[{"type":"update_note","path":"02_Wiki/客户档案/客户甲.md","replacements":[{"old":"旧行动计划","new":"新行动计划"}]}],"notes":[]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(updatePlan.invalid, false)
assert.equal(updatePlan.plan?.operations[0].type, 'update_note')

const multiWritePlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"同步更新","summary":"逐篇预览后一次确认","operations":[{"type":"append_note","path":"02_Wiki/客户档案/客户甲.md","content":"## 新记录\\n\\n已确认"},{"type":"create_note","path":"04_Output/行动清单/客户甲.md","content":"# 行动清单"}],"notes":["任一步失败自动回滚"]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(multiWritePlan.invalid, false)
assert.equal(multiWritePlan.plan?.operations.length, 2)
assert.equal(core.VAULT_NOTE_WRITE_MAX_FILES, 12)

const frontmatterUpdatePlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"更新属性","summary":"精确替换 YAML","operations":[{"type":"update_note","path":"02_Wiki/客户档案/客户甲.md","frontmatter":{"old":"---\\n姓名: 客户甲\\n---","new":"---\\n姓名: 客户甲\\n状态: 已更新\\n---"}}],"notes":[]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(frontmatterUpdatePlan.invalid, false)
assert.equal(frontmatterUpdatePlan.plan?.operations[0].type, 'update_note')
assert.match(frontmatterUpdatePlan.plan?.operations[0].frontmatter?.new ?? '', /状态: 已更新/)

const artifactPlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"生成方案 Word","summary":"本机生成","operations":[{"type":"create_artifact","path":"$OUTPUT/文档/客户方案.docx","format":"docx","title":"客户方案","content":"# 客户方案\\n\\n## 目标\\n\\n完成本月计划","theme":"brand"}],"notes":["确认后生成"]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(artifactPlan.invalid, false)
assert.equal(artifactPlan.plan?.operations[0].type, 'create_artifact')
assert.equal(core.operationLabel(artifactPlan.plan.operations[0]), '生成 DOCX：$OUTPUT/文档/客户方案.docx')

const outputAliasPlan = core.resolveVaultPlanOutputPaths({
  title: '生成行动计划',
  summary: '',
  operations: [{
    type: 'create_note',
    path: '$OUTPUT/行动计划/七天计划.md',
    content: '# 七天计划',
  }],
  notes: [],
}, '04_Output/AI霖子输出')
assert.equal(
  outputAliasPlan.operations[0].path,
  '04_Output/AI霖子输出/行动计划/七天计划.md',
  'create-note 的 $OUTPUT 必须解析为用户当前输出目录',
)

const portableAliasPlan = core.resolveVaultPlanPaths({
  title: '萃取经验',
  summary: '',
  operations: [
    { type: 'move', from: '$RAW/销售逐字稿/客户甲.md', to: '$WIKI/客户档案/客户甲.md' },
    { type: 'create_note', path: 'wiki/知识萃取/客户甲.md', content: '# 客户甲' },
    { type: 'create_note', path: 'output/经验萃取/客户甲.md', content: '# 输出' },
  ],
  notes: [],
}, {
  rawRoot: '01_Raw',
  wikiRoot: '02_Wiki',
  outputRoot: '04_Output/AI霖子输出',
})
assert.equal(portableAliasPlan.operations[0].from, '01_Raw/销售逐字稿/客户甲.md')
assert.equal(portableAliasPlan.operations[0].to, '02_Wiki/客户档案/客户甲.md')
assert.equal(portableAliasPlan.operations[1].path, '02_Wiki/知识萃取/客户甲.md')
assert.equal(portableAliasPlan.operations[2].path, '04_Output/AI霖子输出/经验萃取/客户甲.md')

for (const invalidArtifact of [
  { path: '$OUTPUT/文档/客户方案.pdf', format: 'docx' },
  { path: '../客户方案.docx', format: 'docx' },
  { path: '$OUTPUT/文档/客户方案.exe', format: 'exe' },
]) {
  const extracted = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
${JSON.stringify({ title: '错误成品', summary: '', operations: [{ type: 'create_artifact', title: '客户方案', content: '完整内容', ...invalidArtifact }], notes: [] })}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
  assert.equal(extracted.invalid, true)
}

const unsafeWritePlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"错误计划","summary":"越界","operations":[{"type":"create_note","path":"../客户甲.md","content":"内容"}],"notes":[]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(unsafeWritePlan.invalid, true)
assert.equal(core.VAULT_NOTE_WRITE_MAX_CHARS, 30000)

const vaultAgentSource = readFileSync(new URL('../src/vault-agent.ts', import.meta.url), 'utf8')
assert.match(
  vaultAgentSource,
  /preferredFolders[\s\S]*readPolicy\.fallbackToWholeVault[\s\S]*searchedScope = 'whole-vault-fallback'/,
  '整库权限的 Skill 必须先搜用户指定文件夹，无命中才扩到整个 Vault',
)
assert.match(
  vaultAgentSource,
  /readPolicy\?\.scope === 'current-note'[\s\S]{0,120}readPolicy\?\.scope === 'user-specified-files'[\s\S]{0,180}不能搜索整个 Vault/,
  '只读当前材料的 Skill 必须在工具执行层拒绝扩大检索',
)
assert.match(
  vaultAgentSource,
  /readScope && readScope !== 'whole-vault'[\s\S]{0,120}只有 whole-vault Skill 才能调用/,
  '非整库 Skill 不得借最近文档工具绕过读取范围',
)
assert.match(
  vaultAgentSource,
  /客户档案父目录不存在/,
  '官方咨询闭环必须在确认卡前拦截猜测的客户库目录',
)
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(
  mainSource,
  /localSkillReadPolicy\?\.scope === 'whole-vault'[\s\S]*localSkillContext\.allowedReadFolders = \[folder\.path\]/,
  '主对话必须把用户说出的优先文件夹锁定到 Skill 本轮上下文',
)
assert.match(
  mainSource,
  /consultation-preload-client-library/,
  '官方咨询闭环必须预读客户库目录，避免把安全轮次浪费在固定前置资料上',
)
assert.match(
  mainSource,
  /hasPreloadedCreateSkillEvidence[\s\S]*?'deferred_answer'/,
  '官方成品 Skill 已有预读证据时必须强制生成确认方案，不得误报未调用工具',
)

assert.equal(core.normalizeVaultRelativePath('../secret.md'), null)
assert.equal(core.normalizeVaultRelativePath('/absolute/file.md'), null)
assert.equal(core.normalizeVaultRelativePath('.obsidian/plugins/x'), null)
assert.equal(core.isProtectedVaultPath('AGENTS.md'), true)
assert.equal(core.isProtectedVaultPath('system/skills/demo/SKILL.md'), true)
assert.equal(core.isProtectedVaultPath('㊙️财务/收入.md'), false)
assert.equal(core.isProtectedVaultPath('wiki/产品.md'), false)

// 保护原因分类：Skill 目录跟隐藏目录/回收站/AGENTS.md 性质不同
assert.equal(core.protectedVaultPathReason('05_System/Skills', '05_System/Skills'), 'skills-root')
assert.equal(core.protectedVaultPathReason('.obsidian/plugins', '05_System/Skills'), 'hidden')
assert.equal(core.protectedVaultPathReason('.trash/旧稿.md', '05_System/Skills'), 'trash')
assert.equal(core.protectedVaultPathReason('AGENTS.md', '05_System/Skills'), 'agent-file')
assert.equal(core.protectedVaultPathReason('02_Wiki/产品.md', '05_System/Skills'), null)

// 「一键生成目录」把 Skill 目录列进方案时，新建空文件夹放行……
assert.equal(core.shouldBlockPlanPath('05_System/Skills', 'create_folder', '05_System/Skills'), false)
assert.equal(core.shouldBlockPlanPath('05_System', 'create_folder', '05_System/Skills'), false)
// ……但读写里面的内容照样拦死
assert.equal(core.shouldBlockPlanPath('05_System/Skills/demo/SKILL.md', 'create_note', '05_System/Skills'), true)
assert.equal(core.shouldBlockPlanPath('05_System/Skills/x.docx', 'create_artifact', '05_System/Skills'), true)
assert.equal(core.shouldBlockPlanPath('05_System/Skills/a.md', 'move', '05_System/Skills'), true)
// 隐藏目录 / 回收站 即使是 create_folder 也绝不放行
assert.equal(core.shouldBlockPlanPath('.obsidian/plugins', 'create_folder', '05_System/Skills'), true)
assert.equal(core.shouldBlockPlanPath('.trash/x', 'create_folder', '05_System/Skills'), true)
// 2026-08-18 Alina 拍板开放：12 轮 + 36 万字符预算（打卡营批量整理实测 6 轮/10 万必撞顶）
assert.equal(core.VAULT_AGENT_MAX_ROUNDS, 12)
assert.equal(core.VAULT_AGENT_MAX_TOTAL_RESULT_CHARS, 360_000)

// ── 预算并入：去重 / 截断 / 用尽提示（0.7.45）──
{
  const item = (id, output, ok = true) => ({ callId: id, name: 'read_note', ok, output })
  // 内容完全相同的重复读取只保留一份
  const deduped = core.appendToolResultsWithinBudget(
    [item('a', '同一段内容')],
    [item('b', '同一段内容'), item('c', '新内容')],
  )
  assert.equal(deduped.results.length, 2)
  assert.equal(deduped.exhausted, false)
  // 超预算：截断 + 追加「预算已用满」提示，不报错
  const over = core.appendToolResultsWithinBudget(
    [item('a', 'x'.repeat(90))],
    [item('b', 'y'.repeat(100))],
    120,
  )
  assert.equal(over.exhausted, true)
  assert.ok(over.results.some((entry) => entry.output === core.VAULT_AGENT_BUDGET_EXHAUSTED_NOTE))
  assert.ok(over.results[1].output.includes('内容截断'))
  // 再次并入不重复追加提示
  const again = core.appendToolResultsWithinBudget(over.results, [item('d', 'z'.repeat(50))], 120)
  assert.equal(
    again.results.filter((entry) => entry.output === core.VAULT_AGENT_BUDGET_EXHAUSTED_NOTE).length,
    1,
  )
  // 失败结果（如报错提示）不参与去重，照常保留
  const errors = core.appendToolResultsWithinBudget(
    [item('a', '读取失败', false)],
    [item('b', '读取失败', false)],
  )
  assert.equal(errors.results.length, 2)
}
assert.equal(
  core.isVaultAgentToolAllowed('read_skill_file', { vault: false, localSkill: true }),
  true,
)
assert.equal(
  core.isVaultAgentToolAllowed('read_note', { vault: false, localSkill: true }),
  false,
)
assert.equal(
  core.isVaultAgentToolAllowed('propose_skill_action', { vault: false, localSkill: true }),
  true,
)

const skillRead = core.extractVaultToolCalls(`<<<VAULT_TOOL_CALLS>>>
{"calls":[{"id":"skill-1","name":"read_skill_file","arguments":{"path":"references/workflow.md","offset":12000}}]}
<<<VAULT_TOOL_CALLS_END>>>`)
assert.equal(skillRead.invalid, false)
assert.equal(skillRead.calls[0].name, 'read_skill_file')

const actionProposal = core.extractVaultToolCalls(`<<<VAULT_TOOL_CALLS>>>
{"calls":[{"id":"action-1","name":"propose_skill_action","arguments":{"label":"生成示例","program":"python","args":["$SKILL/scripts/demo.py"],"cwd":"$VAULT","writes":["$OUTPUT/demo.txt"]}}]}
<<<VAULT_TOOL_CALLS_END>>>`)
assert.equal(actionProposal.invalid, false)
assert.equal(actionProposal.calls[0].name, 'propose_skill_action')

// ── 整理方案预检：确认卡出现前拦下注定失败的方案（2026-08-17 客户反馈）──
{
  const vault = new Map([
    ['01_Raw', 'folder'],
    ['01_Raw/卢欣怡', 'folder'],
    ['01_Raw/卢欣怡/职业测评.pdf', 'file'],
    ['02_Wiki', 'folder'],
    ['02_Wiki/占位.md', 'file'],
  ])
  const lookup = (path) => vault.get(path) ?? null

  // 合法方案：新建文件夹 + 移动真实存在的 PDF → 零问题
  const okPlan = {
    title: '整理卢欣怡资料',
    summary: '',
    notes: [],
    operations: [
      { type: 'create_folder', path: '02_Wiki/卢欣怡' },
      { type: 'move', from: '01_Raw/卢欣怡/职业测评.pdf', to: '02_Wiki/卢欣怡/职业测评.pdf' },
    ],
  }
  assert.deepEqual(core.collectOrganizePlanProblems(okPlan, lookup, '05_System/Skills'), [])

  // 猜错的源路径 + 保护目录 + 目标已存在：一次列出全部问题
  const badPlan = {
    title: '整理',
    summary: '',
    notes: [],
    operations: [
      { type: 'move', from: '01_Raw/不存在.pdf', to: '02_Wiki/x.pdf' },
      { type: 'move', from: '01_Raw/卢欣怡/职业测评.pdf', to: '02_Wiki/占位.md' },
      { type: 'move', from: '.obsidian/app.json', to: '02_Wiki/app.json' },
    ],
  }
  const problems = core.collectOrganizePlanProblems(badPlan, lookup, '05_System/Skills')
  assert.ok(problems.some((item) => item.includes('源文件不存在：01_Raw/不存在.pdf')), problems.join(' / '))
  assert.ok(problems.some((item) => item.includes('目标已存在')), problems.join(' / '))
  assert.ok(problems.some((item) => item.includes('不能改变文件类型')), problems.join(' / '))
  assert.ok(problems.some((item) => item.includes('保护目录')), problems.join(' / '))

  // 组合约束：删除必须纯删除成卡，不能与其他操作混排（v0.7.42 起允许批量）
  const mixedTrash = {
    title: '',
    summary: '',
    notes: [],
    operations: [
      { type: 'trash_note', path: '02_Wiki/占位.md' },
      { type: 'create_folder', path: '02_Wiki/新目录' },
    ],
  }
  assert.ok(
    core.collectOrganizePlanProblems(mixedTrash, lookup, '05_System/Skills')
      .some((item) => item.includes('移入回收站的方案不能混入')),
  )

  // v0.7.42：批量删除任意文件类型（含非 md 附件和文件夹）→ 预检零问题
  const batchTrash = {
    title: '清理演示产物',
    summary: '',
    notes: [],
    operations: [
      { type: 'trash_note', path: '02_Wiki/占位.md' },
      { type: 'trash_note', path: '01_Raw/卢欣怡/职业测评.pdf' },
    ],
  }
  assert.deepEqual(core.collectOrganizePlanProblems(batchTrash, lookup, '05_System/Skills'), [])

  // 文件夹可删，但目标嵌套在另一个待删文件夹内必须报重复
  const nestedTrash = {
    title: '',
    summary: '',
    notes: [],
    operations: [
      { type: 'trash_note', path: '01_Raw/卢欣怡' },
      { type: 'trash_note', path: '01_Raw/卢欣怡/职业测评.pdf' },
    ],
  }
  assert.ok(
    core.collectOrganizePlanProblems(nestedTrash, lookup, '05_System/Skills')
      .some((item) => item.includes('已在待删除文件夹')),
  )

  // 重复目标与不存在的目标分别报错
  const dupTrash = {
    title: '',
    summary: '',
    notes: [],
    operations: [
      { type: 'trash_note', path: '02_Wiki/占位.md' },
      { type: 'trash_note', path: '02_Wiki/占位.md' },
      { type: 'trash_note', path: '02_Wiki/不存在.png' },
    ],
  }
  {
    const problems = core.collectOrganizePlanProblems(dupTrash, lookup, '05_System/Skills')
    assert.ok(problems.some((item) => item.includes('重复的删除目标：02_Wiki/占位.md')))
    assert.ok(problems.some((item) => item.includes('没有找到要移入回收站的文件或文件夹：02_Wiki/不存在.png')))
  }

  // 目标父路径被文件占用（执行时 ensureFolder 必炸）→ 预检就要报
  const fileAsFolder = {
    title: '',
    summary: '',
    notes: [],
    operations: [
      { type: 'move', from: '01_Raw/卢欣怡/职业测评.pdf', to: '02_Wiki/占位.md/职业测评.pdf' },
    ],
  }
  assert.ok(
    core.collectOrganizePlanProblems(fileAsFolder, lookup, '05_System/Skills')
      .some((item) => item.includes('目标父路径不是文件夹：02_Wiki/占位.md')),
  )

  // 移动文件夹到自己内部 + 父子同移
  const selfMove = {
    title: '',
    summary: '',
    notes: [],
    operations: [
      { type: 'move', from: '01_Raw/卢欣怡', to: '01_Raw/卢欣怡/子目录' },
      { type: 'move', from: '01_Raw/卢欣怡/职业测评.pdf', to: '02_Wiki/职业测评.pdf' },
    ],
  }
  const selfMoveProblems = core.collectOrganizePlanProblems(selfMove, lookup, '05_System/Skills')
  assert.ok(selfMoveProblems.some((item) => item.includes('不能把文件夹移动到自己内部')))
  assert.ok(selfMoveProblems.some((item) => item.includes('不能同时移动父文件夹和其中的子文件')))

  // 写入父文件夹内的笔记时，不能在同一个事务里移动该父文件夹。
  const writeInsideMovedFolder = {
    title: '',
    summary: '',
    notes: [],
    operations: [
      { type: 'create_note', path: '01_Raw/卢欣怡/新笔记.md', content: '# 新笔记' },
      { type: 'move', from: '01_Raw/卢欣怡', to: '02_Wiki/卢欣怡' },
    ],
  }
  assert.ok(
    core.collectOrganizePlanProblems(writeInsideMovedFolder, lookup, '05_System/Skills')
      .some((item) => item.includes('写入笔记并移动它所在的路径')),
  )
}

// 确认执行失败 → 合成工具结果交回模型（复用 read_note 通道）
{
  const failure = core.buildVaultExecuteFailureToolResult('整理卢欣怡资料', '源文件不存在：01_Raw/x.pdf')
  assert.equal(failure.callId, 'vault-execute-failure')
  assert.equal(failure.name, 'read_note')
  assert.equal(failure.ok, false)
  assert.ok(failure.output.includes('本机执行失败'))
  assert.ok(failure.output.includes('源文件不存在：01_Raw/x.pdf'))
  assert.ok(failure.output.includes('list_folder'))
}

console.log('vault agent protocol tests passed')

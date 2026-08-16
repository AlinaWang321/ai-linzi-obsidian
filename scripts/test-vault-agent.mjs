import assert from 'node:assert/strict'
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
assert.equal(core.shouldUseVaultAgent('帮我找一下 Vault 里的产品定位笔记'), true)
assert.equal(core.shouldUseVaultAgent('帮我找一下知识库里的咨询记录'), true)
assert.equal(core.shouldUseVaultAgent('帮我找一下文件里的咨询记录'), true)
assert.equal(core.shouldUseVaultAgent('帮我找一下仓库里的咨询记录'), true)
assert.equal(core.shouldUseVaultAgent('查一下数字大脑中的客户交付记录'), true)
assert.equal(core.shouldUseVaultAgent('看看文件仓库里有哪些销售逐字稿'), true)
assert.equal(core.shouldUseVaultAgent('搜索咨询逐字稿'), true)
assert.equal(core.shouldUseVaultAgent('处理咨询交付逐字稿'), true)
assert.equal(core.shouldUseVaultAgent('从咨询交付逐字稿文件夹中扫描读取'), true)
assert.equal(core.shouldUseVaultAgent('定位最新一份交付顾问咨询逐字稿'), true)
assert.equal(core.shouldUseVaultAgent('分析销售逐字稿'), true)
assert.equal(core.shouldUseVaultAgent('在 Obsidian 里找一下最新复盘'), true)
assert.equal(core.shouldUseVaultAgent('我的产品定位笔记在哪里？'), true)
assert.equal(core.shouldUseVaultAgent('请把这些文件整理到归档目录'), true)
assert.equal(core.shouldUseVaultAgent('帮我删除知识库里的重复笔记'), true)
assert.equal(core.shouldUseVaultAgent('你好，今天适合写什么内容？'), false)
assert.equal(core.shouldUseVaultAgent('知识库应该怎么搭建？'), false)
assert.equal(core.shouldUseVaultAgent('再看看那个文件', true), true)
assert.equal(core.shouldUseVaultAgent('再给我三个标题', false), false)
assert.equal(
  core.shouldUseVaultAgent(
    '把这份草稿再优化一下：保留长期客户档案真正需要的事实，输出一个可以直接追加的 Markdown 章节。',
    true,
  ),
  false,
)
assert.equal(
  core.shouldUseVaultAgent('请把刚才确认的章节追加到 02_Wiki/客户档案/客户甲.md', true),
  true,
)

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
  core.deterministicVaultFactAnswer([
    {
      callId: 'seed-consultation-count',
      name: 'vault_search',
      ok: true,
      output: JSON.stringify({
        fact: { filename: 'Vault 本地统计', excerpt: '2026年8月的明细中共 7 场私教。' },
        matches: [],
      }),
    },
  ]),
  '2026年8月的明细中共 7 场私教。',
)
assert.equal(
  core.deterministicVaultFactAnswer([
    {
      callId: 'search',
      name: 'vault_search',
      ok: true,
      output: JSON.stringify({ matches: [{ filename: '普通搜索.md' }] }),
    },
  ]),
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

const frontmatterUpdatePlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"更新属性","summary":"精确替换 YAML","operations":[{"type":"update_note","path":"02_Wiki/客户档案/客户甲.md","frontmatter":{"old":"---\\n姓名: 客户甲\\n---","new":"---\\n姓名: 客户甲\\n状态: 已更新\\n---"}}],"notes":[]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(frontmatterUpdatePlan.invalid, false)
assert.equal(frontmatterUpdatePlan.plan?.operations[0].type, 'update_note')
assert.match(frontmatterUpdatePlan.plan?.operations[0].frontmatter?.new ?? '', /状态: 已更新/)

const unsafeWritePlan = core.extractVaultOrganizePlan(`<<<VAULT_ORGANIZE_PLAN>>>
{"title":"错误计划","summary":"越界","operations":[{"type":"create_note","path":"../客户甲.md","content":"内容"}],"notes":[]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(unsafeWritePlan.invalid, true)
assert.equal(core.VAULT_NOTE_WRITE_MAX_CHARS, 30000)

assert.equal(core.normalizeVaultRelativePath('../secret.md'), null)
assert.equal(core.normalizeVaultRelativePath('/absolute/file.md'), null)
assert.equal(core.normalizeVaultRelativePath('.obsidian/plugins/x'), null)
assert.equal(core.isProtectedVaultPath('AGENTS.md'), true)
assert.equal(core.isProtectedVaultPath('system/skills/demo/SKILL.md'), true)
assert.equal(core.isProtectedVaultPath('㊙️财务/收入.md'), false)
assert.equal(core.isProtectedVaultPath('wiki/产品.md'), false)
assert.equal(core.VAULT_AGENT_MAX_ROUNDS, 6)
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

console.log('vault agent protocol tests passed')

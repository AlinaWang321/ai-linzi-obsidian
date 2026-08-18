// 阶段 A（2026-08-17）跨轮任务状态机回归：对应交接手册 §10 的可脚本化场景。
// 状态推进只认本机真实工具事件，不认模型措辞——这是修复「回答了但没干活」的核心。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

const NOW = 1_700_000_000_000
const newTask = (overrides = {}) => ({
  id: 'task-1',
  goal: '小B有几次咨询，帮我补进她的客户档案',
  intent: 'organize',
  stage: 'searching',
  candidatePaths: [],
  sourcePaths: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
})

console.log('[test-vault-task-state]')

// ── 1. reducer 阶段推进 ──
{
  let task = newTask()
  task = core.advanceVaultTask(task, { type: 'search', candidatePaths: ['02_Wiki/客户档案/小B.md', '01_Raw/小B咨询1.md'] }, NOW + 1)
  assert.equal(task.stage, 'searched')
  assert.equal(task.candidatePaths.length, 2)
  task = core.advanceVaultTask(task, { type: 'read', snapshot: { path: '01_Raw/小B咨询1.md', mtime: 1, size: 100 }, isTarget: false }, NOW + 2)
  assert.equal(task.stage, 'source_read')
  task = core.advanceVaultTask(task, { type: 'read', snapshot: { path: '02_Wiki/客户档案/小B.md', mtime: 2, size: 200 }, isTarget: true }, NOW + 3)
  assert.equal(task.stage, 'target_read')
  assert.equal(task.targetPath, '02_Wiki/客户档案/小B.md')
  task = core.advanceVaultTask(task, { type: 'previewed', targetPath: '02_Wiki/客户档案/小B.md' }, NOW + 4)
  assert.equal(task.stage, 'previewed')
  // 阶段只进不退：后续搜索不把 previewed 打回 searched
  task = core.advanceVaultTask(task, { type: 'search', candidatePaths: ['x.md'] }, NOW + 5)
  assert.equal(task.stage, 'previewed')
  console.log('  ✓ 1. reducer 按工具事件单向推进阶段')
}

// ── 2. 写入流程结构化判定：搜到不读 → 拦截（手册场景 6）──
{
  const searchedOnly = newTask({ stage: 'searched', candidatePaths: ['02_Wiki/客户档案/小B.md'] })
  assert.equal(core.vaultWriteFlowRetryReason(searchedOnly, 'organize', false, false), 'stalled_write_flow')
  const targetRead = newTask({ stage: 'target_read', targetPath: '02_Wiki/客户档案/小B.md' })
  assert.equal(core.vaultWriteFlowRetryReason(targetRead, 'organize', false, false), undefined)
  // 没有任务对象也没有工具调用 → missing_tool_use（手册场景 5）
  assert.equal(core.vaultWriteFlowRetryReason(null, 'organize', false, false), 'missing_tool_use')
  // 有方案卡 / 有工具调用 → 合法
  assert.equal(core.vaultWriteFlowRetryReason(searchedOnly, 'organize', true, false), undefined)
  assert.equal(core.vaultWriteFlowRetryReason(searchedOnly, 'organize', false, true), undefined)
  // 只读意图不受写入流程约束
  assert.equal(core.vaultWriteFlowRetryReason(searchedOnly, 'answer', false, false), undefined)
  console.log('  ✓ 2. 搜到目标不读原文不能收尾；三种合法终态放行')
}

// ── 3. intent 单向升级 + 拒绝写入护栏（手册场景 7）──
{
  const q = '小B有几次咨询，帮我补进她的客户档案'
  assert.equal(core.upgradeVaultIntent('auto', { question: q, sawPlan: true, pendingTask: null }), 'organize')
  assert.equal(core.upgradeVaultIntent('organize', { question: '随便聊聊', sawPlan: false, pendingTask: null }), 'organize')
  // 用户明确只读：即使模型越权产出方案也不升级
  assert.equal(
    core.upgradeVaultIntent('auto', { question: '只总结小B最近两次咨询，不要改任何文件', sawPlan: true, pendingTask: null }),
    'auto',
  )
  // 承接 organize 旧任务 → 升级
  assert.equal(
    core.upgradeVaultIntent('auto', { question: '对', sawPlan: false, pendingTask: newTask() }),
    'organize',
  )
  console.log('  ✓ 3. intent 单向升级；「不要修改」永不升级')
}

// ── 4. 短确认承接 vs 新话题（手册场景 3/9）──
{
  for (const text of ['对', '继续', '嗯嗯', '好的', '就这样吧', '对，继续', 'ok', '确认']) {
    assert.equal(core.isVaultTaskContinuation(text), true, `应视为承接：${text}`)
  }
  for (const text of ['帮我想三个课程标题', '另外帮我看下上周的直播数据', '小C的档案在哪里']) {
    assert.equal(core.isVaultTaskContinuation(text), false, `不应视为承接：${text}`)
  }
  console.log('  ✓ 4. 「对/继续」承接旧任务；新话题不硬塞旧目标')
}

// ── 5. 删除工具结果豁免：有搜索结果仍拦「已写入」谎报（手册场景 5/6 文字层）──
{
  assert.equal(
    core.vaultAutoAnswerRetryReason('我已经帮你写入到小B的客户档案了。', true),
    'missing_tool_use',
  )
  // 有工具结果时的正常回答不误伤
  assert.equal(
    core.vaultAutoAnswerRetryReason('根据档案记录，小B一共有 2 次咨询。', true),
    undefined,
  )
  // 无工具结果时的旧护栏仍在
  assert.equal(
    core.vaultAutoAnswerRetryReason('我已经搜索了你的 Vault，没有发现相关文件。', false),
    'missing_tool_use',
  )
  console.log('  ✓ 5. 工具结果不再买断豁免；谎称已写入必拦')
}

// ── 6. 云端工具轮标记 ──
{
  assert.equal(core.isCloudToolsTurnRequest('<<<CLOUD_TOOLS_TURN>>>'), true)
  assert.equal(core.isCloudToolsTurnRequest('  <<<CLOUD_TOOLS_TURN>>>\n'), true)
  assert.equal(core.isCloudToolsTurnRequest('好的，我来记录。\n<<<CLOUD_TOOLS_TURN>>>'), true)
  // 混在长答复里视为普通文本，防止两头下注
  assert.equal(
    core.isCloudToolsTurnRequest(`${'这里是一段很长的正式回答。'.repeat(20)}<<<CLOUD_TOOLS_TURN>>>`),
    false,
  )
  assert.equal(core.isCloudToolsTurnRequest('普通回答没有标记'), false)
  console.log('  ✓ 6. CLOUD_TOOLS_TURN 标记识别与防两头下注')
}

// ── 7. 任务过期 ──
{
  const task = newTask()
  assert.equal(core.isVaultTaskExpired(task, NOW + core.VAULT_TASK_MAX_AGE_MS - 1), false)
  assert.equal(core.isVaultTaskExpired(task, NOW + core.VAULT_TASK_MAX_AGE_MS + 1), true)
  console.log('  ✓ 7. 任务超时自动作废')
}

// ── 8. 收尾句宣告后续动作 = 未完成（真实 Luna E2E 中捕获的逃逸措辞）──
{
  // 2026-08-17 生产 Luna 实测原话：绕过所有旧正则，必须被句级判定拦下
  assert.equal(
    core.isTrailingActionAnnouncement(
      '小霖，我先确认了：小B一共做过 2 次咨询，分别是 2026-08-10 和 2026-08-15。我现在继续读取最近一次咨询的完整内容，再把可核实的要点整理成客户档案追加方案。',
    ),
    true,
  )
  assert.equal(
    core.vaultAnswerRetryReason('小B做过几次咨询？帮我补进她的客户档案', '我现在继续读取档案原文，然后生成追加方案。'),
    'deferred_answer',
  )
  // 完整答案不误伤
  assert.equal(
    core.isTrailingActionAnnouncement('小B一共做过 2 次咨询，分别是 8 月 10 日和 8 月 15 日。'),
    false,
  )
  // E2E 逃逸变体 #2（2026-08-17 实测）：「你」是接收者不是执行者，必须拦
  assert.equal(
    core.isTrailingActionAnnouncement(
      '我查到小B之前一共做过 2 次咨询。我先读取最近一次咨询逐字稿和她现有客户档案，整理完后给你一份追加内容预览，确认后再写入。',
    ),
    true,
  )
  // 面向用户的建议不误伤（「你」是执行者）
  assert.equal(
    core.isTrailingActionAnnouncement('建议你之后继续读取那两份逐字稿，效果更好。'),
    false,
  )
  // 条件式主动提议不误伤
  assert.equal(
    core.isTrailingActionAnnouncement('需要的话我可以继续帮你补充更多标题。'),
    false,
  )
  console.log('  ✓ 8. 收尾句宣告「我继续读取/整理」不能作为终态')
}

// ── 9. 阿正 No.153 案回归（工单第七节 08-18 追记）：续跑轮失忆 + 零工具口头收尾 ──
{
  // 首问与精确指令都必须被判定为整理类措辞（mutationAsk）
  assert.equal(
    core.detectVaultAgentIntent('你能基于我RAW里的资料，帮我整理成MD文档，放到wiki文件夹吗'),
    'organize',
  )
  assert.equal(
    core.detectVaultAgentIntent(
      '那你现在就把 01_Raw/销售逐字稿 里的小A那份逐字稿读完，整理成一份客户档案 MD，新建到 02_Wiki/客户档案 文件夹',
    ),
    'organize',
  )
  // 0.7.48 追加（Alina 08-18 深夜截图实测的第三批逃逸句式）：
  // 「给我」前缀与「处理 + 文件对象」此前不在识别词表 → mutationAsk 判 false →
  // 全程宽松校验 → 连续四轮承诺句。两句原话钉进回归。
  assert.equal(
    core.detectVaultAgentIntent('现在给我按照分类处理raw文件夹里的文件，然后整理到wiki对应的文件夹里'),
    'organize',
  )
  assert.equal(
    core.detectVaultAgentIntent('你现在处理一下我的 RAW 文件夹的文件，把它们放到 wiki 文件夹里去'),
    'organize',
  )
  // 误伤防线：没有文件对象的「处理」、以及请教型疑问句，仍是普通对话
  assert.equal(core.detectVaultAgentIntent('帮我处理一下这个客户的异议'), 'answer')
  assert.equal(core.detectVaultAgentIntent('这种情况怎么处理比较好'), 'answer')
  assert.equal(core.detectVaultAgentIntent('逐字稿一般怎么处理比较好？'), 'answer')
  assert.equal(core.detectVaultAgentIntent('这些资料如何整理才对'), 'answer')
  // 「全部整理/继续」单看措辞不算 organize——必须靠承接机制补齐（这正是任务不能被清空的原因）
  assert.equal(core.detectVaultAgentIntent('全部整理'), 'answer')
  assert.equal(core.isVaultTaskContinuation('全部整理'), true)
  assert.equal(core.isVaultTaskContinuation('继续'), true)
  // 承接保留下来的 organize 任务 → intent 升级，服务端强制措辞可达
  assert.equal(
    core.upgradeVaultIntent('auto', {
      question: '全部整理',
      sawPlan: false,
      pendingTask: newTask({ stage: 'searched', candidatePaths: ['01_Raw/小A逐字稿.md'] }),
    }),
    'organize',
  )
  // 升级后，续跑轮的空承诺（含残破协议块乱码尾巴）按阶段判定拦截，与措辞无关
  assert.equal(
    core.vaultWriteFlowRetryReason(
      newTask({ stage: 'searched', candidatePaths: ['01_Raw/小A逐字稿.md'] }),
      'organize',
      false,
      false,
    ),
    'stalled_write_flow',
  )
  // 源码契约：main.ts 的三处修复不得回退
  const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(
    mainSource,
    /const mutationAsk = detectVaultAgentIntent\(input\.question\) === 'organize'/,
    '整理类措辞判定（mutationAsk）被移除',
  )
  assert.match(
    mainSource,
    /intent === 'organize' \|\| mutationAsk \? 'organize' : 'answer'/,
    '任务创建必须把整理类措辞记为 organize，否则续跑承接永远不触发',
  )
  assert.match(
    mainSource,
    /Boolean\(plan\.plan\) \|\| mutationAsk/,
    '整理类措辞的零工具零方案口头收尾豁免被恢复（阿正案第 4 轮逃逸点）',
  )
  assert.match(
    mainSource,
    /this\.pendingVaultTask\.intent === 'organize' &&[\s\S]{0,40}this\.pendingVaultTask\.stage !== 'previewed'/,
    '整理任务在合法反问收尾后必须保留（清空=续跑轮失忆）',
  )
  console.log('  ✓ 9. 阿正案回归：整理措辞任务保留可承接，零工具口头收尾被拦')
}

// ── 10. P3/阶段B（0.7.49）：原生工具通道源码契约 ──
{
  const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(
    mainSource,
    /nativeEligible[\s\S]{0,400}mutationAsk \|\| \(taskContinuation && this\.pendingVaultTask\?\.intent === 'organize'\)/,
    '原生通道只接管整理类回合的 gating 被改动',
  )
  assert.match(
    mainSource,
    /\/api\/plugin\/v1\/vault-native\/step/,
    '原生通道端点调用缺失',
  )
  assert.match(
    mainSource,
    /catch \{[\s\S]{0,200}pendingNativeText = null/,
    '原生通道失败必须静默回退散文协议（回滚保险丝）',
  )
  assert.match(
    mainSource,
    /name !== 'vault_search' && name !== 'list_folder' && name !== 'read_note'/,
    '原生工具名白名单校验被移除',
  )
  assert.match(
    mainSource,
    /propose_organize_plan/,
    '方案提交工具的客户端处理缺失（Luna 会声称缺少整理能力）',
  )
  console.log('  ✓ 10. 原生通道：整理回合 gating + 端点 + 白名单 + 方案工具 + 回退保险丝')
}

console.log('[test-vault-task-state] 全部通过')

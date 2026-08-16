// 阶段 A（2026-08-17）跨轮任务状态机回归：对应交接手册 §10 的可脚本化场景。
// 状态推进只认本机真实工具事件，不认模型措辞——这是修复「回答了但没干活」的核心。
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

console.log('[test-vault-task-state] 全部通过')

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
  const synthesisReady = newTask({
    stage: 'source_read',
    sourcePaths: [{ path: '01_Raw/小B咨询1.md', mtime: 1, size: 100 }],
  })
  assert.equal(
    core.vaultWriteFlowRetryReason(synthesisReady, 'organize', false, false),
    'deferred_answer',
    '已读来源、尚无现有目标时应继续批读或新建，不得反复要求读不存在的目标原文',
  )
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
  assert.equal(
    core.isTrailingActionAnnouncement('仓库结构已经核对完了。我继续读取现有看板，a moment.'),
    true,
  )
  assert.equal(
    core.isTrailingActionAnnouncement("I'll continue checking the Vault structure now."),
    true,
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
  // 0.7.52 第四批逃逸句式（重命名类，词表兜底；主判断已交给模型标记）
  assert.equal(
    core.detectVaultAgentIntent('把客户档案的名字前面加上咨询日期，比如20260813姓名还有客户职业，方便我快速查看文件'),
    'organize',
  )
  assert.equal(core.detectVaultAgentIntent('给所有文件统一加上日期前缀'), 'organize')
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
    /const nativeAvailable[\s\S]{0,320}const nativeFastPath = nativeAvailable[\s\S]{0,180}mutationAsk[\s\S]{0,120}taskContinuation/,
    '原生通道的模型自主切换与本地快路径没有正确拆分',
  )
  assert.match(
    mainSource,
    /\/api\/plugin\/v1\/vault-native\/step/,
    '原生通道端点调用缺失',
  )
  assert.match(
    mainSource,
    /catch \(error\) \{\s*if \(isAbortError\(error\)\) throw error[\s\S]{0,180}nativeChannelFailed = true\s*return null/,
    '用户停止必须向上传播；其他原生通道失败仍静默回退散文协议（回滚保险丝）',
  )
  assert.match(
    mainSource,
    /isVaultNativeTurnRequest\(lastText\)/,
    '0.7.52 模型自主切换标记分支缺失（词表漏网的最终解）',
  )
  assert.match(
    mainSource,
    /name !== 'vault_search'[\s\S]{0,120}name !== 'list_folder'[\s\S]{0,120}name !== 'vault_inventory'[\s\S]{0,120}name !== 'read_note'/,
    '原生工具名白名单校验被移除',
  )
  assert.match(
    mainSource,
    /propose_organize_plan/,
    '方案提交工具的客户端处理缺失（Luna 会声称缺少整理能力）',
  )
  assert.match(mainSource, /propose_artifact/, '通用成品工具的客户端处理缺失')
  assert.match(mainSource, /propose_dynamic_dashboard/, '动态工作台工具的客户端处理缺失')
  console.log('  ✓ 10. 原生通道：整理回合 gating + 端点 + 白名单 + 方案工具 + 回退保险丝')
}

console.log('[test-vault-task-state] 全部通过')

// ── 0.7.54 第11组：意图判定漏洞回归（全部为审计实跑复现的真实反例）──
console.log('第11组 否定句 / 只读误判 / 短消息劫持 / 空承诺（0.7.54）')
{
  // ① 否定句：动词与「不要/别」之间插入宾语，旧实现全部漏判成 organize
  const denied = [
    '不要帮我整理这些文件',
    '别把这些文件整理了',
    '不要把这些文件移动到 wiki',
    '别将这些笔记归档',
    '不要给我整理 raw 文件夹',
    '请不要把它们放到 wiki 文件夹里去',
    '别把它移入回收站',
    '不用帮我重命名这些档案',
  ]
  for (const text of denied) {
    assert.equal(core.detectVaultAgentIntent(text), 'answer', `否定句必须只读：${text}`)
    assert.equal(core.isVaultMutationExplicitlyDenied(text), true, `两套词表必须一致：${text}`)
  }
  // ② 正常整理请求不得被否定表误伤
  for (const text of ['把 raw 里的逐字稿整理到 wiki', '帮我给客户档案统一加上日期前缀']) {
    assert.equal(core.detectVaultAgentIntent(text), 'organize', `正常整理不得误伤：${text}`)
    assert.equal(core.isVaultMutationExplicitlyDenied(text), false, `正常整理不得判成只读：${text}`)
  }
  // ③「仅生成清单」是产出形态限定，不是拒绝写入（旧实现误判→撞满 12 轮烧积分）
  for (const text of [
    '把raw整理好，只要生成方案',
    '帮我整理逐字稿，只需要输出结果',
    '整理这批文件，仅生成一份清单',
  ]) {
    assert.equal(core.isVaultMutationExplicitlyDenied(text), false, `不得误判只读：${text}`)
  }
  // ④ 真正的只读请求仍要判出
  for (const text of ['只需要分析一下这些逐字稿', '仅搜索包含定位的笔记']) {
    assert.equal(core.isVaultMutationExplicitlyDenied(text), true, `真只读要判出：${text}`)
  }
  // ⑤ 短消息不得无条件劫持旧任务
  assert.equal(core.isVaultTaskContinuation('对'), true)
  assert.equal(core.isVaultTaskContinuation('继续'), true)
  assert.equal(core.isVaultTaskContinuation('可以了'), true)
  assert.equal(core.isVaultTaskContinuation('写一篇文章'), false)
  assert.equal(core.isVaultTaskContinuation('删掉这个文件'), false)
  assert.equal(core.isVaultTaskContinuation('今天天气怎样'), false)
  // ⑥ 空承诺豁免必须锚定，不能全句扫「需要/吗」
  assert.equal(core.isTrailingActionAnnouncement('我接下来会继续读取剩下的档案。'), true)
  assert.equal(core.isTrailingActionAnnouncement('我现在需要继续读取剩下的档案。'), true)
  assert.equal(core.isTrailingActionAnnouncement('我接下来继续读取剩下的档案吗。'), true)
  assert.equal(core.isTrailingActionAnnouncement('需要我继续读取剩下的档案吗？'), false)
  assert.equal(core.isTrailingActionAnnouncement('如果需要我可以继续核对其他档案。'), false)
  assert.equal(core.isTrailingActionAnnouncement('建议你继续读一下这两份逐字稿。'), false)
}

// ── 0.7.54 第12组：0.7.52 标记入口的行为测试（此前只有源码 grep）──
console.log('第12组 VAULT_NATIVE_TURN 标记行为（0.7.54 补齐）')
{
  assert.equal(core.VAULT_NATIVE_TURN_MARKER, '<<<VAULT_NATIVE_TURN>>>')
  assert.equal(core.isVaultNativeTurnRequest('<<<VAULT_NATIVE_TURN>>>'), true)
  assert.equal(core.isVaultNativeTurnRequest('  <<<VAULT_NATIVE_TURN>>>\n'), true)
  assert.equal(core.isVaultNativeTurnRequest('好的，我来处理。\n<<<VAULT_NATIVE_TURN>>>'), true)
  // 混在长答复里视为普通文本，防模型两头下注（既答又标记）
  assert.equal(
    core.isVaultNativeTurnRequest(`${'详细解释'.repeat(40)}\n<<<VAULT_NATIVE_TURN>>>`),
    false,
  )
  assert.equal(core.isVaultNativeTurnRequest('我已经帮你整理好了'), false)

  // 联网是安全边界，不靠模型是否恰好遵守“只输出标记”。明确要求最新外部证据
  // 必须直接进入能申请 OpenAI Web Search 的原生通道；普通内容/PPT 不应被误伤。
  assert.equal(
    core.requiresWebSearchNativeRouting('请做一份2026内容增长趋势PPT，加入最新公开数据、真实案例和来源'),
    true,
  )
  assert.equal(core.requiresWebSearchNativeRouting('请做一份3页内容增长PPT，不要联网'), false)
  assert.equal(core.requiresWebSearchNativeRouting('用现有内容讲讲增长趋势'), false)

  // 即使服务端违规把内部标记混在长答复里，也不能泄露到用户界面。
  assert.equal(
    core.stripVaultInternalTurnMarkers('我先说明检索范围。\n<<<VAULT_NATIVE_TURN>>>'),
    '我先说明检索范围。',
  )
  assert.equal(
    core.stripVaultInternalTurnMarkers('准备写入 CRM。\n<<<CLOUD_TOOLS_TURN>>>'),
    '准备写入 CRM。',
  )
}

// ── 0.7.66 第13组：空承诺形态整段扫描（柚柠客户档案案，2026-08-20 学员实测）──
// 学员连发同一句请求，四轮拿到的都是「我先读完再生成」的承诺，一个文件都没动。
// 空承诺的真实形态=「承诺在前 + 安抚收尾」，只看收尾句必然整类漏判：短回答改
// 整篇逐句扫描，长回答仍只看收尾句（正文里「我现在整理如下」是真交付开场白）。
// 注：意图路由不再走客户端词表扩表（0.7.30 纪律：词表不得成为能力路由）——
// 「生成一份客户档案」的进引擎判断由服务端 round-0 指令交 Luna 完成。
console.log('第13组 空承诺整段扫描（0.7.66）')
{
  const question = '帮我根据raw文件夹里面柚柠的资料，在wiki里面生成一份柚柠的客户档案'

  // 四条真实截图原文必须全部被判为空承诺并强制重做。
  const stalls = [
    '江老师，我继续把柚柠这份逐字稿完整读完，再提炼客户档案。现在已有的片段能确认：对方正在读学前教育——但还不够支撑完整建档，我先把全文读完。',
    '我继续处理柚柠这份材料，先把唯一一份逐字稿完整读完，再生成客户档案预览。信息不足的字段会写"待补充"，确认后才写入 Wiki。',
    '我按确认内容执行：先核对柚柠对应的原始材料和 Wiki 里的真实目录，再完整读取材料，最后生成一份待确认写入方案。不会覆盖已有文件；只有你在插件里再次确认后，才会写入。',
    '我先核对 RAW 里柚柠的真实材料，以及 Wiki 里对应文件夹的现状；确认无误后，按你已经确认的内容生成一份客户档案写入方案。插件二次确认后才会写入。',
    // 小A案（2026-08-20 Alina 真机复现）的两条收尾也必须拦住
    '我继续处理小A这份资料。先把逐字稿剩余部分读完，并核实 Wiki 里是否已有小A档案，避免覆盖或重复创建。',
    '继续。逐字稿还剩一段需要读完，同时我核实一下 Wiki 里是否已经有小A档案；确认无重复后，我再给你一份完整的待确认档案方案。',
  ]
  for (const stall of stalls) {
    assert.equal(core.isTrailingActionAnnouncement(stall), true, stall.slice(0, 20))
    assert.equal(core.vaultAnswerRetryReason(question, stall), 'deferred_answer', stall.slice(0, 20))
  }
  // 长答复正文里的「我现在整理如下」是真交付的开场白，仍然只看收尾句，不得误伤。
  const delivered = `我现在把读到的内容整理成下面这份档案。${'字段内容'.repeat(80)}\n以上就是完整档案。`
  assert.equal(core.isTrailingActionAnnouncement(delivered), false)
  // 原有豁免不能被整篇扫描破坏
  assert.equal(core.isTrailingActionAnnouncement('如果需要我可以继续核对其他档案。'), false)
  assert.equal(core.isTrailingActionAnnouncement('建议你继续读一下这两份逐字稿。'), false)
  assert.equal(core.isTrailingActionAnnouncement('需要我继续读取剩下的档案吗？'), false)
  assert.equal(core.isTrailingActionAnnouncement('我刚才已经读完了逐字稿，结论是她的核心痛点在定价。'), false)
  assert.equal(core.isTrailingActionAnnouncement('可以，我们先讨论客户档案模板应该包含哪些字段。'), false)

  // 意图词表保持 0.7.65 原状：不因本批扩表（能力路由归 Luna + 服务端指令）。
  assert.equal(core.detectVaultAgentIntent('先不要写入任何文件，只读取并生成草稿'), 'answer')
  assert.equal(core.detectVaultAgentIntent('帮我生成一份周报'), 'answer')
  // 熔断代搜已按 Codex 复核移除：纯聊天默认带 Vault 权限，误判两轮会导致
  // 插件未经模型请求预扫 Vault，违反市场审核承诺的边界。
  assert.equal(typeof core.extractVaultRescueQueries, 'undefined')
}

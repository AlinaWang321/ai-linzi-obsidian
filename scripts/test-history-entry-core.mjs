// 历史弹窗行信息的行为测试（0.7.71）：真跑逻辑，不是在源码里找字符串。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/history-entry-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const {
  deriveConversationTitle,
  historyEntryFacts,
  relativeTime,
  truncateTitle,
  CONVERSATION_TITLE_MAX,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

console.log('第1组 条数只算正文往返，过程记录不计入')
{
  const msgs = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'assistant', localSkillStatus: true }, // 活动流也是 assistant，但属过程记录
    { role: 'user' },
  ]
  const facts = historyEntryFacts(msgs)
  // 4 条消息里有 1 条是活动流 → 正文往返 3 条。
  // 若把过程记录也算进去，一次简单提问会被显示成十几条。
  assert.equal(facts.messageCount, 3, '活动流/技能进度条不得计入正文条数')
  assert.equal(facts.ranVaultPlan, false)
  assert.equal(facts.madeImages, false)
}

console.log('第1.5组 只有过程记录、没有正文往返 → 返回 null')
{
  assert.equal(
    historyEntryFacts([{ role: 'assistant', localSkillStatus: true }]),
    null,
    '只剩过程记录时没有可展示的条数，不显示比显示 0 条诚实',
  )
}

console.log('第2组 执行过整理方案 / 生成过图片')
{
  assert.equal(historyEntryFacts([{ role: 'assistant', vaultActionId: 'act-1' }]).ranVaultPlan, true)
  assert.equal(historyEntryFacts([{ role: 'assistant', aiImageResult: {} }]).madeImages, true)
  assert.equal(historyEntryFacts([{ role: 'assistant', imageResult: {} }]).madeImages, true)
  // 只是提到「移动文件」但没真执行 → 不能打标
  assert.equal(
    historyEntryFacts([{ role: 'assistant' }, { role: 'user' }]).ranVaultPlan,
    false,
    '没有 vaultActionId 就是没执行过整理方案，不许凭正文猜',
  )
  // 口径边界：vaultActionId 只由 applyVaultPlan 写入。新建笔记等写入动作不写它，
  // 因此这个标记只能声称「执行过整理方案」，不能泛化成「动过文件」。
  // 需要覆盖全部写入动作要另建统一追踪，属独立车次。
}

console.log('第3组 没有本机副本时返回 null（云端对话不显示假数据）')
{
  assert.equal(historyEntryFacts(undefined), null)
  assert.equal(historyEntryFacts([]), null)
  assert.equal(historyEntryFacts([{ role: 'system' }]), null, '没有正文往返就没有可展示的条数')
}

console.log('第4组 相对时间档位')
{
  const now = 1_700_000_000_000
  const m = 60_000, h = 60 * m, d = 24 * h
  assert.equal(relativeTime(now - 10_000, now), '刚刚')
  assert.equal(relativeTime(now - 59_000, now), '刚刚')
  assert.equal(relativeTime(now - m, now), '1 分钟前')
  assert.equal(relativeTime(now - 59 * m, now), '59 分钟前')
  assert.equal(relativeTime(now - h, now), '1 小时前')
  assert.equal(relativeTime(now - 23 * h, now), '23 小时前')
  assert.equal(relativeTime(now - d, now), '1 天前')
  assert.equal(relativeTime(now - 29 * d, now), '29 天前')
  assert.match(relativeTime(now - 40 * d, now), /\d+\/\d+/, '超过 30 天回到绝对日期')
  assert.equal(relativeTime(0, now), '时间未知')
  assert.equal(relativeTime(Number.NaN, now), '时间未知')
  // 跨设备同步 / 时钟漂移会真的产生「未来时间」，不能显示成负数
  assert.equal(relativeTime(now + 5 * m, now), '刚刚', '未来时间不得渲染成负数分钟')
}

console.log('第5组 标题截断')
{
  assert.equal(truncateTitle('短标题'), '短标题')
  assert.equal(truncateTitle(''), '未命名对话')
  assert.equal(truncateTitle('   '), '未命名对话')
  const long = '从 Skill Studio 安装「consultation-client-workflow」这个很长很长的技能包'
  const cut = truncateTitle(long, 20)
  assert.equal(Array.from(cut).length, 20)
  assert.ok(cut.endsWith('…'), '截断必须补省略号，不能生切')
  assert.equal(truncateTitle('正好十个字的标题abc', 12), '正好十个字的标题abc')
  // emoji / 代理对不得被切成半个字符
  const emoji = truncateTitle('✍️🎯🚀🌟💡🔥📌🎨🧩⚡🍀', 5)
  assert.equal(Array.from(emoji).length, 5)
  assert.ok(!emoji.includes('�'), '不得产生替换字符')
}

console.log('第6组 标题统一推导（0.7.71 收尾修：保存前就被 slice(0,24) 生切）')
{
  const u = (text) => ({ role: 'user', parts: [{ text }] })
  const a = (text) => ({ role: 'assistant', parts: [{ text }] })

  // 真实报障标题：过去存进历史时被 slice(0, 24) 硬切成
  // 「从 Skill Studio 安装「consul」——没有省略号，也无法在渲染层补救。
  const real = '从 Skill Studio 安装「consultation-client-workflow」'
  const title = deriveConversationTitle([u(real), a('好的')])
  assert.ok(title.endsWith('…'), `真实长标题必须补省略号，实际：${title}`)
  assert.equal(Array.from(title).length, CONVERSATION_TITLE_MAX)
  assert.ok(
    title.startsWith('从 Skill Studio 安装「consultation'),
    `40 码点应当比旧的 24 码点显示更多内容，实际：${title}`,
  )
  assert.ok(
    Array.from(real).length > 24,
    '前提校验：这条标题确实超过旧上限，否则本用例证明不了什么',
  )

  // 短标题不动，不许平白加省略号
  assert.equal(deriveConversationTitle([u('总结当前笔记')]), '总结当前笔记')

  // 从「第一条用户正文」推导：助手先说话、或前面有空消息都不影响
  assert.equal(deriveConversationTitle([a('我先说'), u('真正的问题')]), '真正的问题')
  assert.equal(deriveConversationTitle([u('   '), u('第二条才有内容')]), '第二条才有内容')
  assert.equal(deriveConversationTitle([u(''), u('非空')]), '非空')

  // 多行提问只取第一段有内容的行：后续行是细节，塞进标题更难认
  assert.equal(deriveConversationTitle([u('帮我看看这个\n\n背景是这样的：……')]), '帮我看看这个')
  assert.equal(deriveConversationTitle([u('\n\n  换行开头的问题')]), '换行开头的问题')

  // 过程记录不参与推导
  assert.equal(
    deriveConversationTitle([{ role: 'user', localSkillStatus: true, parts: [{ text: '状态条' }] }, u('真正的问题')]),
    '真正的问题',
  )

  // 没有可用正文时用 fallback，且各调用点的 fallback 各自独立
  assert.equal(deriveConversationTitle([], { fallback: '云端对话' }), '云端对话')
  assert.equal(deriveConversationTitle(undefined, { fallback: '对话' }), '对话')
  assert.equal(deriveConversationTitle([a('只有助手说话')], { fallback: '对话' }), '对话')
  assert.equal(deriveConversationTitle([]), '未命名对话', '未传 fallback 时的默认值')

  // parts 缺失 / 片段畸形不得抛异常
  assert.equal(deriveConversationTitle([{ role: 'user' }], { fallback: 'X' }), 'X')
  assert.equal(deriveConversationTitle([{ role: 'user', parts: [{}] }], { fallback: 'X' }), 'X')

  // emoji 标题按码点切，不产生半个字符
  const emoji = deriveConversationTitle([u('🎯'.repeat(60))])
  assert.equal(Array.from(emoji).length, CONVERSATION_TITLE_MAX)
  assert.ok(!emoji.includes('\uFFFD'), '不得产生替换字符')
}

console.log('history entry core behavior tests: ok')

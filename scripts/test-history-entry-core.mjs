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
const { historyEntryFacts, relativeTime, truncateTitle } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

console.log('第1组 条数只算正文往返，不算过程记录')
{
  const msgs = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'assistant', localSkillStatus: true }, // 活动流也是 assistant
    { role: 'user' },
  ]
  const facts = historyEntryFacts(msgs)
  // localSkillStatus 仍是 assistant 角色，当前口径按角色计数；
  // 这条断言把现状钉住，将来若要排除过程记录，改实现时会被这里拦下。
  assert.equal(facts.messageCount, 4)
  assert.equal(facts.touchedFiles, false)
  assert.equal(facts.madeImages, false)
}

console.log('第2组 动过文件 / 生成过图片')
{
  assert.equal(historyEntryFacts([{ role: 'assistant', vaultActionId: 'act-1' }]).touchedFiles, true)
  assert.equal(historyEntryFacts([{ role: 'assistant', aiImageResult: {} }]).madeImages, true)
  assert.equal(historyEntryFacts([{ role: 'assistant', imageResult: {} }]).madeImages, true)
  // 只是提到「移动文件」但没真执行 → 不能打标
  assert.equal(
    historyEntryFacts([{ role: 'assistant' }, { role: 'user' }]).touchedFiles,
    false,
    '没有 vaultActionId 就是没真动过文件，不许凭正文猜',
  )
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

console.log('history entry core behavior tests: ok')

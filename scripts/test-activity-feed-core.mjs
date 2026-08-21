// 活动流行为测试（0.7.55）：真的跑一遍逻辑，断言每一帧渲染内容。
//
// 为什么要有这个文件：0.7.53 上线活动流时，33 条断言全是「在 main.ts 里找字符串」，
// 结果 0.7.54 真的在这里引入了缺陷（纯问答回合留下「✅ 0 步」空卡）而测试全绿。
// 源码 grep 只能证明"代码还在"，证明不了"行为还对"。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/activity-feed-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const {
  ActivityFeed,
  activityFeedText,
  activityEndHeader,
  escapeActivityLine,
  parseFinishedActivityFeed,
  ACTIVITY_FEED_VISIBLE_LINES,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

/** 假宿主：记录每一次渲染，模拟「首帧产生 id、之后原地更新」。 */
function makeHost() {
  const frames = []
  let clock = 1_000_000
  let seq = 0
  return {
    frames,
    tick: (ms) => { clock += ms },
    host: {
      render: (text, id, thinking) => {
        const nextId = id ?? `msg-${++seq}`
        frames.push({ id: nextId, thinking, text, replaced: Boolean(id) })
        return nextId
      },
      now: () => clock,
    },
  }
}

console.log('第1组 纯问答回合：零打扰（不变量1+4）')
{
  const { frames, host } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('理解你的要求…')
  assert.equal(frames.length, 0, 'begin 绝不渲染')
  assert.equal(feed.active, true)
  feed.end('ok')
  assert.equal(frames.length, 0, '从未落卡的回合必须整条丢弃，不留「✅ 0 步」空卡')
  assert.equal(feed.active, false)
}

console.log('第2组 只有轮次提示、没有真实动作：仍然零打扰（不变量2）')
{
  const { frames, host } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('理解你的要求…')
  feed.setCurrent('文件操作引擎启动…')
  feed.setCurrent('第 2/12 步 · 继续执行…')
  assert.equal(frames.length, 0, '非动作提示不得单独把卡片带出来（0.7.54 空卡缺陷的根因）')
  feed.end('ok')
  assert.equal(frames.length, 0)
}

console.log('第3组 有真实动作：逐帧滚动 + 定格')
{
  const { frames, host, tick } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('理解你的要求…')
  feed.step('🔍 搜索「客户档案」→ 8 个相关文件', '第 2/12 步 · 继续执行…')
  assert.equal(frames.length, 1, '第一条真实动作必须落卡')
  assert.equal(frames[0].thinking, true, '进行中的帧必须标记 thinking')
  assert.equal(frames[0].replaced, false, '首帧是新建')
  assert.match(frames[0].text, /^⚙️ AI霖子工作台\n/, '进行中用 ⚙️ 头（渲染层据此加动效）')
  assert.match(frames[0].text, /- 🔍 搜索/)
  assert.match(frames[0].text, /- ⏳ 第 2\/12 步/, '进行中提示单独一行、带 ⏳')

  feed.step('📄 读取 小B.md')
  assert.equal(frames.length, 2)
  assert.equal(frames[1].replaced, true, '后续帧必须原地更新同一条消息')
  assert.equal(frames[1].id, frames[0].id)

  feed.step('📋 已生成整理方案，等待你确认', null)
  assert.doesNotMatch(frames[2].text, /⏳/, 'current 传 null 后不再显示进行中提示')

  tick(15_000)
  feed.end('ok')
  const last = frames.at(-1)
  assert.equal(last.thinking, false, '定格帧不能再标 thinking（否则动效不停）')
  assert.equal(last.id, frames[0].id, '定格必须替换同一条消息，不新增')
  assert.match(last.text, /^✅ AI霖子工作台（3 步 · 15 秒）/, '定格头含步数与耗时')
  assert.match(last.text, /- 🔍 搜索/)
  assert.match(last.text, /- 📄 读取/)
  assert.match(last.text, /- 📋 已生成整理方案/)
}

console.log('第4组 重复动作只记一次（不变量3）')
{
  const { frames, host } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('start')
  feed.step('📋 已生成整理方案，等待你确认')
  feed.step('📋 已生成整理方案，等待你确认') // 原生 propose + 共用预检会各报一次
  feed.end('ok')
  const lines = frames.at(-1).text.split('\n').filter((line) => line.startsWith('- 📋'))
  assert.equal(lines.length, 1, '连续相同动作只保留一条')
  assert.match(frames.at(-1).text, /（1 步 ·/, '步数也只算一次')
  // 不相邻的相同动作应当各自保留（两轮之间确实各生成过一次方案）
  const second = makeHost()
  const feed2 = new ActivityFeed(second.host)
  feed2.begin('start')
  feed2.step('📋 方案')
  feed2.step('🧭 方案未过本机检查，要求重新核对生成')
  feed2.step('📋 方案')
  feed2.end('ok')
  assert.match(second.frames.at(-1).text, /（3 步 ·/, '被打断后的相同动作要各自保留')
}

console.log('第5组 长任务折叠')
{
  const { frames, host } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('start')
  for (let i = 1; i <= 20; i++) feed.step(`步骤 ${i}`)
  feed.end('ok')
  const text = frames.at(-1).text
  assert.match(text, /- …（前 8 步已折叠）/, `超过 ${ACTIVITY_FEED_VISIBLE_LINES} 行要折叠并说明折叠数`)
  assert.ok(!text.includes('- 步骤 8\n'), '被折叠的行不再逐条显示')
  assert.match(text, /- 步骤 20/, '最新的动作必须可见')
  assert.match(text, /（20 步 ·/, '折叠不影响总步数统计')
}

console.log('第6组 失败定格与耗时下限')
{
  const { frames, host, tick } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('start')
  feed.step('📄 读取 小B.md')
  tick(400) // 不足 1 秒
  feed.end('error', 'AI 没有实际调用 Vault 工具，已停止这次任务；请重试')
  const text = frames.at(-1).text
  assert.match(text, /^⚠️ AI霖子工作台已停止：AI 没有实际调用 Vault 工具/, '失败要定格原因')
  assert.match(text, /- 📄 读取/, '失败时已完成的动作仍要留在记录里')
  const okRun = makeHost()
  const feed2 = new ActivityFeed(okRun.host)
  feed2.begin('start')
  feed2.step('x')
  okRun.tick(200)
  feed2.end('ok')
  assert.match(okRun.frames.at(-1).text, /· 1 秒/, '不足 1 秒按 1 秒显示，不出现 0 秒')
}

console.log('第7组 Markdown 转义（真实路径不被吃成斜体）')
{
  assert.equal(escapeActivityLine('📁 查看 02_Wiki/03_客户档案'), '📁 查看 02\\_Wiki/03\\_客户档案')
  assert.equal(escapeActivityLine('a*b~c`d[e]'), 'a\\*b\\~c\\`d\\[e\\]')
  const text = activityFeedText({ lines: ['📁 查看 02_Wiki'], current: '读取 a_b.md' }, '⚙️ 头')
  assert.match(text, /02\\_Wiki/)
  assert.match(text, /a\\_b\.md/, '进行中提示同样要转义')
}

console.log('第8组 生命周期边界：begin 之前/end 之后的调用必须安全无副作用')
{
  const { frames, host } = makeHost()
  const feed = new ActivityFeed(host)
  feed.step('不该出现')
  feed.setCurrent('不该出现')
  feed.end('ok')
  assert.equal(frames.length, 0, '没有 begin 时一切调用都是空操作')
  feed.begin('start')
  feed.step('真实动作')
  feed.end('ok')
  const after = frames.length
  feed.step('结束后又来一条')
  feed.end('ok')
  assert.equal(frames.length, after, 'end 之后的调用不得再渲染')
}

console.log('第9组 完成态折叠解析（0.7.71）：真跑解析，不是在源码里找字符串')
{
  // 折叠只发生在渲染层：解析的输入就是 ActivityFeed 真正产出的完成态文本，
  // 因此这里先用真实控制器跑一轮，再把它渲染出的最后一帧喂给解析器。
  const { frames, host, tick } = makeHost()
  const feed = new ActivityFeed(host)
  feed.begin('开始')
  feed.step('🔍 搜索「客户档案」→ 3 个相关文件')
  feed.step('📄 读取 客户甲.md')
  feed.step('📁 查看 02_Wiki')
  tick(8000)
  feed.end('ok')
  const finalText = frames[frames.length - 1].text
  const parsed = parseFinishedActivityFeed(finalText)
  assert.ok(parsed, '完成态必须能被解析出来')
  assert.match(parsed.header, /^✅ AI霖子工作台（3 步 · \d+ 秒）$/)
  assert.equal(parsed.lines.length, 3, '三步动作一条都不能在折叠中丢失')
  assert.equal(parsed.lines[1], '📄 读取 客户甲.md')
  assert.match(parsed.lines[2], /02\\_Wiki/, '转义后的原文原样保留，展开后可审计')

  // 进行中的帧绝不折叠：工作中必须保持展开与动效。
  const workingFrame = frames.find((f) => f.text.startsWith('⚙️'))
  assert.ok(workingFrame, '应当存在进行中的帧')
  assert.equal(parseFinishedActivityFeed(workingFrame.text), null, '⚙️ 进行中不得被折叠')

  // 失败态同样要能折叠，且摘要里保留失败原因。
  const err = makeHost()
  const errFeed = new ActivityFeed(err.host)
  errFeed.begin('开始')
  errFeed.step('📄 读取 a.md')
  errFeed.end('error', '网络中断')
  const errParsed = parseFinishedActivityFeed(err.frames.at(-1).text)
  assert.ok(errParsed, '失败态也要可折叠')
  assert.match(errParsed.header, /^⚠️ AI霖子工作台已停止：网络中断$/)
  assert.equal(errParsed.lines.length, 1)

  // 非活动流的消息一律原样渲染，不能被误折叠。
  assert.equal(parseFinishedActivityFeed('普通的一条 AI 回复'), null)
  assert.equal(parseFinishedActivityFeed('⚠️ 出错了'), null, '普通报错不是活动流')
  assert.equal(
    parseFinishedActivityFeed(activityEndHeader({ lines: [] }, 'ok', 3)),
    null,
    '零明细不得渲染成点不开的空折叠',
  )
}

console.log('activity feed core behavior tests: ok')

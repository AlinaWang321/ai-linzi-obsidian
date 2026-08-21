/**
 * 对话内活动流的纯逻辑核心（0.7.55 从 main.ts 抽出）。
 *
 * 抽出的动机：0.7.53 上线时，活动流的 33 条测试全部是「读 main.ts 源码找字符串」，
 * 抓不到任何行为回归——而 0.7.54 真的在这里引入过一个缺陷（纯问答回合留下
 * 「✅ 0 步」空卡）。逻辑放进纯模块后可以真跑：喂一串事件，断言渲染出的每一帧。
 *
 * 这里不碰 DOM、不认识 Obsidian。渲染由调用方注入的 render 回调完成，
 * 回调返回消息 id（首次渲染才产生 id，用于后续原地更新）。
 */

export interface ActivityFeedState {
  /** 渲染后由宿主回传的消息 id；undefined 表示还从未落进对话区。 */
  id?: string
  lines: string[]
  current: string | null
  startedAt: number
}

export interface ActivityFeedHost {
  /** 渲染一帧并返回消息 id；thinking 表示这一帧仍在进行中。 */
  render: (text: string, id: string | undefined, thinking: boolean) => string
  now: () => number
}

export const ACTIVITY_FEED_VISIBLE_LINES = 12
export const ACTIVITY_FEED_WORKING_HEADER = '⚙️ AI霖子工作台'

/** 动作行里常有含 _ 的真实路径（02_Wiki），转义以免被 Markdown 吃成斜体。 */
export function escapeActivityLine(value: string): string {
  return value.replace(/([_*~`[\]])/g, '\\$1')
}

export function activityFeedText(
  feed: Pick<ActivityFeedState, 'lines' | 'current'>,
  header: string,
): string {
  const shown = feed.lines.slice(-ACTIVITY_FEED_VISIBLE_LINES)
  const hidden = feed.lines.length - shown.length
  const parts = [header]
  if (hidden > 0) parts.push(`- …（前 ${hidden} 步已折叠）`)
  for (const line of shown) parts.push(`- ${escapeActivityLine(line)}`)
  if (feed.current) parts.push(`- ⏳ ${escapeActivityLine(feed.current)}`)
  return parts.join('\n')
}

export function activityEndHeader(
  feed: Pick<ActivityFeedState, 'lines'>,
  outcome: 'ok' | 'error',
  seconds: number,
  summary?: string,
): string {
  return outcome === 'ok'
    ? `✅ AI霖子工作台（${feed.lines.length} 步 · ${seconds} 秒）`
    : `⚠️ AI霖子工作台已停止：${summary ?? '本次没有完成，请重试'}`
}

/**
 * 解析一条「已完成」的活动流消息（0.7.71 折叠用）。
 *
 * 只做展示层解析，不参与 ActivityFeed 的动作记录、去重与本机历史：消息正文
 * 仍然整条原样入库，折叠只发生在渲染时，用户展开后能看到全部步骤（可审计）。
 *
 * 返回 null 表示这条不是完成态活动流（进行中的 ⚙️ 帧、技能进度条、普通回复），
 * 调用方应按原样渲染。
 */
export function parseFinishedActivityFeed(
  text: string,
): { header: string; lines: string[] } | null {
  const raw = text.split('\n')
  const header = raw[0]?.trim() ?? ''
  const isFinished =
    header.startsWith('✅ AI霖子工作台') || header.startsWith('⚠️ AI霖子工作台已停止')
  if (!isFinished) return null
  const lines = raw
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
  // 没有明细就没有可折叠的东西，交回原样渲染，避免出现点不开的空折叠。
  if (lines.length === 0) return null
  return { header, lines }
}

/**
 * 活动流控制器。四条不变量（全部由 scripts/test-activity-feed-core.mjs 真跑验证）：
 * 1. begin 只登记不渲染 —— 纯问答回合绝不出现状态条；
 * 2. current 只在已落卡时重绘 —— 「轮次开始」这类非动作提示不得单独把卡片带出来；
 * 3. 与上一行完全相同的动作只记一次 —— 原生 propose 与共用预检会重复报「方案已生成」；
 * 4. end 时从未渲染过则整条丢弃 —— 不留「✅ 0 步」空卡。
 */
export class ActivityFeed {
  private state: ActivityFeedState | null = null

  constructor(private readonly host: ActivityFeedHost) {}

  get active(): boolean {
    return this.state !== null
  }

  /** 仅用于测试与诊断：当前帧快照。 */
  snapshot(): ActivityFeedState | null {
    return this.state ? { ...this.state, lines: [...this.state.lines] } : null
  }

  begin(current: string): void {
    this.state = { lines: [], current, startedAt: this.host.now() }
  }

  /** 追加一步已完成动作；current 传 null 清空进行中提示，undefined 保持不变。 */
  step(line: string, current?: string | null): void {
    const feed = this.state
    if (!feed) return
    if (feed.lines[feed.lines.length - 1] !== line) feed.lines.push(line)
    if (current !== undefined) feed.current = current
    this.render()
  }

  /** 更新进行中提示；只有已经落过卡时才重绘（不变量 2）。 */
  setCurrent(current: string): void {
    const feed = this.state
    if (!feed) return
    feed.current = current
    if (feed.id) this.render()
  }

  end(outcome: 'ok' | 'error', summary?: string): void {
    const feed = this.state
    this.state = null
    if (!feed?.id) return
    const seconds = Math.max(1, Math.round((this.host.now() - feed.startedAt) / 1000))
    feed.current = null
    this.host.render(activityFeedText(feed, activityEndHeader(feed, outcome, seconds, summary)), feed.id, false)
  }

  private render(): void {
    const feed = this.state
    if (!feed) return
    feed.id = this.host.render(activityFeedText(feed, ACTIVITY_FEED_WORKING_HEADER), feed.id, true)
  }
}

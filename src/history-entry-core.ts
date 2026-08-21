/**
 * 历史弹窗每一行的展示信息（0.7.71）。
 *
 * 抽成纯模块的理由同 activity-feed-core / slash-menu-core：相对时间的档位边界、
 * 标题截断的省略号、以及「这次对话执行过整理方案吗」的判定都有容易错的边界，
 * 放在 Modal 里只能靠源码 grep，证明不了行为。真跑测试见
 * scripts/test-history-entry-core.mjs。
 *
 * 这里不碰 DOM、不认识 Obsidian。
 */

/** 只取判定需要的字段，避免把整个 WireMessage 类型拖进来。 */
export interface HistoryMessageLike {
  role?: string
  /** 活动流与技能进度条也是 assistant 角色，靠这个标记与正文区分。 */
  localSkillStatus?: boolean
  /**
   * 确认执行整理方案后写入的执行日志 ID。
   *
   * ⚠️ 口径很窄：只有「Vault 整理方案」这一条路径会写它（applyVaultPlan）。
   * 新建笔记、新建文件夹、局部改写等写入动作**都不写** vaultActionId，
   * 所以它只能支撑「执行过整理方案」，不能当作泛化的「动过文件」。
   * 需要覆盖全部写入动作时要另建统一追踪，那是独立车次，不在 0.7.71 范围内。
   */
  vaultActionId?: string
  aiImageResult?: unknown
  imageResult?: unknown
  /** 正文片段；推导标题时用。 */
  parts?: { text?: string }[]
}

export interface HistoryEntryFacts {
  /** 用户与助手的正文往返条数，不含活动流与技能进度条。 */
  messageCount: number
  /** 这次对话确认执行过 Vault 整理方案。口径见 vaultActionId 的说明。 */
  ranVaultPlan: boolean
  /** 这次对话生成过图片。 */
  madeImages: boolean
}

/**
 * 从本机会话副本里读出可展示的事实。
 *
 * 只统计正文往返：活动流与技能进度条也是 assistant 角色，但它们是过程记录，
 * 算进「聊了多少条」会把一次简单提问显示成十几条。
 */
export function historyEntryFacts(
  messages: HistoryMessageLike[] | undefined,
): HistoryEntryFacts | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  let messageCount = 0
  let ranVaultPlan = false
  let madeImages = false
  for (const message of messages) {
    const role = message.role
    if ((role === 'user' || role === 'assistant') && !message.localSkillStatus) messageCount += 1
    if (message.vaultActionId) ranVaultPlan = true
    if (message.aiImageResult || message.imageResult) madeImages = true
  }
  if (messageCount === 0) return null
  return { messageCount, ranVaultPlan, madeImages }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 相对时间。绝对时间仍应放进 title 供悬停查看——相对时间方便扫，
 * 但要查「到底是哪天」时它没用。
 */
export function relativeTime(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '时间未知'
  const diff = now - updatedAt
  // 时钟漂移或跨设备同步会让「未来时间」真实出现，别显示成负数分钟。
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return new Date(updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 会话标题的统一长度上限（码点）。 */
export const CONVERSATION_TITLE_MAX = 40

/**
 * 标题截断：超长时补省略号。
 *
 * 按码点切，避免把 emoji 或代理对切成半个字符。
 * ⚠️ 只在**还持有完整原文**时调用才有意义——见 deriveConversationTitle 的说明。
 */
export function truncateTitle(title: string, max = CONVERSATION_TITLE_MAX): string {
  const value = (title ?? '').trim()
  if (!value) return '未命名对话'
  if (max <= 1) return value.slice(0, max)
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 从首条用户正文推导会话标题（0.7.71 收尾修）。
 *
 * **为什么必须统一到这一个函数**：此前有三处各自 `slice(0, 24)` 生成标题——
 * 本机保存（persistNow）、云端会话转换、访谈提示。三处都是**先切掉再存**，
 * 于是渲染层拿到的字符串里已经没有「它被截过」这个信息了，
 * 再怎么在渲染层补省略号都没用，用户看到的永远是生切的
 * 「从 Skill Studio 安装「consul」。
 *
 * 现在：保存 / 云端转换 / 展示全部走这里，截断与补省略号在同一处发生。
 * 展示侧还应优先用本机会话正文**重新推导**，这样 0.7.71 之前存下的旧标题
 * 也能恢复成带省略号的完整形态。
 */
export function deriveConversationTitle(
  messages: HistoryMessageLike[] | undefined,
  options: { fallback?: string; max?: number } = {},
): string {
  const fallback = options.fallback ?? '未命名对话'
  const max = options.max ?? CONVERSATION_TITLE_MAX
  if (!Array.isArray(messages)) return fallback
  for (const message of messages) {
    if (message.role !== 'user') continue
    // 过程记录不会是 user 角色，但显式跳过更稳。
    if (message.localSkillStatus) continue
    const text = messageText(message).trim()
    if (!text) continue
    // 标题只取第一段有内容的行：多行提问的后续行是细节，塞进标题只会更难认。
    const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? text
    return truncateTitle(firstLine, max)
  }
  return fallback
}

/** parts 可能缺失或含空片段，统一在这里取正文。 */
function messageText(message: HistoryMessageLike): string {
  const parts = message.parts
  if (!Array.isArray(parts)) return ''
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
}

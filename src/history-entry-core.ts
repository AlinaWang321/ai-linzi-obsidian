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

/**
 * 标题截断：超长时补省略号。
 *
 * 原实现是 `title.slice(0, 60)` 硬切，配合 CSS 的 text-overflow 本应出省略号，
 * 但 flex 行里没写 min-width:0 时省略号不生效，用户看到的是被生切一半的标题
 * （Alina 截图：「从 Skill Studio 安装「consul」）。这里在数据层就补好，
 * 不依赖 CSS 是否恰好生效。
 */
export function truncateTitle(title: string, max = 40): string {
  const value = (title ?? '').trim()
  if (!value) return '未命名对话'
  if (max <= 1) return value.slice(0, max)
  // Array.from 按码点切，避免把 emoji 或代理对切成半个字符。
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return `${chars.slice(0, max - 1).join('')}…`
}

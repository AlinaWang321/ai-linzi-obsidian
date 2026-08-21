import {
  deriveConversationTitle,
  type HistoryMessageLike,
} from './history-entry-core'

export const CONVERSATION_TITLE_OVERRIDE_MAX = 60

export interface ConversationTitleState {
  /** undefined=从未手工改名；null=用户明确清空，回退自动标题；string=手工标题。 */
  titleOverride?: string | null
  titleUpdatedAt?: number
  /** 本机已保存，但云端插件会话尚未确认写入。 */
  titleSyncPending?: boolean
}

function hasOwnOverride(value: ConversationTitleState): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'titleOverride')
}

function truncateCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('')
}

export function normalizeConversationTitleOverride(value: string): string | null {
  const compact = value.trim().replace(/\s+/gu, ' ')
  return compact
    ? truncateCodePoints(compact, CONVERSATION_TITLE_OVERRIDE_MAX)
    : null
}

export function explicitConversationTitleState(
  value: ConversationTitleState | undefined,
): ConversationTitleState | undefined {
  if (
    !value ||
    !hasOwnOverride(value) ||
    !Number.isFinite(value.titleUpdatedAt) ||
    (value.titleUpdatedAt ?? 0) <= 0 ||
    (value.titleOverride !== null && typeof value.titleOverride !== 'string')
  ) {
    return undefined
  }
  return {
    titleOverride: typeof value.titleOverride === 'string'
      ? normalizeConversationTitleOverride(value.titleOverride)
      : null,
    titleUpdatedAt: value.titleUpdatedAt,
    titleSyncPending: value.titleSyncPending === true,
  }
}

export function conversationTitleStateAt(
  titleOverride: string | null,
  titleUpdatedAt: number,
  titleSyncPending = false,
): ConversationTitleState {
  return {
    titleOverride: typeof titleOverride === 'string'
      ? normalizeConversationTitleOverride(titleOverride)
      : null,
    titleUpdatedAt,
    titleSyncPending,
  }
}

/** 时间戳较新的明确选择获胜；同一服务端时间戳时远端获胜，避免双端反复翻转。 */
export function mergeConversationTitleStates(
  local: ConversationTitleState | undefined,
  remote: ConversationTitleState | undefined,
): ConversationTitleState | undefined {
  const safeLocal = explicitConversationTitleState(local)
  const safeRemote = explicitConversationTitleState(remote)
  if (!safeLocal) return safeRemote
  if (!safeRemote) return safeLocal
  return (safeRemote.titleUpdatedAt ?? 0) >= (safeLocal.titleUpdatedAt ?? 0)
    ? safeRemote
    : safeLocal
}

export function conversationTitleStatesEqual(
  left: ConversationTitleState | undefined,
  right: ConversationTitleState | undefined,
): boolean {
  const a = explicitConversationTitleState(left)
  const b = explicitConversationTitleState(right)
  if (!a || !b) return a === b
  return a.titleOverride === b.titleOverride &&
    a.titleUpdatedAt === b.titleUpdatedAt &&
    a.titleSyncPending === b.titleSyncPending
}

export function effectiveConversationTitle(
  messages: HistoryMessageLike[] | undefined,
  state: ConversationTitleState | undefined,
  fallback = '未命名对话',
): string {
  const explicit = explicitConversationTitleState(state)
  if (typeof explicit?.titleOverride === 'string' && explicit.titleOverride) {
    return explicit.titleOverride
  }
  return deriveConversationTitle(messages, { fallback })
}

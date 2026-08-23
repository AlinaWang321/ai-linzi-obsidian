export interface ChatViewState extends Record<string, unknown> {
  /** 每个对话叶子独占一个 session，禁止多窗口共写同一个会话。 */
  sessionId?: string
  /** 仅用于创建新叶子的一次性启动标记，不写回布局。 */
  startFresh?: boolean
}

export function parseChatViewState(value: unknown): ChatViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.sessionId === 'string' && record.sessionId.trim()
      ? { sessionId: record.sessionId.trim() }
      : {}),
    ...(record.startFresh === true ? { startFresh: true } : {}),
  }
}

export function freshChatViewState(sessionId: string): ChatViewState {
  return { sessionId, startFresh: true }
}

export function persistedChatViewState(sessionId: string): ChatViewState {
  return { sessionId }
}

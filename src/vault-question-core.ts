export interface PendingVaultQuestion {
  kind?: 'clarification' | 'web-search'
  callId: string
  responseId: string
  question: string
  options: string[]
  allowFreeText: boolean
  round: number
  goal: string
  createdAt: number
  answeredAt?: number
  webSearchQuery?: string
  webSearchReason?: string
}

const QUESTION_RE =
  /<<<AI_LINZI_ASK_USER>>>\s*([\s\S]*?)\s*<<<AI_LINZI_ASK_USER_END>>>/g

function shortText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function formatVaultQuestionMarker(question: PendingVaultQuestion): string {
  return `<<<AI_LINZI_ASK_USER>>>\n${JSON.stringify(question)}\n<<<AI_LINZI_ASK_USER_END>>>`
}

function normalizedQuestionAnswer(value: string): string {
  return value.trim().replace(/[，,。.!！?？]/gu, '').replace(/\s+/gu, '')
}

/**
 * A model-provided option that explicitly ends the current workflow must be
 * handled locally. Sending it back to the model can make the model ask the
 * same question again, wastes credits, and leaves beginners in a loop.
 *
 * Free-text answers never trigger this branch: the answer must exactly match
 * one of the rendered options and that option must clearly be terminal.
 */
export function isTerminalVaultQuestionAnswer(
  answer: string,
  question: PendingVaultQuestion,
): boolean {
  const normalized = normalizedQuestionAnswer(answer)
  if (!normalized) return false
  const matchedOption = question.options.some(
    (option) => normalizedQuestionAnswer(option) === normalized,
  )
  if (!matchedOption) return false
  return (
    /^不(?:再)?执行(?:任何)?操作$/u.test(normalized) ||
    /^停止(?:并)?(?:保留|不要|不再|当前|本次|这次|$)/u.test(normalized) ||
    /^取消(?:本次|这次|当前)?(?:操作|任务)?$/u.test(normalized) ||
    /^(?:到此结束|先不做了?)$/u.test(normalized)
  )
}

export function extractVaultQuestion(text: string): {
  cleanText: string
  question?: PendingVaultQuestion
  invalid: boolean
} {
  let question: PendingVaultQuestion | undefined
  let invalid = false
  let count = 0
  const cleanText = text.replace(QUESTION_RE, (_match, raw: string) => {
    count += 1
    if (count > 1) {
      invalid = true
      return ''
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const callId = shortText(parsed.callId, 128)
      const responseId = shortText(parsed.responseId, 128)
      const prompt = shortText(parsed.question, 600)
      const goal = shortText(parsed.goal, 300)
      const round = typeof parsed.round === 'number' ? Math.trunc(parsed.round) : -1
      const kind = parsed.kind === 'web-search' ? 'web-search' : 'clarification'
      const webSearchQuery = shortText(parsed.webSearchQuery, 300)
      const webSearchReason = shortText(parsed.webSearchReason, 200)
      if (!callId || !responseId || !prompt || !goal || round < 1 || round > 36) {
        invalid = true
        return ''
      }
      if (kind === 'web-search' && (!webSearchQuery || !webSearchReason)) {
        invalid = true
        return ''
      }
      question = {
        kind,
        callId,
        responseId,
        question: prompt,
        options: Array.isArray(parsed.options)
          ? parsed.options.map((item) => shortText(item, 120)).filter(Boolean).slice(0, 6)
          : [],
        allowFreeText: parsed.allowFreeText !== false,
        round,
        goal,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        ...(kind === 'web-search' ? { webSearchQuery, webSearchReason } : {}),
      }
    } catch {
      invalid = true
    }
    return ''
  })
  if (text.includes('<<<AI_LINZI_ASK_USER>>>') && count === 0) invalid = true
  return { cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(), question, invalid }
}

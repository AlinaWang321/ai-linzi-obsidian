export interface PendingVaultQuestion {
  callId: string
  responseId: string
  question: string
  options: string[]
  allowFreeText: boolean
  round: number
  goal: string
  createdAt: number
  answeredAt?: number
}

const QUESTION_RE =
  /<<<AI_LINZI_ASK_USER>>>\s*([\s\S]*?)\s*<<<AI_LINZI_ASK_USER_END>>>/g

function shortText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function formatVaultQuestionMarker(question: PendingVaultQuestion): string {
  return `<<<AI_LINZI_ASK_USER>>>\n${JSON.stringify(question)}\n<<<AI_LINZI_ASK_USER_END>>>`
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
      if (!callId || !responseId || !prompt || !goal || round < 1 || round > 12) {
        invalid = true
        return ''
      }
      question = {
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
      }
    } catch {
      invalid = true
    }
    return ''
  })
  if (text.includes('<<<AI_LINZI_ASK_USER>>>') && count === 0) invalid = true
  return { cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(), question, invalid }
}

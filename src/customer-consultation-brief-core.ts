export const CUSTOMER_CONSULTATION_TRANSCRIPT_MIN = 800
export const CUSTOMER_CONSULTATION_TRANSCRIPT_MAX = 100_000
export const CUSTOMER_CONSULTATION_OUTPUT_FOLDER = '客户咨询简报'

export interface CustomerConsultationBriefInput {
  clientName: string
  coachName: string
  topic: string
  sessionInfo: string
}

export function sanitizeConsultationFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 52)
}

export function customerConsultationPngBase(date: string, clientName: string): string {
  return `${date}_${sanitizeConsultationFilePart(clientName) || '客户'}_客户咨询简报`
}

export function normalizeConsultationBriefMarkdown(value: string): string {
  const trimmed = value.trim()
  const fenced = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}

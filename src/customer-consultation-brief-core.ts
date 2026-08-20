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
  let normalized = value.trim()
  // 模型偶尔会输出 Markdown 围栏却漏掉末尾 ```。旧正则要求围栏成对，
  // 导致正文其实完整、第一行也有标题时仍被误判为“格式不完整”。
  normalized = normalized
    .replace(/^```(?:markdown|md)?[ \t]*(?:\r?\n)?/iu, '')
    .replace(/(?:\r?\n)?```[ \t]*$/u, '')
    .trim()

  // 极少数模型会在标题前加一句客套话。只保留第一份一级标题开始的正文，
  // 避免把“下面是简报”一类前言渲染进客户成品。
  const headingIndex = normalized.search(/^#\s+\S/mu)
  return (headingIndex > 0 ? normalized.slice(headingIndex) : normalized).trim()
}

export function ensureConsultationBriefHeading(
  markdown: string,
  input: CustomerConsultationBriefInput,
): string {
  const normalized = markdown.trim()
  if (!normalized) return ''
  if (/^#\s+\S/u.test(normalized)) return normalized

  // 标题属于用户已经明确填写的事实，不需要让模型再猜。正文至少出现一个
  // Markdown 二级章节时，安全补齐标题和署名；纯错误句、拒答或乱码仍失败关闭。
  if (!/^##\s+\S/mu.test(normalized)) return ''
  const meta = [
    input.topic,
    input.sessionInfo,
    input.coachName ? `咨询师 ${input.coachName}` : '',
  ].filter(Boolean).join(' · ')
  return [
    `# ${input.clientName || '客户'} · 咨询简报`,
    meta ? `> ${meta}` : '',
    normalized,
  ].filter(Boolean).join('\n\n')
}

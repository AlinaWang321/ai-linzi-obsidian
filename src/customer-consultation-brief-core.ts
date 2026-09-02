export const CUSTOMER_CONSULTATION_TRANSCRIPT_MIN = 800
export const CUSTOMER_CONSULTATION_TRANSCRIPT_MAX = 100_000
export const CUSTOMER_CONSULTATION_OUTPUT_FOLDER = '客户咨询简报'

export interface CustomerConsultationBriefInput {
  clientName: string
  coachName: string
  topic: string
  sessionInfo: string
}

/**
 * 咨询简报 PNG 的本机隐藏源稿。它只保存在插件本机对话历史，不发送到普通
 * 主对话历史，也不会在 Vault 里多生成一份 Markdown 文件。用户自然语言修改
 * 时以它为真相源重新渲染 PNG，绝不直接在图片像素上“补字”。
 */
export interface CustomerConsultationBriefDraft extends CustomerConsultationBriefInput {
  version: 1
  markdown: string
  sourcePath: string
  pngPath: string
  updatedAt: number
}

export function isConsultationBriefRevisionIntent(value: string): boolean {
  const text = value.trim()
  if (!text || /(?:skill|技能|工作流)/iu.test(text)) return false
  if (!/(?:咨询简报|简报图片|这张简报|刚才的简报)/u.test(text)) return false
  const editVerb = /(?:修改|改成|改为|替换|删掉|删除|补充|新增|增加|调整|精简|重写|换成|纠正)/u.test(text)
  const namedPart = /(?:文字|文案|标题|副标题|第\s*[一二三四五六七八九十\d]+\s*条|诊断|洞察|路径|产品|目标|总结|行动|给你的话|部分|内容|图片|图上)/u.test(text)
  const quotedText = /[“‘"'「『][^”’"'」』\r\n]{1,120}[”’"'」』]/u.test(text)
  const insideBrief = /(?:简报|图片|图)(?:里面|里|上面|上|中的?|内).{1,120}(?:修改|改成|改为|替换|删掉|删除|补充|新增|增加|调整|精简|重写|换成|纠正)/u.test(text)
  return editVerb && (namedPart || quotedText || insideBrief)
}

function consultationBriefHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{2,3}\s+(.+)$/gmu)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** 修改不是重新生成：明显截断、丢章节或没有落实修改时失败关闭。 */
export function consultationBriefRevisionIssue(
  existing: string,
  revised: string,
  instruction: string,
): string | undefined {
  const before = existing.trim()
  const after = revised.trim()
  if (!before || !after) return '咨询简报隐藏源稿或修改结果为空'
  if (before === after) return 'AI 没有落实这次文字修改'

  const structuralChange = /(?:删除|删掉|移除|精简|缩短|合并|去掉).{0,12}(?:章节|部分|整段|全部|内容)?/u.test(
    instruction,
  )
  if (!structuralChange && after.length < Math.max(120, Math.floor(before.length * 0.55))) {
    return '修改结果意外严重缩水，可能丢失了未点名内容'
  }
  if (!structuralChange) {
    const beforeHeadings = consultationBriefHeadings(before)
    const afterHeadings = consultationBriefHeadings(after)
    const headingChange = /(?:标题|副标题|小标题|章节名|章节标题)/u.test(instruction)
    const missing = headingChange
      ? beforeHeadings.length > afterHeadings.length
        ? ['未点名章节']
        : []
      : beforeHeadings.filter((heading) => !afterHeadings.includes(heading))
    if (missing.length > 0) return `修改结果意外丢失章节：${missing.slice(0, 3).join('、')}`
  }
  return undefined
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

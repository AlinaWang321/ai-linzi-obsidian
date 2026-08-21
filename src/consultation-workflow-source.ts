export interface ConsultationWorkflowSource {
  sourceId: string
  filename: string
  path: string
}

const TRANSCRIPT_EXTENSIONS = new Set(['md', 'txt', 'pdf', 'docx'])

function normalized(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function extension(path: string): string {
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase() : ''
}

function underRoot(path: string, root?: string): boolean {
  const target = normalized(path)
  const parent = normalized(root ?? '')
  return Boolean(parent) && (target === parent || target.startsWith(`${parent}/`))
}

function sourceScore(
  source: ConsultationWorkflowSource,
  options: { localSkillsRoot?: string; outputRoot?: string },
): number | null {
  const path = normalized(source.path)
  const filename = source.filename || path.split('/').at(-1) || ''
  const haystack = `${path} ${filename}`
  if (!path || !TRANSCRIPT_EXTENSIONS.has(extension(path))) return null
  if (underRoot(path, options.localSkillsRoot) || underRoot(path, options.outputRoot)) return null
  if (/consultation-preload-(?:rule|template)/u.test(source.sourceId)) return null
  if (/(?:^|\/)(?:references?|templates?|模板库)(?:\/|$)/iu.test(path)) return null
  if (/(?:manifest|checklist|field-mapping|字段映射|客户档案模板|客户模板)/iu.test(haystack)) return null
  if (/(?:客户档案|CRM|跟进任务|客户咨询简报|经营周报)/iu.test(filename)) return null

  let score = 20
  if (/(?:逐字稿|咨询(?:记录|文档|材料|原文)|访谈记录|录音转写)/u.test(haystack)) score += 75
  if (/(?:^|\/)(?:0?1[_ -]?Raw|Raw|原始素材|销售逐字稿|咨询逐字稿)(?:\/|$)/iu.test(path)) score += 55
  if (/^(?:txt|pdf|docx)$/u.test(extension(path))) score += 10
  if (/read|search|source/iu.test(source.sourceId)) score += 5
  return score
}

/**
 * 从 AI 本轮真实读过的本地来源中锁定咨询原文。
 *
 * 只在一个候选明显领先时自动选择；多份逐字稿同分时宁可返回 undefined，
 * 让界面重新弹出文件选择器，也不把别人的咨询材料带进简报。
 */
export function consultationWorkflowSourcePath(
  sources: ConsultationWorkflowSource[],
  options: { localSkillsRoot?: string; outputRoot?: string } = {},
): string | undefined {
  const candidates = sources
    .map((source) => ({ source, score: sourceScore(source, options) }))
    .filter((item): item is { source: ConsultationWorkflowSource; score: number } => item.score !== null)
    .sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path, 'zh-CN'))
  const best = candidates[0]
  if (!best || best.score < 80) return undefined
  const second = candidates[1]
  if (second && second.score >= best.score - 10) return undefined
  return normalized(best.source.path)
}

export function isConsultationTranscriptPath(path: string): boolean {
  return TRANSCRIPT_EXTENSIONS.has(extension(normalized(path)))
}

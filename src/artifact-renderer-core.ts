export const ARTIFACT_FORMATS = ['html', 'docx', 'pdf', 'pptx'] as const
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number]
export type ArtifactTheme = 'brand' | 'clean'
/**
 * HTML 版式（0.7.54）：document=文档式长文（文章/报告/简报）；
 * dashboard=交互看板（标签分页、任务卡片、可勾选进度、本地保存状态）。
 * 只影响 HTML；docx/pdf/pptx 永远走文档排版。
 */
export const ARTIFACT_LAYOUTS = ['document', 'dashboard'] as const
export type ArtifactLayout = (typeof ARTIFACT_LAYOUTS)[number]

export const ARTIFACT_MAX_CONTENT_CHARS = 60_000
export const ARTIFACT_MAX_TITLE_CHARS = 160

export interface CreateArtifactOperation {
  type: 'create_artifact'
  /** `$OUTPUT/` 会在插件本机替换为用户设置的 AI霖子输出目录。 */
  path: string
  format: ArtifactFormat
  title: string
  /** 所有格式共用的 Markdown 内容真相源。 */
  content: string
  theme?: ArtifactTheme
  layout?: ArtifactLayout
  reason?: string
}

/** 模型给了 layout 就照用；没给则按标题/正文特征判断，避免长文被误渲染成看板。 */
export function resolveArtifactLayout(
  operation: Pick<CreateArtifactOperation, 'title' | 'content' | 'layout'>,
): ArtifactLayout {
  if (operation.layout === 'dashboard' || operation.layout === 'document') return operation.layout
  const title = operation.title ?? ''
  const content = operation.content ?? ''
  const titleSignal = /看板|仪表盘|驾驶舱|日报|周报|dashboard|kanban/i.test(title)
  const checkboxCount = (content.match(/^\s*[-*]\s*\[[ xX]\]/gm) ?? []).length
  const sectionCount = (content.match(/^#{2,4}\s+\S/gm) ?? []).length
  // 看板的判据是「可勾选任务 + 多分区」，两者都够才切换；只是标题带"日报"的长文仍走文档式。
  if (titleSignal && (checkboxCount >= 3 || sectionCount >= 4)) return 'dashboard'
  if (checkboxCount >= 5 && sectionCount >= 3) return 'dashboard'
  return 'document'
}

export type ArtifactBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'table'; headers: string[]; rows: string[][] }

export interface ArtifactDocument {
  title: string
  blocks: ArtifactBlock[]
}

function plainInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_[\]{}()#+.!|>-])/g, '$1')
    .trim()
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized
  const end = normalized.indexOf('\n---\n', 4)
  return end >= 0 ? normalized.slice(end + 5) : normalized
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((value) => plainInline(value.replace(/\\\|/g, '|')))
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  if (!line.trim()) return true
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) ||
    (line.includes('|') && isTableSeparator(lines[index + 1] ?? ''))
  )
}

export function parseArtifactMarkdown(markdown: string, fallbackTitle = 'AI霖子文档'): ArtifactDocument {
  const lines = stripFrontmatter(markdown).split('\n')
  const blocks: ArtifactBlock[] = []
  let title = fallbackTitle.trim() || 'AI霖子文档'
  let sawTitle = false
  let index = 0

  while (index < lines.length && blocks.length < 600) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const text = plainInline(heading[2])
      if (!sawTitle && heading[1].length === 1 && text) {
        title = text
        sawTitle = true
      } else if (text) {
        blocks.push({ type: 'heading', level: Math.min(4, heading[1].length), text })
      }
      index += 1
      continue
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (/^\s*```/.test(line)) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', text: code.join('\n').slice(0, 12_000) })
      continue
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = tableCells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const cells = tableCells(lines[index])
        rows.push([...cells, ...Array(Math.max(0, headers.length - cells.length)).fill('')].slice(0, headers.length))
        index += 1
      }
      if (headers.length > 0) blocks.push({ type: 'table', headers, rows: rows.slice(0, 80) })
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      const parts = [quote[1]]
      index += 1
      while (index < lines.length) {
        const next = /^\s*>\s?(.*)$/.exec(lines[index])
        if (!next) break
        parts.push(next[1])
        index += 1
      }
      blocks.push({ type: 'quote', text: plainInline(parts.join(' ')) })
      continue
    }

    const list = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line)
    if (list) {
      const ordered = Boolean(list[2])
      const items: string[] = []
      while (index < lines.length) {
        const next = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(lines[index])
        if (!next || Boolean(next[2]) !== ordered) break
        items.push(plainInline(next[3]))
        index += 1
      }
      blocks.push({ type: 'list', ordered, items: items.filter(Boolean).slice(0, 120) })
      continue
    }

    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    const text = plainInline(paragraph.join(' '))
    if (text) blocks.push({ type: 'paragraph', text })
  }

  return { title: title.slice(0, ARTIFACT_MAX_TITLE_CHARS), blocks }
}

export function artifactFormatLabel(format: ArtifactFormat): string {
  if (format === 'docx') return 'Word'
  if (format === 'pptx') return 'PowerPoint'
  return format.toUpperCase()
}

export function resolveArtifactPath(path: string, outputRoot: string): string {
  const normalizedRoot = outputRoot.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'AI霖子输出'
  const normalized = path.trim().replace(/\\/g, '/')
  if (normalized === '$OUTPUT') return normalizedRoot
  if (normalized.startsWith('$OUTPUT/')) return `${normalizedRoot}/${normalized.slice('$OUTPUT/'.length)}`
  return normalized
}

export function estimateArtifactUnits(operation: CreateArtifactOperation): { label: string; count: number } {
  const document = parseArtifactMarkdown(operation.content, operation.title)
  const weightedChars = document.blocks.reduce((total, block) => {
    if (block.type === 'table') {
      return total + [...block.headers, ...block.rows.flat()].join('').length * 1.5
    }
    if (block.type === 'list') return total + block.items.join('').length * 1.2
    if (block.type === 'rule') return total + 20
    return total + block.text.length
  }, 0)
  if (operation.format === 'pptx') {
    const sectionCount = document.blocks.filter((block) => block.type === 'heading' && block.level <= 2).length
    return { label: '幻灯片', count: Math.max(1, sectionCount || Math.ceil(weightedChars / 420)) + 1 }
  }
  if (operation.format === 'pdf') return { label: '页', count: Math.max(1, Math.ceil(weightedChars / 1_100)) }
  if (operation.format === 'docx') return { label: '页', count: Math.max(1, Math.ceil(weightedChars / 1_500)) }
  return { label: '章节', count: Math.max(1, document.blocks.filter((block) => block.type === 'heading').length) }
}

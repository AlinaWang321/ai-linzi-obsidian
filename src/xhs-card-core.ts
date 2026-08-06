export type XhsCardBlockKind = 'heading' | 'quote' | 'paragraph'

export interface XhsBoldRange {
  start: number
  end: number
}

export interface XhsCardBlock {
  kind: XhsCardBlockKind
  text: string
  /** Markdown 标题层级；正文和引用不设置。 */
  level?: number
  /** H2 对应 PART 编号；只在章节标题上设置。 */
  sectionIndex?: number
  /** Markdown **加粗** 在纯文本中的位置。 */
  boldRanges?: XhsBoldRange[]
}

export interface ParsedXhsCardDocument {
  title: string
  excerpt: string
  hashtags: string[]
  blocks: XhsCardBlock[]
}

export interface XhsCardPage {
  blocks: XhsCardBlock[]
}

function stripYamlFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/**
 * 卡片图库是生成结果，不属于文章正文。
 * 必须在解析和分页前移除，否则用户对已生成的小红书笔记再次运行命令时，
 * 旧版的图库标题、说明和图片链接会被画进最后一张 PNG。
 */
export function stripGeneratedXhsCardGallery(markdown: string): string {
  return markdown
    .replace(
      /<!-- AI_LINZI_XHS_CARDS_START -->[\s\S]*?<!-- AI_LINZI_XHS_CARDS_END -->\s*/g,
      '',
    )
    .replace(/<!-- AI_LINZI_XHS_CARDS_START -->[\s\S]*$/g, '')
    .replace(/^## 小红书 3:4 发布卡片\s*\n+(?:>\s*)?由 AI霖子在本地生成；发布前可直接检查每一页。\s*\n*/gm, '')
}

/**
 * 生成完成后，小红书笔记只保留：
 * 1. 原有 frontmatter（来源关系、发布状态等）；
 * 2. 可直接预览/发布的卡片；
 * 3. 小红书配文。
 *
 * 公众号全文只用于卡片分页，不应在分发笔记里重复出现。
 */
export function composeGeneratedXhsNote(
  current: string,
  imagePaths: string[],
  caption = '',
): string {
  const frontmatter =
    current.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/)?.[0].trimEnd() ?? ''
  const embeds = imagePaths.map((path) => `![[${path}]]`).join('\n\n')
  return [
    frontmatter,
    '<!-- AI_LINZI_XHS_CARDS_START -->',
    embeds,
    '<!-- AI_LINZI_XHS_CARDS_END -->',
    caption.trim(),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}

function inlineText(text: string): { text: string; boldRanges: XhsBoldRange[] } {
  const source = text
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias || target)
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
  const chars: { value: string; bold: boolean }[] = []
  let bold = false
  for (let index = 0; index < source.length; index++) {
    const pair = source.slice(index, index + 2)
    if (pair === '**' || pair === '__') {
      bold = !bold
      index++
      continue
    }
    if (pair === '~~') {
      index++
      continue
    }
    if (source[index] === '*') continue
    const whitespace = /\s/.test(source[index])
    if (whitespace && (chars.length === 0 || chars[chars.length - 1].value === ' ')) continue
    chars.push({ value: whitespace ? ' ' : source[index], bold })
  }
  while (chars[0]?.value === ' ') chars.shift()
  while (chars[chars.length - 1]?.value === ' ') chars.pop()

  const boldRanges: XhsBoldRange[] = []
  let rangeStart = -1
  chars.forEach((char, index) => {
    if (char.bold && rangeStart < 0) rangeStart = index
    if (!char.bold && rangeStart >= 0) {
      boldRanges.push({ start: rangeStart, end: index })
      rangeStart = -1
    }
  })
  if (rangeStart >= 0) boldRanges.push({ start: rangeStart, end: chars.length })
  return { text: chars.map((char) => char.value).join(''), boldRanges }
}

function plainInline(text: string): string {
  return inlineText(text).text
}

function isHashtagLine(text: string): boolean {
  const clean = plainInline(text)
  return Boolean(clean && /^(?:#[^\s#]+\s*)+$/.test(clean))
}

function splitParagraphs(markdown: string): string[] {
  return markdown
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function partNumber(text: string): number | null {
  const match = /^PART\s*0*(\d+)$/i.exec(plainInline(text))
  return match ? Number(match[1]) : null
}

function headingWithPart(text: string): { text: string; sectionIndex?: number } {
  const clean = plainInline(text)
  const match = /^PART\s*0*(\d+)\s*(?:[：:·—–-]\s*|\s+)(.+)$/i.exec(clean)
  if (!match) return { text: clean }
  return {
    text: match[2].trim(),
    sectionIndex: Number(match[1]),
  }
}

export function parseXhsCardDocument(
  markdown: string,
  fallbackTitle: string,
  sourceSummary = '',
): ParsedXhsCardDocument {
  const source = stripGeneratedXhsCardGallery(stripYamlFrontmatter(markdown))
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let title = ''
  let titleLine = -1
  const hashtags: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    const h1 = /^#\s+(.+)$/.exec(line)
    if (h1 && !title) {
      title = plainInline(h1[1])
      titleLine = index
      continue
    }
    if (isHashtagLine(line)) {
      hashtags.push(...(plainInline(line).match(/#[^\s#]+/g) ?? []))
      lines[index] = ''
    }
  }
  if (titleLine >= 0) lines[titleLine] = ''

  title =
    title ||
    plainInline(fallbackTitle)
      .replace(/^\d{4}[.-]\d{2}[.-]\d{2}_/, '')
      .replace(/^小红书(?:图文|笔记)?[_：:\s-]*/, '') ||
    '一篇值得收藏的笔记'

  const blocks: XhsCardBlock[] = []
  let sectionIndex = 0
  let pendingPartIndex: number | null = null
  for (const part of splitParagraphs(lines.join('\n'))) {
    const partLines = part.split('\n').map((line) => line.trim()).filter(Boolean)
    const first = partLines[0] ?? ''
    const standalonePart = partLines.length === 1 ? partNumber(first) : null
    if (standalonePart !== null) {
      pendingPartIndex = standalonePart
      continue
    }
    const heading = /^#{2,6}\s+(.+)$/.exec(first)
    if (heading) {
      const parsedHeading = headingWithPart(heading[1])
      const text = parsedHeading.text
      const level = Math.min(3, first.match(/^#+/)?.[0].length ?? 2)
      if (text && !/^(正文|小红书正文|笔记正文|话题标签|标签)$/.test(text)) {
        if (level === 2) {
          sectionIndex = parsedHeading.sectionIndex ?? pendingPartIndex ?? sectionIndex + 1
          pendingPartIndex = null
        }
        blocks.push({
          kind: 'heading',
          text,
          level,
          sectionIndex: level === 2 ? sectionIndex : undefined,
        })
      }
      const rest = inlineText(partLines.slice(1).join(' '))
      if (rest.text) blocks.push({ kind: 'paragraph', text: rest.text, boldRanges: rest.boldRanges })
      continue
    }
    const quote = partLines.every((line) => /^>\s?/.test(line))
    const content = inlineText(
      partLines.map((line) => line.replace(/^[-*+]\s+/, '').replace(/^>\s?/, '')).join(' '),
    )
    if (!content.text || isHashtagLine(content.text) || /^[-*_]{3,}$/.test(content.text)) continue
    blocks.push({
      kind: quote ? 'quote' : 'paragraph',
      text: content.text,
      boldRanges: content.boldRanges,
    })
  }

  if (blocks.length === 0) blocks.push({ kind: 'paragraph', text: title })
  const summary = plainInline(sourceSummary)
  const excerpt =
    summary.length > 88 ? `${summary.slice(0, 86).replace(/[，。；、\s]+$/, '')}…` : summary
  return { title, excerpt, hashtags: [...new Set(hashtags)], blocks }
}

function visualLength(text: string): number {
  let length = 0
  for (const char of text) length += /[\u0000-\u00ff]/.test(char) ? 0.56 : 1
  return length
}

function sliceBlock(block: XhsCardBlock, start: number, end: number): XhsCardBlock | null {
  let from = start
  let to = end
  while (from < to && /\s/.test(block.text[from])) from++
  while (to > from && /\s/.test(block.text[to - 1])) to--
  if (from >= to) return null
  return {
    ...block,
    text: block.text.slice(from, to),
    sectionIndex: from === 0 ? block.sectionIndex : undefined,
    boldRanges: (block.boldRanges ?? [])
      .map((range) => ({
        start: Math.max(range.start, from) - from,
        end: Math.min(range.end, to) - from,
      }))
      .filter((range) => range.start < range.end),
  }
}

function visualCutIndex(text: string, maxVisualChars: number): number {
  if (visualLength(text) <= maxVisualChars) return text.length
  let width = 0
  let cursor = 0
  while (cursor < text.length && width < maxVisualChars) {
    width += /[\u0000-\u00ff]/.test(text[cursor]) ? 0.56 : 1
    cursor++
  }
  const minimum = Math.max(1, Math.floor(cursor * 0.58))
  const candidate = text.slice(0, cursor)
  const punctuation = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('；'),
  )
  return punctuation >= minimum ? punctuation + 1 : cursor
}

/**
 * 把正文开头切给第一页，剩余内容从下一页继续。
 * 这里按原 block 顺序消费，避免第一页和第二页重复正文。
 */
export function takeXhsCoverIntro(
  blocks: XhsCardBlock[],
  maxVisualChars = 118,
): { coverBlocks: XhsCardBlock[]; remainingBlocks: XhsCardBlock[] } {
  const coverBlocks: XhsCardBlock[] = []
  let budget = maxVisualChars
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const overhead = block.kind === 'heading' ? 14 : block.kind === 'quote' ? 6 : 0
    if (budget <= overhead + 8) {
      return { coverBlocks, remainingBlocks: blocks.slice(index) }
    }
    const allowance = budget - overhead
    const cut = visualCutIndex(block.text, allowance)
    const cover = sliceBlock(block, 0, cut)
    if (cover) coverBlocks.push(cover)
    if (cut < block.text.length) {
      const remainder = sliceBlock(block, cut, block.text.length)
      return {
        coverBlocks,
        remainingBlocks: [...(remainder ? [remainder] : []), ...blocks.slice(index + 1)],
      }
    }
    budget -= visualLength(block.text) + overhead
  }
  return { coverBlocks, remainingBlocks: [] }
}

function splitLongText(text: string, maxVisualChars: number): string[] {
  if (visualLength(text) <= maxVisualChars) return [text]
  const chunks: string[] = []
  let rest = text.trim()
  while (visualLength(rest) > maxVisualChars) {
    let cursor = 0
    let width = 0
    while (cursor < rest.length && width < maxVisualChars) {
      width += /[\u0000-\u00ff]/.test(rest[cursor]) ? 0.56 : 1
      cursor++
    }
    const start = Math.max(1, Math.floor(cursor * 0.55))
    const candidate = rest.slice(0, cursor + 1)
    const punctuation = Math.max(
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('！'),
      candidate.lastIndexOf('？'),
      candidate.lastIndexOf('；'),
      candidate.lastIndexOf('，'),
    )
    const cut = punctuation >= start ? punctuation + 1 : cursor
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

function blockUnits(block: XhsCardBlock): number {
  const charsPerLine =
    block.kind === 'heading'
      ? block.level === 2
        ? 18
        : 22
      : block.kind === 'quote'
        ? 27
        : 29
  const lineUnits = Math.max(1, Math.ceil(visualLength(block.text) / charsPerLine))
  return lineUnits + (block.kind === 'heading' ? (block.level === 2 ? 2.4 : 0.9) : block.kind === 'quote' ? 0.7 : 0.3)
}

function splitBlock(block: XhsCardBlock, limit: number): XhsCardBlock[] {
  const chunks = splitLongText(block.text, limit)
  let cursor = 0
  return chunks.map((text, chunkIndex) => {
    const start = Math.max(cursor, block.text.indexOf(text, cursor))
    const end = start + text.length
    cursor = end
    const boldRanges = (block.boldRanges ?? [])
      .map((range) => ({
        start: Math.max(range.start, start) - start,
        end: Math.min(range.end, end) - start,
      }))
      .filter((range) => range.start < range.end)
    return {
      ...block,
      text,
      sectionIndex: chunkIndex === 0 ? block.sectionIndex : undefined,
      boldRanges,
    }
  })
}

export function paginateXhsCardBlocks(blocks: XhsCardBlock[], maxUnits = 21): XhsCardPage[] {
  const normalized = blocks.flatMap((block) => {
    const limit = block.kind === 'heading' ? 48 : 240
    return splitBlock(block, limit)
  })
  const pages: XhsCardPage[] = []
  let current: XhsCardBlock[] = []
  let units = 0

  const flush = () => {
    if (current.length > 0) pages.push({ blocks: current })
    current = []
    units = 0
  }

  for (const block of normalized) {
    const needed = blockUnits(block)
    if (current.length > 0 && units + needed > maxUnits) flush()
    current.push(block)
    units += needed
  }
  flush()
  return pages.length > 0 ? pages : [{ blocks: [{ kind: 'paragraph', text: '内容正在整理中。' }] }]
}

export function stableContentFingerprint(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

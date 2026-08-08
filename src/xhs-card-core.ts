export type XhsCardBlockKind = 'heading' | 'quote' | 'paragraph' | 'image'

export interface XhsBoldRange {
  start: number
  end: number
}

export interface XhsCardBlock {
  kind: XhsCardBlockKind
  text: string
  /** 图片在 Markdown / Wiki 链接中的原始目标；只在 image block 上设置。 */
  imageSource?: string
  /** 图片成功加载后写入，用于分页时预估完整等比图片的高度。 */
  imageAspectRatio?: number
  /** 只有全宽图会造成明显留白时，分页器才会标记为左图右文。 */
  imageLayout?: 'full' | 'side'
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

/** 正文图片不再默认占到 620px，给同页上下文留出空间。 */
export const XHS_BODY_IMAGE_MAX_HEIGHT = 480
/** 左图右文的尺寸边界；是否启用由当前页的剩余空间决定。 */
export const XHS_SIDE_IMAGE_WIDTH = 430
export const XHS_SIDE_IMAGE_MAX_HEIGHT = 420
export const XHS_SIDE_TEXT_MAX_VISUAL_CHARS = 112
const XHS_LAYOUT_UNIT_PX = 58

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
 * 2. 3 个备选标题、小红书正文和话题词；
 * 3. 可直接预览/发布的卡片。
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
    caption.trim(),
    '<!-- AI_LINZI_XHS_CARDS_START -->',
    embeds,
    '<!-- AI_LINZI_XHS_CARDS_END -->',
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

const IMAGE_TOKEN_PATTERN =
  /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)|<img\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>/gi

function separateImageTokens(markdown: string): string {
  return markdown.replace(IMAGE_TOKEN_PATTERN, (match) => `\n\n${match}\n\n`)
}

function imageBlock(markdown: string): XhsCardBlock | null {
  const source = markdown.trim()
  const wiki = /^!\[\[([^\]]+)\]\]$/.exec(source)
  if (wiki) {
    const [target, alias = ''] = wiki[1].split('|')
    const cleanTarget = target.split('#')[0].trim()
    if (!cleanTarget) return null
    return {
      kind: 'image',
      text: /^\d+(?:x\d+)?$/.test(alias.trim()) ? '' : plainInline(alias),
      imageSource: cleanTarget,
    }
  }
  const standard = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(source)
  if (standard) {
    const rawTarget = standard[2].trim()
    const target = rawTarget.startsWith('<')
      ? rawTarget.slice(1, rawTarget.indexOf('>'))
      : rawTarget.replace(/\s+["'][^"']*["']\s*$/, '')
    if (!target) return null
    return {
      kind: 'image',
      text: plainInline(standard[1]),
      imageSource: target,
    }
  }
  if (/^<img\b/i.test(source)) {
    const target = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(source)?.[1]?.trim() ?? ''
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(source)?.[1] ?? ''
    if (!target) return null
    return { kind: 'image', text: plainInline(alt), imageSource: target }
  }
  return null
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
  for (const part of splitParagraphs(separateImageTokens(lines.join('\n')))) {
    const image = imageBlock(part)
    if (image) {
      blocks.push(image)
      continue
    }
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

function canUseXhsSideBySideLayout(
  image: XhsCardBlock,
  text: XhsCardBlock | undefined,
): boolean {
  return Boolean(
    image.kind === 'image' &&
      text &&
      (text.kind === 'paragraph' || text.kind === 'quote') &&
      visualLength(text.text) <= XHS_SIDE_TEXT_MAX_VISUAL_CHARS,
  )
}

export function shouldUseXhsSideBySideLayout(
  image: XhsCardBlock,
  text: XhsCardBlock | undefined,
): boolean {
  return image.imageLayout === 'side' && canUseXhsSideBySideLayout(image, text)
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
    if (block.kind === 'image') {
      return { coverBlocks, remainingBlocks: blocks.slice(index) }
    }
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
  if (block.kind === 'image') {
    const aspectRatio = Math.max(0.2, block.imageAspectRatio ?? 4 / 3)
    const renderedHeight = Math.min(XHS_BODY_IMAGE_MAX_HEIGHT, 940 / aspectRatio)
    return (renderedHeight + 40) / XHS_LAYOUT_UNIT_PX
  }
  const charsPerLine =
    block.kind === 'heading'
      ? block.level === 2
        ? 18
        : 22
      : block.kind === 'quote'
        ? 27
        : 29
  const lineCount = Math.max(1, Math.ceil(visualLength(block.text) / charsPerLine))
  if (block.kind === 'heading') {
    const primary = block.level !== 3
    const topSpacing = primary ? 48 : 36
    const sectionHeight = primary && block.sectionIndex ? 112 : 0
    const lineHeight = primary ? 62 : 56
    const bottomSpacing = primary ? 40 : 32
    return (topSpacing + sectionHeight + lineCount * lineHeight + bottomSpacing) / XHS_LAYOUT_UNIT_PX
  }
  if (block.kind === 'quote') {
    return (lineCount * 60 + 34) / XHS_LAYOUT_UNIT_PX
  }
  return (lineCount * 58 + 36) / XHS_LAYOUT_UNIT_PX
}

function sideBySideUnits(image: XhsCardBlock, text: XhsCardBlock): number {
  const aspectRatio = Math.max(0.2, image.imageAspectRatio ?? 4 / 3)
  const imageHeight = Math.min(
    XHS_SIDE_IMAGE_MAX_HEIGHT,
    XHS_SIDE_IMAGE_WIDTH / aspectRatio,
  )
  const charsPerLine = text.kind === 'quote' ? 13 : 14
  const lineHeight = text.kind === 'quote' ? 58 : 56
  const textHeight =
    Math.max(1, Math.ceil(visualLength(text.text) / charsPerLine)) * lineHeight + 40
  return Math.max(imageHeight, textHeight) / XHS_LAYOUT_UNIT_PX
}

function pageUnits(blocks: XhsCardBlock[]): number {
  let units = 0
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const next = blocks[index + 1]
    if (shouldUseXhsSideBySideLayout(block, next)) {
      units += sideBySideUnits(block, next)
      index++
    } else {
      units += blockUnits(block)
    }
  }
  return units
}

function compactSideBySidePageBreaks(pages: XhsCardPage[], maxUnits: number): void {
  for (let index = 0; index < pages.length - 1; index++) {
    const page = pages[index]
    const next = pages[index + 1]
    const image = page.blocks.at(-1)
    const text = next.blocks[0]
    if (!image || !canUseXhsSideBySideLayout(image, text)) continue
    image.imageLayout = 'side'
    if (pageUnits([...page.blocks, ...next.blocks]) <= maxUnits) {
      page.blocks.push(...next.blocks.splice(0))
    } else {
      image.imageLayout = 'full'
    }
  }
}

function splitBlock(block: XhsCardBlock, limit: number): XhsCardBlock[] {
  if (block.kind === 'image') return [block]
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
    const limit = block.kind === 'heading' ? 48 : block.kind === 'image' ? 1 : 180
    return splitBlock(block, limit)
  })
  const pages: XhsCardPage[] = []
  let current: XhsCardBlock[] = []
  let units = 0

  for (const block of normalized) {
    if (block.kind === 'image') block.imageLayout = 'full'
  }

  const flush = () => {
    if (current.length > 0) pages.push({ blocks: current })
    current = []
    units = 0
  }

  for (let index = 0; index < normalized.length; index++) {
    const block = normalized[index]
    const next = normalized[index + 1]
    if (block.kind === 'heading' && next) {
      const needed = blockUnits(block) + blockUnits(next)
      if (current.length > 0 && units + needed > maxUnits) flush()
      current.push(block, next)
      index++
      units += needed
      continue
    }
    if (block.kind === 'image') {
      const fullWidthNeeded = blockUnits(block)
      if (current.length > 0 && units + fullWidthNeeded > maxUnits) {
        if (canUseXhsSideBySideLayout(block, next)) {
          const compactNeeded = sideBySideUnits(block, next as XhsCardBlock)
          if (units + compactNeeded <= maxUnits) {
            block.imageLayout = 'side'
            current.push(block, next as XhsCardBlock)
            units += compactNeeded
            index++
            continue
          }
        }
        flush()
      }
      current.push(block)
      units += fullWidthNeeded
      continue
    }
    const needed = blockUnits(block)
    if (current.length > 0 && units + needed > maxUnits) flush()
    current.push(block)
    units += needed
  }
  flush()
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]
    if (!page.blocks.every((block) => block.kind === 'image')) continue
    const previous = pages[index - 1]
    const previousLast = previous?.blocks.at(-1)
    if (
      previousLast &&
      previousLast.kind !== 'image' &&
      pageUnits([previousLast, ...page.blocks]) <= maxUnits
    ) {
      page.blocks.unshift(previous.blocks.pop() as XhsCardBlock)
    }
    const next = pages[index + 1]
    while (next?.blocks.length) {
      const first = next.blocks[0]
      if (first.kind === 'image') break
      const take = first.kind === 'heading' && next.blocks[1] ? 2 : 1
      const moving = next.blocks.slice(0, take)
      if (pageUnits([...page.blocks, ...moving]) > maxUnits) break
      page.blocks.push(...next.blocks.splice(0, take))
    }
  }

  // 只有左图右文能把相邻两张稀疏卡片合并成一张时，才启用紧凑布局。
  // 这是对“全宽图后留下大块空白”的后处理，不会把正常图片全部改成双栏。
  compactSideBySidePageBreaks(pages, maxUnits)
  const filledPages = pages.filter((page) => page.blocks.length > 0)
  if (filledPages.length > 1) {
    const last = filledPages.at(-1) as XhsCardPage
    const previous = filledPages.at(-2) as XhsCardPage
    const targetUnits = Math.ceil(maxUnits * 0.5)
    const previousMinimumUnits = Math.ceil(maxUnits * 0.42)
    while (pageUnits(last.blocks) < targetUnits && previous.blocks.length > 1) {
      let start = previous.blocks.length - 1
      const trailing = previous.blocks[start]
      const beforeTrailing = previous.blocks[start - 1]
      if (
        beforeTrailing &&
        (shouldUseXhsSideBySideLayout(beforeTrailing, trailing) ||
          beforeTrailing.kind === 'heading')
      ) {
        start--
      }
      const moving = previous.blocks.slice(start)
      if (pageUnits(previous.blocks.slice(0, start)) < previousMinimumUnits) break
      previous.blocks.splice(start)
      last.blocks.unshift(...moving)
    }
  }
  compactSideBySidePageBreaks(filledPages, maxUnits)
  const finalPages = filledPages.filter((page) => page.blocks.length > 0)
  return finalPages.length > 0
    ? finalPages
    : [{ blocks: [{ kind: 'paragraph', text: '内容正在整理中。' }] }]
}

export function stableContentFingerprint(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

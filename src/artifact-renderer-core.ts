export const ARTIFACT_FORMATS = ['html', 'docx', 'pdf', 'pptx', 'xlsx'] as const
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number]
export type ArtifactTheme = 'brand' | 'clean'
export const ARTIFACT_TEMPLATES = [
  'general',
  'course-handout',
  'client-proposal',
  'business-report',
  'data-workbook',
  'presentation',
] as const
export type ArtifactTemplate = (typeof ARTIFACT_TEMPLATES)[number]
export const ARTIFACT_PAGE_SIZES = ['a4', 'letter'] as const
export type ArtifactPageSize = (typeof ARTIFACT_PAGE_SIZES)[number]
export const ARTIFACT_ORIENTATIONS = ['portrait', 'landscape'] as const
export type ArtifactOrientation = (typeof ARTIFACT_ORIENTATIONS)[number]
export const ARTIFACT_FONTS = ['default', 'songti', 'yahei', 'heiti', 'fangsong', 'kaiti', 'calibri', 'arial'] as const
export type ArtifactFont = (typeof ARTIFACT_FONTS)[number]

/**
 * PPT 不是一个单独 Skill，而是主对话 create_artifact 的受控页面协议。
 * 模型只能选择这些语义版式并填写文字；插件本机决定真实坐标、颜色与字体，
 * 因而自然语言改稿不会把任意 HTML/CSS/脚本带进 Office 文件。
 */
export const PRESENTATION_LAYOUTS = [
  'cover',
  'statement',
  'content',
  'cards',
  'process',
  'comparison',
  'metrics',
  'quote',
  'closing',
] as const
export type PresentationLayout = (typeof PRESENTATION_LAYOUTS)[number]

export interface PresentationMetricInput {
  value?: string
  label?: string
}

export interface PresentationSlideInput {
  layout?: PresentationLayout
  kicker?: string
  headline?: string
  body?: string
  items?: string[]
  leftTitle?: string
  leftItems?: string[]
  rightTitle?: string
  rightItems?: string[]
  metrics?: PresentationMetricInput[]
  quote?: string
  source?: string
  notes?: string
}

export interface PresentationSpecInput {
  /** 当前只开放一套公开视觉名；后续扩展也不等于新增 Skill。 */
  template?: 'course-explainer'
  subtitle?: string
  /** 用户明确指定的总页数；存在时必须与 slides 严格一致。 */
  requestedSlideCount?: number
  slides?: PresentationSlideInput[]
}

export interface PresentationMetric {
  value: string
  label: string
}

export interface PresentationSlide {
  layout: PresentationLayout
  kicker: string
  headline: string
  body: string
  items: string[]
  leftTitle: string
  leftItems: string[]
  rightTitle: string
  rightItems: string[]
  metrics: PresentationMetric[]
  quote: string
  source: string
  notes: string
}

export interface PresentationSpec {
  template: 'course-explainer'
  subtitle: string
  requestedSlideCount?: number
  slides: PresentationSlide[]
}

export interface ArtifactStyleInput {
  pageSize?: ArtifactPageSize
  orientation?: ArtifactOrientation
  bodyFont?: ArtifactFont
  headingFont?: ArtifactFont
  bodySizePt?: number
  titleSizePt?: number
  lineSpacing?: number
  marginMm?: number
  firstLineIndentChars?: number
  includeCover?: boolean
  includeToc?: boolean
  pageNumbers?: boolean
  headerText?: string
  footerText?: string
  accentColor?: string
}

export interface ResolvedArtifactStyle {
  pageSize: ArtifactPageSize
  orientation: ArtifactOrientation
  bodyFont: ArtifactFont
  headingFont: ArtifactFont
  bodySizePt: number
  titleSizePt: number
  lineSpacing: number
  marginMm: number
  firstLineIndentChars: number
  includeCover: boolean
  includeToc: boolean
  pageNumbers: boolean
  headerText: string
  footerText: string
  accentColor: string
}
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
  /** 受控模板与排版参数；插件会再次归一化，不接受任意 CSS、宏或脚本。 */
  template?: ArtifactTemplate
  style?: ArtifactStyleInput
  /** format=pptx 时可选；缺失时兼容旧版，插件会从 Markdown 确定性分页。 */
  presentation?: PresentationSpecInput
  layout?: ArtifactLayout
  reason?: string
}

function presentationText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
}

function presentationItems(value: unknown, maxItems = 6): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => presentationText(item, 120))
    .filter(Boolean)
    .slice(0, maxItems)
}

function chinesePresentationCount(value: string): number | undefined {
  const normalized = value.normalize('NFKC').trim()
  if (/^\d{1,2}$/u.test(normalized)) {
    const count = Number(normalized)
    return Number.isInteger(count) && count >= 2 && count <= 40 ? count : undefined
  }
  const digits: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  }
  if (normalized === '十') return 10
  const match = normalized.match(/^([一二两三四])?十([一二三四五六七八九])?$/u)
  if (match) {
    const count = (match[1] ? digits[match[1]] : 1) * 10 + (match[2] ? digits[match[2]] : 0)
    return count >= 2 && count <= 40 ? count : undefined
  }
  return digits[normalized]
}

/**
 * 只提取“总共几页”的明确约束，不把“第 3 页改标题”误判成总页数。
 * 这是数值合同，不是意图词表：模型负责做 PPT，客户端只负责守住用户写明的数量。
 */
export function explicitPresentationSlideCount(text: string): number | undefined {
  const normalized = text.normalize('NFKC')
  const token = '(\\d{1,2}|[一二两三四五六七八九十]{1,3})'
  const beforeDeck = new RegExp(`${token}\\s*(?:页|张)(?:的)?\\s*(?:PPTX?|演示文稿|演示稿|幻灯片)`, 'iu')
  const afterDeck = new RegExp(`(?:PPTX?|演示文稿|演示稿|幻灯片)[^\\n。！？]{0,12}?${token}\\s*(?:页|张)`, 'iu')
  for (const pattern of [beforeDeck, afterDeck]) {
    const match = pattern.exec(normalized)
    if (!match) continue
    const tokenIndex = match.index + match[0].indexOf(match[1])
    if (tokenIndex > 0 && normalized[tokenIndex - 1] === '第') continue
    const count = chinesePresentationCount(match[1])
    if (count !== undefined) return count
  }
  return undefined
}

function declaredPresentationSlideCount(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const count = (value as Record<string, unknown>).requestedSlideCount
  return typeof count === 'number' && Number.isInteger(count) && count >= 2 && count <= 40
    ? count
    : undefined
}

/** 返回给模型的可操作纠正原因；undefined 表示页数合同满足。 */
export function presentationSlideCountProblem(
  question: string,
  operation: Pick<CreateArtifactOperation, 'format' | 'presentation'>,
): string | undefined {
  if (operation.format !== 'pptx') return undefined
  const requested = explicitPresentationSlideCount(question) ?? declaredPresentationSlideCount(operation.presentation)
  if (requested === undefined) return undefined
  const rawPresentation = operation.presentation && typeof operation.presentation === 'object' && !Array.isArray(operation.presentation)
    ? operation.presentation as Record<string, unknown>
    : null
  const sanitized = rawPresentation
    ? normalizePresentationSpec({ ...rawPresentation, requestedSlideCount: undefined })
    : undefined
  const actual = sanitized?.slides.length ?? 0
  if (actual === requested) return undefined
  return `用户明确要求 ${requested} 页 PPT，但当前页面设计稿是 ${actual} 页。请重新提交恰好 ${requested} 个完整 slides；不要让用户再次说明。`
}

function presentationDetailLength(...values: string[]): number {
  return Array.from(values.join('')).filter((character) => !/\s/u.test(character)).length
}

/**
 * PPT 内容密度的本机硬门禁。Luna 可以自由组织观点，但不能用三个栏目词
 * 冒充一页可交付课件。封面、结尾和金句页允许极简；信息页必须给出解释、
 * 步骤、对比或指标的实质内容。这是结构质量检查，不会为了填字而改变页数。
 */
export function presentationContentProblem(
  operation: Pick<CreateArtifactOperation, 'format' | 'presentation'>,
): string | undefined {
  if (operation.format !== 'pptx' || operation.presentation === undefined) return undefined
  const spec = normalizePresentationSpec(operation.presentation)
  if (!spec) return undefined
  for (const [index, slide] of spec.slides.entries()) {
    const page = index + 1
    if (slide.layout === 'cover' || slide.layout === 'closing' || slide.layout === 'statement') continue
    if (slide.layout === 'quote') {
      if (presentationDetailLength(slide.quote, slide.body) >= 6) continue
      return `PPT 第 ${page} 页是引语页，但引语与说明过少。请补成一个可独立理解的观点，保持总页数不变。`
    }
    if (slide.layout === 'content') {
      const detail = presentationDetailLength(slide.body, ...slide.items)
      if (detail >= 48 && (presentationDetailLength(slide.body) >= 18 || slide.items.length >= 2)) continue
      return `PPT 第 ${page} 页只有标题或少量提纲，不足以讲清。请补充具体解释、例子或行动要点，保持总页数不变。`
    }
    if (slide.layout === 'cards' || slide.layout === 'process') {
      const detail = presentationDetailLength(...slide.items)
      if (slide.items.length >= 3 && detail >= 54 && slide.items.every((item) => presentationDetailLength(item) >= 8)) continue
      return `PPT 第 ${page} 页的${slide.layout === 'process' ? '步骤' : '卡片'}过于空洞。请至少给出 3 个可执行、可理解的完整要点，保持总页数不变。`
    }
    if (slide.layout === 'comparison') {
      const detail = presentationDetailLength(...slide.leftItems, ...slide.rightItems)
      if (slide.leftItems.length >= 2 && slide.rightItems.length >= 2 && detail >= 64) continue
      return `PPT 第 ${page} 页的对比内容不完整。请为左右两侧各补至少 2 条有信息量的对比，保持总页数不变。`
    }
    if (slide.layout === 'metrics') {
      const detail = presentationDetailLength(...slide.metrics.flatMap((metric) => [metric.value, metric.label]))
      if (slide.metrics.length >= 3 && detail >= 18) continue
      return `PPT 第 ${page} 页的指标不足以形成完整信息。请补至少 3 个带明确含义的指标；无真实数据时改用其他版式，不得编数字。`
    }
  }
  return undefined
}

/** 二次归一化模型给出的 SlideSpec；空/非法页面会被移除。 */
export function normalizePresentationSpec(value: unknown): PresentationSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.slides)) return undefined
  const slides = record.slides
    .slice(0, 40)
    .map((raw): PresentationSlide | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const slide = raw as Record<string, unknown>
      const layout = PRESENTATION_LAYOUTS.includes(slide.layout as PresentationLayout)
        ? slide.layout as PresentationLayout
        : 'content'
      const headline = presentationText(slide.headline, 140)
      const quote = presentationText(slide.quote, 360)
      if (!headline && !quote) return null
      const metrics = Array.isArray(slide.metrics)
        ? slide.metrics.slice(0, 4).flatMap((metric) => {
            if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return []
            const item = metric as Record<string, unknown>
            const metricValue = presentationText(item.value, 32)
            const label = presentationText(item.label, 60)
            return metricValue && label ? [{ value: metricValue, label }] : []
          })
        : []
      const rawBody = typeof slide.body === 'string' ? slide.body : ''
      const bodyArrayItems = Array.isArray(slide.body)
        ? slide.body
            .map((item) => presentationText(item, 120))
            .filter((item) => presentationDetailLength(item) >= 8)
            .slice(0, layout === 'process' ? 4 : 6)
        : []
      let body = presentationText(rawBody, 420)
      let items = presentationItems(slide.items)
      // Luna 常把流程页写成 body 里的多行“定位：… / 内容：… / 转化：…”。
      // 流程/卡片模板真正渲染的是 items；本机在不改文字、不增页的前提下把
      // 3 行以上完整正文确定性转成卡片，避免把已有内容误判为空白并重复耗费轮次。
      if ((layout === 'process' || layout === 'cards') && items.length < 3) {
        const bodyItems = bodyArrayItems.length > 0
          ? bodyArrayItems
          : rawBody
          .split(/\r?\n|\\+n|(?=(?:定位|内容|转化|第一步|第二步|第三步|第四步|步骤[一二三四五六\d]+)[：:｜|])/u)
          .map((item) => presentationText(item, 120))
          .filter((item) => presentationDetailLength(item) >= 8)
          .slice(0, layout === 'process' ? 4 : 6)
        if (bodyItems.length >= 3) {
          items = bodyItems
          body = ''
        }
      }
      return {
        layout,
        kicker: presentationText(slide.kicker, 48),
        headline,
        body,
        items,
        leftTitle: presentationText(slide.leftTitle, 60),
        leftItems: presentationItems(slide.leftItems, 5),
        rightTitle: presentationText(slide.rightTitle, 60),
        rightItems: presentationItems(slide.rightItems, 5),
        metrics,
        quote,
        source: presentationText(slide.source, 100),
        notes: presentationText(slide.notes, 900),
      }
    })
    .filter((slide): slide is PresentationSlide => Boolean(slide))
  if (slides.length < 2) return undefined
  const requestedSlideCount = declaredPresentationSlideCount(record)
  if (requestedSlideCount !== undefined && slides.length !== requestedSlideCount) return undefined
  return {
    template: 'course-explainer',
    subtitle: presentationText(record.subtitle, 160),
    ...(requestedSlideCount !== undefined ? { requestedSlideCount } : {}),
    slides,
  }
}

const TEMPLATE_STYLES: Record<ArtifactTemplate, ResolvedArtifactStyle> = {
  general: {
    pageSize: 'a4', orientation: 'portrait', bodyFont: 'default', headingFont: 'default',
    bodySizePt: 11, titleSizePt: 26, lineSpacing: 1.5, marginMm: 19,
    firstLineIndentChars: 0, includeCover: false, includeToc: false, pageNumbers: true,
    headerText: '', footerText: 'AI霖子', accentColor: 'F39800',
  },
  'course-handout': {
    pageSize: 'a4', orientation: 'portrait', bodyFont: 'songti', headingFont: 'yahei',
    bodySizePt: 11, titleSizePt: 28, lineSpacing: 1.6, marginMm: 22,
    firstLineIndentChars: 2, includeCover: true, includeToc: true, pageNumbers: true,
    headerText: '课程讲义', footerText: 'AI霖子', accentColor: 'F39800',
  },
  'client-proposal': {
    pageSize: 'a4', orientation: 'portrait', bodyFont: 'yahei', headingFont: 'yahei',
    bodySizePt: 10.5, titleSizePt: 30, lineSpacing: 1.45, marginMm: 20,
    firstLineIndentChars: 0, includeCover: true, includeToc: true, pageNumbers: true,
    headerText: '客户方案', footerText: 'AI霖子', accentColor: '0057FF',
  },
  'business-report': {
    pageSize: 'a4', orientation: 'portrait', bodyFont: 'yahei', headingFont: 'yahei',
    bodySizePt: 10.5, titleSizePt: 27, lineSpacing: 1.4, marginMm: 18,
    firstLineIndentChars: 0, includeCover: false, includeToc: false, pageNumbers: true,
    headerText: '经营报告', footerText: 'AI霖子', accentColor: '0057FF',
  },
  'data-workbook': {
    pageSize: 'a4', orientation: 'landscape', bodyFont: 'yahei', headingFont: 'yahei',
    bodySizePt: 10, titleSizePt: 24, lineSpacing: 1.3, marginMm: 14,
    firstLineIndentChars: 0, includeCover: false, includeToc: false, pageNumbers: true,
    headerText: '', footerText: 'AI霖子', accentColor: '12B76A',
  },
  presentation: {
    pageSize: 'a4', orientation: 'landscape', bodyFont: 'yahei', headingFont: 'yahei',
    bodySizePt: 17, titleSizePt: 34, lineSpacing: 1.25, marginMm: 16,
    firstLineIndentChars: 0, includeCover: true, includeToc: false, pageNumbers: true,
    headerText: '', footerText: 'AI霖子', accentColor: 'F39800',
  },
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function boundedStyleText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // 页眉页脚只能是纯文本；控制字符会破坏 Office XML，超长文本会挤坏版式。
  return Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, 80)
}

export function normalizeArtifactTemplate(value: unknown): ArtifactTemplate {
  return typeof value === 'string' && ARTIFACT_TEMPLATES.includes(value as ArtifactTemplate)
    ? value as ArtifactTemplate
    : 'general'
}

export function normalizeArtifactStyle(
  value: unknown,
  templateValue: unknown = 'general',
  theme: ArtifactTheme = 'brand',
): ResolvedArtifactStyle {
  const template = normalizeArtifactTemplate(templateValue)
  const preset = TEMPLATE_STYLES[template]
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const pageSize = ARTIFACT_PAGE_SIZES.includes(record.pageSize as ArtifactPageSize)
    ? record.pageSize as ArtifactPageSize
    : preset.pageSize
  const orientation = ARTIFACT_ORIENTATIONS.includes(record.orientation as ArtifactOrientation)
    ? record.orientation as ArtifactOrientation
    : preset.orientation
  const bodyFont = ARTIFACT_FONTS.includes(record.bodyFont as ArtifactFont)
    ? record.bodyFont as ArtifactFont
    : preset.bodyFont
  const headingFont = ARTIFACT_FONTS.includes(record.headingFont as ArtifactFont)
    ? record.headingFont as ArtifactFont
    : preset.headingFont
  const accent = typeof record.accentColor === 'string' && /^#?[0-9a-f]{6}$/iu.test(record.accentColor.trim())
    ? record.accentColor.trim().replace(/^#/u, '').toUpperCase()
    : theme === 'clean' && template === 'general' ? '1F2937' : preset.accentColor
  return {
    pageSize,
    orientation,
    bodyFont,
    headingFont,
    bodySizePt: boundedNumber(record.bodySizePt, preset.bodySizePt, 9, 20),
    titleSizePt: boundedNumber(record.titleSizePt, preset.titleSizePt, 18, 40),
    lineSpacing: boundedNumber(record.lineSpacing, preset.lineSpacing, 1, 2),
    marginMm: boundedNumber(record.marginMm, preset.marginMm, 10, 40),
    firstLineIndentChars: boundedNumber(record.firstLineIndentChars, preset.firstLineIndentChars, 0, 2),
    includeCover: typeof record.includeCover === 'boolean' ? record.includeCover : preset.includeCover,
    includeToc: typeof record.includeToc === 'boolean' ? record.includeToc : preset.includeToc,
    pageNumbers: typeof record.pageNumbers === 'boolean' ? record.pageNumbers : preset.pageNumbers,
    headerText: boundedStyleText(record.headerText) ?? preset.headerText,
    footerText: boundedStyleText(record.footerText) ?? preset.footerText,
    accentColor: accent,
  }
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
        rows.push([
          ...cells,
          ...Array<string>(Math.max(0, headers.length - cells.length)).fill(''),
        ].slice(0, headers.length))
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
  if (format === 'xlsx') return 'Excel'
  return format.toUpperCase()
}

export function artifactTemplateLabel(templateValue: unknown): string {
  const template = normalizeArtifactTemplate(templateValue)
  return {
    general: '通用文档',
    'course-handout': '课程讲义',
    'client-proposal': '客户方案',
    'business-report': '经营报告',
    'data-workbook': '数据工作簿',
    presentation: '课程讲解模板',
  }[template]
}

export function artifactStyleSummary(operation: CreateArtifactOperation): string {
  const style = normalizeArtifactStyle(operation.style, operation.template, operation.theme ?? 'brand')
  if (operation.format === 'xlsx') return `${artifactTemplateLabel(operation.template)} · ${style.bodySizePt}pt · 冻结表头`
  if (operation.format === 'pptx') return `${artifactTemplateLabel(operation.template)} · 16:9 · ${style.titleSizePt}pt 标题`
  return `${artifactTemplateLabel(operation.template)} · ${style.pageSize.toUpperCase()} ${style.orientation === 'landscape' ? '横向' : '纵向'} · ${style.bodySizePt}pt`
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
    const presentation = normalizePresentationSpec(operation.presentation)
    if (presentation) return { label: '幻灯片', count: presentation.slides.length }
    const sectionCount = document.blocks.filter((block) => block.type === 'heading' && block.level <= 2).length
    return { label: '幻灯片', count: Math.max(1, sectionCount || Math.ceil(weightedChars / 420)) + 1 }
  }
  if (operation.format === 'xlsx') {
    const tableCount = document.blocks.filter((block) => block.type === 'table').length
    return { label: '工作表', count: tableCount + 1 }
  }
  if (operation.format === 'pdf') return { label: '页', count: Math.max(1, Math.ceil(weightedChars / 1_100)) }
  if (operation.format === 'docx') return { label: '页', count: Math.max(1, Math.ceil(weightedChars / 1_500)) }
  return { label: '章节', count: Math.max(1, document.blocks.filter((block) => block.type === 'heading').length) }
}

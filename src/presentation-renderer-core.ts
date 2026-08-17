export const PRESENTATION_FORMATS = ['html', 'pptx', 'pdf'] as const
export type PresentationFormat = (typeof PRESENTATION_FORMATS)[number]

export const PRESENTATION_MAX_SLIDES = 40
export const PRESENTATION_MAX_TITLE_CHARS = 160
export const PRESENTATION_MAX_TOTAL_CHARS = 60_000

export const PRESENTATION_SLIDE_TYPES = [
  'cover',
  'section',
  'statement',
  'bullets',
  'cards',
  'comparison',
  'process',
  'timeline',
  'metrics',
  'table',
  'quote',
  'closing',
] as const
export type PresentationSlideType = (typeof PRESENTATION_SLIDE_TYPES)[number]

export interface PresentationTheme {
  /** 主题名只用于确认卡与 HTML metadata，不参与任何代码执行。 */
  name?: string
  primary: string
  accent: string
  background: string
  surface: string
  text: string
  muted: string
  headingFont: string
  bodyFont: string
  /** rounded=现代圆角；square=克制直角。 */
  shape: 'rounded' | 'square'
}

export interface PresentationCard {
  title: string
  body?: string
  label?: string
}

export interface PresentationColumn {
  title: string
  items: string[]
}

export interface PresentationStep {
  title: string
  body?: string
}

export interface PresentationMetric {
  value: string
  label: string
  note?: string
}

export interface PresentationSlide {
  type: PresentationSlideType
  kicker?: string
  title: string
  subtitle?: string
  body?: string
  bullets?: string[]
  cards?: PresentationCard[]
  columns?: PresentationColumn[]
  steps?: PresentationStep[]
  metrics?: PresentationMetric[]
  table?: { headers: string[]; rows: string[][] }
  quote?: string
  attribution?: string
  footer?: string
}

export interface CreatePresentationOperation {
  type: 'create_presentation'
  /** 不含扩展名；插件会按 formats 派生同名 .html/.pptx/.pdf。 */
  basePath: string
  formats: PresentationFormat[]
  title: string
  subtitle?: string
  theme: PresentationTheme
  slides: PresentationSlide[]
  reason?: string
}

const PLATFORM_DEFAULT_FONT = typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
  ? 'Microsoft YaHei'
  : typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
    ? 'PingFang SC'
    : 'Noto Sans CJK SC'

export const DEFAULT_PRESENTATION_THEME: PresentationTheme = {
  name: 'AI霖子品牌',
  primary: '102544',
  accent: 'F39800',
  background: 'F7F2E8',
  surface: 'FFFFFF',
  text: '172033',
  muted: '667085',
  headingFont: PLATFORM_DEFAULT_FONT,
  bodyFont: PLATFORM_DEFAULT_FONT,
  shape: 'rounded',
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function color(value: unknown, fallback: string): string {
  const normalized = text(value, 12).replace(/^#/, '').toLocaleUpperCase()
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : fallback
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => text(item, maxChars)).filter(Boolean).slice(0, maxItems)
}

function objectList<T>(
  value: unknown,
  maxItems: number,
  parse: (record: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const item of value.slice(0, maxItems)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const parsed = parse(item as Record<string, unknown>)
    if (parsed) result.push(parsed)
  }
  return result
}

export function normalizePresentationTheme(value: unknown): PresentationTheme {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    name: text(record.name, 60) || DEFAULT_PRESENTATION_THEME.name,
    primary: color(record.primary, DEFAULT_PRESENTATION_THEME.primary),
    accent: color(record.accent, DEFAULT_PRESENTATION_THEME.accent),
    background: color(record.background, DEFAULT_PRESENTATION_THEME.background),
    surface: color(record.surface, DEFAULT_PRESENTATION_THEME.surface),
    text: color(record.text, DEFAULT_PRESENTATION_THEME.text),
    muted: color(record.muted, DEFAULT_PRESENTATION_THEME.muted),
    headingFont: text(record.headingFont, 64) || DEFAULT_PRESENTATION_THEME.headingFont,
    bodyFont: text(record.bodyFont, 64) || DEFAULT_PRESENTATION_THEME.bodyFont,
    shape: record.shape === 'square' ? 'square' : 'rounded',
  }
}

export function normalizePresentationSlide(value: unknown): PresentationSlide | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = text(record.type, 20) as PresentationSlideType
  const title = text(record.title, 180)
  if (!PRESENTATION_SLIDE_TYPES.includes(type) || !title) return null

  const cards = objectList(record.cards, 6, (item) => {
    const cardTitle = text(item.title, 100)
    return cardTitle ? {
      title: cardTitle,
      body: text(item.body, 260) || undefined,
      label: text(item.label, 40) || undefined,
    } : null
  })
  const columns = objectList(record.columns, 2, (item) => {
    const columnTitle = text(item.title, 100)
    const items = stringList(item.items, 8, 180)
    return columnTitle && items.length ? { title: columnTitle, items } : null
  })
  const steps = objectList(record.steps, 7, (item) => {
    const stepTitle = text(item.title, 100)
    return stepTitle ? { title: stepTitle, body: text(item.body, 220) || undefined } : null
  })
  const metrics = objectList(record.metrics, 6, (item) => {
    const valueText = text(item.value, 60)
    const label = text(item.label, 100)
    return valueText && label ? {
      value: valueText,
      label,
      note: text(item.note, 160) || undefined,
    } : null
  })
  let table: PresentationSlide['table']
  if (record.table && typeof record.table === 'object' && !Array.isArray(record.table)) {
    const tableRecord = record.table as Record<string, unknown>
    const headers = stringList(tableRecord.headers, 6, 80)
    const rows = Array.isArray(tableRecord.rows)
      ? tableRecord.rows.slice(0, 8).map((row) =>
          stringList(row, headers.length || 6, 140),
        ).filter((row) => row.length > 0)
      : []
    if (headers.length > 0 && rows.length > 0) {
      table = {
        headers,
        rows: rows.map((row) => [
          ...row,
          ...Array(Math.max(0, headers.length - row.length)).fill(''),
        ].slice(0, headers.length)),
      }
    }
  }

  const slide: PresentationSlide = {
    type,
    title,
    kicker: text(record.kicker, 80) || undefined,
    subtitle: text(record.subtitle, 260) || undefined,
    body: text(record.body, 700) || undefined,
    bullets: stringList(record.bullets, 8, 220),
    cards,
    columns,
    steps,
    metrics,
    table,
    quote: text(record.quote, 700) || undefined,
    attribution: text(record.attribution, 120) || undefined,
    footer: text(record.footer, 100) || undefined,
  }

  if (type === 'cards' && cards.length === 0) return null
  if (type === 'comparison' && columns.length !== 2) return null
  if ((type === 'process' || type === 'timeline') && steps.length < 2) return null
  if (type === 'metrics' && metrics.length === 0) return null
  if (type === 'table' && !table) return null
  if (type === 'quote' && !slide.quote) return null
  if (type === 'bullets' && (slide.bullets?.length ?? 0) === 0) return null
  return slide
}

export function presentationCharacterCount(operation: CreatePresentationOperation): number {
  return JSON.stringify({
    title: operation.title,
    subtitle: operation.subtitle,
    theme: operation.theme,
    slides: operation.slides,
  }).length
}

export function presentationFormatLabel(format: PresentationFormat): string {
  if (format === 'pptx') return 'PowerPoint'
  return format.toUpperCase()
}

export function resolvePresentationPaths(
  operation: Pick<CreatePresentationOperation, 'basePath' | 'formats'>,
  outputRoot: string,
): string[] {
  const normalizedRoot = outputRoot.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'AI霖子输出'
  const rawBase = operation.basePath.trim().replace(/\\/g, '/').replace(/\/+$/g, '')
  const base = rawBase.startsWith('$OUTPUT/')
    ? `${normalizedRoot}/${rawBase.slice('$OUTPUT/'.length)}`
    : rawBase === '$OUTPUT'
      ? normalizedRoot
      : rawBase
  return operation.formats.map((format) => `${base}.${format}`)
}

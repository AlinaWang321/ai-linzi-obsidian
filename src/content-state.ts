/**
 * AI霖子内容资产的统一 frontmatter 契约。
 *
 * 主内容阶段只描述“选题 → 草稿”；公众号、视频、小红书是并行渠道，
 * 必须分别记录，不能把所有状态塞进同一个线性字段。
 */

export type ContentKind = '选题' | '公众号文章'
export type ContentStage = '待写选题' | '已生成草稿'
export type WechatStatus = '未开始' | '已生成草稿' | '已发送公众号草稿箱' | '已正式发布'
export type VideoStatus = '未开始' | '已生成视频' | '视频已发布'
export type XiaohongshuStatus = '未开始' | '已生成小红书图文' | '小红书已发布'
export type BoardLane = 'topic' | 'write' | 'format' | 'draftbox' | 'published'

export interface RawContentMeta {
  path: string
  basename: string
  frontmatter?: Record<string, unknown> | null
  createdAt: number
  modifiedAt: number
  hasLocalImages: boolean
}

export interface ContentRecord {
  id: string
  title: string
  filePath: string
  kind: ContentKind
  contentStage: ContentStage
  wechatStatus: WechatStatus
  videoStatus: VideoStatus
  xiaohongshuStatus: XiaohongshuStatus
  sourceSkill: string
  createdDate: string
  draftDate: string
  wechatDraftDate: string
  wechatPublishedDate: string
  wechatUrl: string
  hasLocalImages: boolean
  modifiedAt: number
}

/** 看板只读取插件自己的产出根目录，避免把学员整个 Vault 的普通笔记误判成内容资产。 */
export function isInsideOutputFolder(path: string, outputFolder: string): boolean {
  const clean = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const filePath = clean(path)
  const root = clean(outputFolder)
  return Boolean(root && (filePath === root || filePath.startsWith(`${root}/`)))
}

/** 排除配图提示词等辅助文件；文章图片可以存在这里，但这些 Markdown 不是内容卡片。 */
export function isDashboardContentPath(path: string, outputFolder: string): boolean {
  if (!isInsideOutputFolder(path, outputFolder)) return false
  const clean = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const relative = clean(path).slice(clean(outputFolder).length).replace(/^\//, '')
  return !/^公众号文章\/配图(?:\/|$)/.test(relative)
}

function text(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localDate(value)
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

function localDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

export function normalizeDate(value: unknown): string {
  const raw = text(value)
  const match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(raw)
  if (!match) return ''
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
}

function dateFromFilename(basename: string): string {
  return normalizeDate(basename.replace(/_/g, ' '))
}

function inferKind(meta: RawContentMeta): ContentKind | null {
  const fm = meta.frontmatter ?? {}
  const explicit = text(fm['内容类型'])
  const skill = text(fm['来源技能'])
  const platform = text(fm['平台'])
  if (explicit === '选题' || /选题雷达/.test(skill)) return '选题'
  if (
    explicit === '公众号文章' ||
    platform === '公众号' ||
    /公众号写作|访谈写作/.test(skill) ||
    /公众号文章/.test(meta.path)
  ) {
    return '公众号文章'
  }
  return null
}

function inferWechatStatus(meta: RawContentMeta, kind: ContentKind): WechatStatus {
  const fm = meta.frontmatter ?? {}
  const explicit = text(fm['公众号状态'])
  const legacy = text(fm['状态'])
  if (explicit === '已正式发布' || /已发布/.test(legacy) || /公众号文章\/已发布/.test(meta.path)) {
    return '已正式发布'
  }
  if (
    explicit === '已发送公众号草稿箱' ||
    /草稿箱/.test(explicit) ||
    /已进草稿箱|已发送公众号草稿箱/.test(legacy)
  ) {
    return '已发送公众号草稿箱'
  }
  if (explicit === '已生成草稿' || kind === '公众号文章') return '已生成草稿'
  return '未开始'
}

function inferContentStage(meta: RawContentMeta, kind: ContentKind): ContentStage {
  const fm = meta.frontmatter ?? {}
  const explicit = text(fm['内容阶段'])
  const legacy = text(fm['状态'])
  if (explicit === '已生成草稿' || kind === '公众号文章' || /已生成草稿|草稿箱|已发布/.test(legacy)) {
    return '已生成草稿'
  }
  return '待写选题'
}

function inferVideoStatus(fm: Record<string, unknown>): VideoStatus {
  const value = text(fm['视频状态'])
  if (value === '视频已发布') return value
  if (value === '已生成视频') return value
  return '未开始'
}

function inferXiaohongshuStatus(fm: Record<string, unknown>): XiaohongshuStatus {
  const value = text(fm['小红书状态'])
  if (value === '小红书已发布') return value
  if (value === '已生成小红书图文') return value
  return '未开始'
}

export function deriveContentRecord(meta: RawContentMeta): ContentRecord | null {
  const fm = meta.frontmatter ?? {}
  const kind = inferKind(meta)
  if (!kind) return null
  const fallbackDate = dateFromFilename(meta.basename) || localDate(new Date(meta.createdAt))
  const createdDate =
    normalizeDate(fm['创建日期']) || normalizeDate(fm['日期']) || fallbackDate
  const draftDate = normalizeDate(fm['草稿日期']) || (kind === '公众号文章' ? createdDate : '')
  const title = text(fm['title']) || meta.basename.replace(/^\d{4}[.-]\d{2}[.-]\d{2}_/, '')
  return {
    id: text(fm['内容ID']) || meta.path,
    title,
    filePath: meta.path,
    kind,
    contentStage: inferContentStage(meta, kind),
    wechatStatus: inferWechatStatus(meta, kind),
    videoStatus: inferVideoStatus(fm),
    xiaohongshuStatus: inferXiaohongshuStatus(fm),
    sourceSkill: text(fm['来源技能']) || (kind === '选题' ? '选题' : '公众号文章'),
    createdDate,
    draftDate,
    wechatDraftDate: normalizeDate(fm['公众号草稿箱时间']) || normalizeDate(fm['草稿箱时间']),
    wechatPublishedDate: normalizeDate(fm['公众号发布日期']) || normalizeDate(fm['发布日期']),
    wechatUrl: text(fm['公众号链接']) || text(fm['发布链接']),
    hasLocalImages: meta.hasLocalImages,
    modifiedAt: meta.modifiedAt,
  }
}

export function boardLane(record: ContentRecord): BoardLane | null {
  if (record.wechatStatus === '已正式发布') return 'published'
  if (record.wechatStatus === '已发送公众号草稿箱') return 'draftbox'
  if (record.kind === '选题') return record.contentStage === '待写选题' ? 'topic' : null
  return record.hasLocalImages ? 'format' : 'write'
}

export function parseLocalDate(value: string): Date | null {
  const normalized = normalizeDate(value)
  if (!normalized) return null
  const [year, month, day] = normalized.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

export function startOfWeek(date: Date): Date {
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = out.getDay() || 7
  out.setDate(out.getDate() - weekday + 1)
  return out
}

export function isDateInRange(value: string, start: Date, endExclusive: Date): boolean {
  const date = parseLocalDate(value)
  return Boolean(date && date >= start && date < endExclusive)
}

export function canonicalContentFields(args: {
  skill: string
  platform: string
  date: string
  contentId: string
}): Record<string, string> | null {
  if (/选题雷达/.test(args.skill)) {
    return {
      内容ID: args.contentId,
      内容类型: '选题',
      内容阶段: '待写选题',
      公众号状态: '未开始',
      视频状态: '未开始',
      小红书状态: '未开始',
      创建日期: args.date,
    }
  }
  if (args.platform === '公众号' || /公众号写作|访谈写作/.test(args.skill)) {
    return {
      内容ID: args.contentId,
      内容类型: '公众号文章',
      内容阶段: '已生成草稿',
      公众号状态: '已生成草稿',
      视频状态: '未开始',
      小红书状态: '未开始',
      创建日期: args.date,
      草稿日期: args.date,
    }
  }
  return null
}

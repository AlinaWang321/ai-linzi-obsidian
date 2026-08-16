/**
 * AI霖子内容资产的统一 frontmatter 契约。
 *
 * 内容阶段只描述创作进度；公众号、小红书、视频号、抖音是并行分发渠道。
 * 所有状态和数据都留在用户 Vault 的 frontmatter 中，不建立云端内容数据库。
 */

export type ContentKind = '选题' | '公众号文章' | '小红书图文' | '口播稿' | '朋友圈文案' | '其他内容'
export type ContentStage = '待写选题' | '已生成草稿' | '制作中'
export type WechatStatus = '不适用' | '未开始' | '计划中' | '已生成草稿' | '已发送公众号草稿箱' | '已正式发布'
export type VideoStatus = '不适用' | '未开始' | '计划中' | '已生成视频' | '视频已发布'
export type XiaohongshuStatus = '不适用' | '未开始' | '计划中' | '已生成小红书图文' | '小红书已发布'
export type DouyinStatus = '不适用' | '未开始' | '计划中' | '已生成抖音内容' | '抖音已发布'
export type BoardLane = 'topic' | 'write' | 'format' | 'draftbox' | 'published'
export type PipelineLane = 'topic' | 'draft' | 'production' | 'distribution' | 'done'
export type PlatformId = 'wechat' | 'xiaohongshu' | 'shipinhao' | 'douyin'
export type DistributionStage = 'not-applicable' | 'unplanned' | 'planned' | 'ready' | 'published'

export const PLATFORM_IDS: PlatformId[] = ['wechat', 'xiaohongshu', 'shipinhao', 'douyin']

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  wechat: '公众号',
  xiaohongshu: '小红书',
  shipinhao: '视频号',
  douyin: '抖音',
}

export interface PlatformState {
  id: PlatformId
  stage: DistributionStage
  generatedDate: string
  publishedDate: string
  url: string
  views: number
  engagement: number
  followersGained: number
}

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
  sourcePath: string
  relatedFiles: string[]
  kind: ContentKind
  contentStage: ContentStage
  wechatStatus: WechatStatus
  videoStatus: VideoStatus
  xiaohongshuStatus: XiaohongshuStatus
  douyinStatus: DouyinStatus
  platforms: Record<PlatformId, PlatformState>
  sourceSkill: string
  createdDate: string
  draftDate: string
  wechatDraftDate: string
  wechatPublishedDate: string
  wechatUrl: string
  xiaohongshuGeneratedDate: string
  xiaohongshuPublishedDate: string
  xiaohongshuNotePath: string
  xiaohongshuCardFolder: string
  xiaohongshuZipPath: string
  hasLocalImages: boolean
  contentMetrics: Partial<Record<PlatformId, Pick<PlatformState, 'views' | 'engagement' | 'followersGained'>>>
  modifiedAt: number
}

/** 看板只读取插件自己的产出根目录，避免把学员整个 Vault 的普通笔记误判成内容资产。 */
export function isInsideOutputFolder(path: string, outputFolder: string): boolean {
  const clean = cleanPath(path)
  const root = cleanPath(outputFolder)
  return Boolean(root && (clean === root || clean.startsWith(`${root}/`)))
}

/**
 * 内容看板只统计三类可发布内容：公众号文章、口播脚本、小红书。
 * 其他 AI霖子输出（选题、朋友圈、销售复盘、客户档案等）不属于内容看板口径。
 */
export function isDashboardContentPath(path: string, outputFolder: string): boolean {
  if (!isInsideOutputFolder(path, outputFolder)) return false
  const relative = cleanPath(path).slice(cleanPath(outputFolder).length).replace(/^\//, '')
  if (/^公众号文章\/配图(?:\/|$)/.test(relative)) return false
  return /^(?:公众号文章|口播脚本|小红书)(?:\/|$)/.test(relative)
}

function cleanPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function text(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localDate(value)
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') continue
    const normalized = value.replace(/[,，\s]/g, '').replace(/万$/, '0000')
    const parsed = Number.parseFloat(normalized)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
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

function stripWikiLink(value: string): string {
  const match = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(value.trim())
  return cleanPath(match?.[1] ?? value)
}

function inferKind(meta: RawContentMeta): ContentKind | null {
  const fm = meta.frontmatter ?? {}
  const explicit = text(fm['内容类型'])
  const skill = text(fm['来源技能'])
  const platform = text(fm['平台'])
  if (explicit === '内容看板数据') return null
  if (explicit === '选题' || /选题雷达/.test(skill)) return '选题'
  if (explicit === '公众号文章' || platform === '公众号' || /公众号写作|访谈写作/.test(skill) || /公众号文章/.test(meta.path)) {
    return '公众号文章'
  }
  if (/小红书/.test(explicit) || platform === '小红书' || /小红书/.test(skill) || /\/小红书\//.test(meta.path)) {
    return '小红书图文'
  }
  if (/口播|视频/.test(explicit) || /口播|视频号|抖音/.test(platform) || /口播/.test(meta.path)) return '口播稿'
  if (/朋友圈/.test(explicit) || platform === '朋友圈' || /朋友圈/.test(meta.path)) return '朋友圈文案'
  if (explicit || platform) return '其他内容'
  return null
}

function inferWechatStatus(meta: RawContentMeta, kind: ContentKind): WechatStatus {
  const fm = meta.frontmatter ?? {}
  const explicit = text(fm['公众号状态'])
  const legacy = text(fm['状态'])
  if (explicit === '不适用') return explicit
  if (explicit === '计划中') return explicit
  if (explicit === '已正式发布' || /已发布/.test(legacy) || /公众号文章\/已发布/.test(meta.path)) return '已正式发布'
  if (explicit === '已发送公众号草稿箱' || /草稿箱/.test(explicit) || /已进草稿箱|已发送公众号草稿箱/.test(legacy)) {
    return '已发送公众号草稿箱'
  }
  if (explicit === '已生成草稿' || kind === '公众号文章') return '已生成草稿'
  return '未开始'
}

function inferContentStage(meta: RawContentMeta, kind: ContentKind): ContentStage {
  const fm = meta.frontmatter ?? {}
  const explicit = text(fm['内容阶段'])
  const legacy = text(fm['状态'])
  if (explicit === '制作中') return explicit
  if (explicit === '已生成草稿' || kind !== '选题' || /已生成草稿|草稿箱|已发布/.test(legacy)) return '已生成草稿'
  return '待写选题'
}

function inferVideoStatus(fm: Record<string, unknown>): VideoStatus {
  const value = text(fm['视频号状态']) || text(fm['视频状态'])
  if (value === '不适用' || value === '计划中' || value === '视频已发布' || value === '已生成视频') return value
  return '未开始'
}

function inferXiaohongshuStatus(fm: Record<string, unknown>, kind: ContentKind): XiaohongshuStatus {
  const value = text(fm['小红书状态'])
  if (value === '不适用' || value === '计划中' || value === '小红书已发布' || value === '已生成小红书图文') return value
  return kind === '小红书图文' ? '已生成小红书图文' : '未开始'
}

function inferDouyinStatus(fm: Record<string, unknown>, kind: ContentKind, platform: string): DouyinStatus {
  const value = text(fm['抖音状态'])
  if (value === '不适用' || value === '计划中' || value === '抖音已发布' || value === '已生成抖音内容') return value
  return kind === '口播稿' && platform === '抖音' ? '已生成抖音内容' : '未开始'
}

function distributionStage(value: string, ready: string[], published: string[]): DistributionStage {
  if (value === '不适用') return 'not-applicable'
  if (published.includes(value)) return 'published'
  if (ready.includes(value)) return 'ready'
  if (value === '计划中') return 'planned'
  return 'unplanned'
}

function stateFor(
  id: PlatformId,
  stage: DistributionStage,
  fm: Record<string, unknown>,
  generatedDate: string,
  publishedDate: string,
  url: string,
): PlatformState {
  const label = PLATFORM_LABELS[id]
  const viewLabel = id === 'wechat' || id === 'xiaohongshu' ? '阅读' : '播放'
  return {
    id,
    stage,
    generatedDate,
    publishedDate,
    url,
    views: numberValue(fm[`${label}${viewLabel}`], fm[`${label}${viewLabel}量`]),
    engagement: numberValue(fm[`${label}互动`], fm[`${label}赞藏`], fm[`${label}点赞`]),
    followersGained: numberValue(fm[`${label}涨粉`], fm[`${label}新增粉丝`]),
  }
}

function cleanTitle(value: string): string {
  return value
    .replace(/^(?:小红书图文|小红书|口播逐字稿|口播稿|朋友圈文案)_/, '')
    .replace(/^\d{4}[.-]\d{2}[.-]\d{2}_/, '')
}

export function deriveContentRecord(meta: RawContentMeta): ContentRecord | null {
  const fm = meta.frontmatter ?? {}
  const kind = inferKind(meta)
  if (!kind) return null
  const fallbackDate = dateFromFilename(meta.basename) || localDate(new Date(meta.createdAt))
  const createdDate = normalizeDate(fm['创建日期']) || normalizeDate(fm['日期']) || fallbackDate
  const draftDate = normalizeDate(fm['草稿日期']) || (kind === '公众号文章' ? createdDate : '')
  const title = cleanTitle(text(fm['title']) || meta.basename)
  const sourcePath = stripWikiLink(text(fm['来源路径']))
  const wechatStatus = inferWechatStatus(meta, kind)
  const videoStatus = inferVideoStatus(fm)
  const xiaohongshuStatus = inferXiaohongshuStatus(fm, kind)
  const douyinStatus = inferDouyinStatus(fm, kind, text(fm['平台']))
  const wechatGeneratedDate = draftDate
  const wechatPublishedDate = normalizeDate(fm['公众号发布日期']) || normalizeDate(fm['发布日期'])
  const xiaohongshuGeneratedDate = normalizeDate(fm['小红书生成时间']) || (kind === '小红书图文' ? createdDate : '')
  const xiaohongshuPublishedDate = normalizeDate(fm['小红书发布日期']) || (kind === '小红书图文' ? normalizeDate(fm['发布日期']) : '')
  const videoGeneratedDate = normalizeDate(fm['视频号生成时间']) || normalizeDate(fm['视频生成时间']) || (kind === '口播稿' ? createdDate : '')
  const videoPublishedDate = normalizeDate(fm['视频号发布日期']) || normalizeDate(fm['视频发布日期'])
  const douyinGeneratedDate = normalizeDate(fm['抖音生成时间']) || (kind === '口播稿' && text(fm['平台']) === '抖音' ? createdDate : '')
  const douyinPublishedDate = normalizeDate(fm['抖音发布日期'])
  const platforms: Record<PlatformId, PlatformState> = {
    wechat: stateFor(
      'wechat',
      distributionStage(wechatStatus, ['已生成草稿', '已发送公众号草稿箱'], ['已正式发布']),
      fm,
      wechatGeneratedDate,
      wechatPublishedDate,
      text(fm['公众号链接']) || (kind === '公众号文章' ? text(fm['发布链接']) : ''),
    ),
    xiaohongshu: stateFor(
      'xiaohongshu',
      distributionStage(xiaohongshuStatus, ['已生成小红书图文'], ['小红书已发布']),
      fm,
      xiaohongshuGeneratedDate,
      xiaohongshuPublishedDate,
      text(fm['小红书链接']) || (kind === '小红书图文' ? text(fm['发布链接']) : ''),
    ),
    shipinhao: stateFor(
      'shipinhao',
      distributionStage(videoStatus, ['已生成视频'], ['视频已发布']),
      fm,
      videoGeneratedDate,
      videoPublishedDate,
      text(fm['视频号链接']) || text(fm['视频链接']),
    ),
    douyin: stateFor(
      'douyin',
      distributionStage(douyinStatus, ['已生成抖音内容'], ['抖音已发布']),
      fm,
      douyinGeneratedDate,
      douyinPublishedDate,
      text(fm['抖音链接']),
    ),
  }
  return {
    id: text(fm['内容ID']) || sourcePath || meta.path,
    title,
    filePath: meta.path,
    sourcePath,
    relatedFiles: [meta.path],
    kind,
    contentStage: inferContentStage(meta, kind),
    wechatStatus,
    videoStatus,
    xiaohongshuStatus,
    douyinStatus,
    platforms,
    sourceSkill: text(fm['来源技能']) || (kind === '选题' ? '选题' : text(fm['平台']) || kind),
    createdDate,
    draftDate,
    wechatDraftDate: normalizeDate(fm['公众号草稿箱时间']) || normalizeDate(fm['草稿箱时间']),
    wechatPublishedDate,
    wechatUrl: platforms.wechat.url,
    xiaohongshuGeneratedDate,
    xiaohongshuPublishedDate,
    xiaohongshuNotePath: text(fm['小红书笔记']) || (kind === '小红书图文' ? meta.path : ''),
    xiaohongshuCardFolder: text(fm['小红书卡片目录']),
    xiaohongshuZipPath: text(fm['小红书卡片ZIP']),
    hasLocalImages: meta.hasLocalImages,
    contentMetrics: Object.fromEntries(
      PLATFORM_IDS.filter((id) => platforms[id].views > 0 || platforms[id].engagement > 0 || platforms[id].followersGained > 0).map((id) => [
        id,
        {
          views: platforms[id].views,
          engagement: platforms[id].engagement,
          followersGained: platforms[id].followersGained,
        },
      ]),
    ),
    modifiedAt: meta.modifiedAt,
  }
}

const KIND_PRIORITY: Record<ContentKind, number> = {
  公众号文章: 6,
  选题: 5,
  口播稿: 4,
  小红书图文: 3,
  朋友圈文案: 2,
  其他内容: 1,
}

const STAGE_PRIORITY: Record<DistributionStage, number> = {
  'not-applicable': 0,
  unplanned: 1,
  planned: 2,
  ready: 3,
  published: 4,
}

function mergePlatform(left: PlatformState, right: PlatformState): PlatformState {
  const preferred = STAGE_PRIORITY[right.stage] > STAGE_PRIORITY[left.stage] ? right : left
  return {
    ...preferred,
    generatedDate: preferred.generatedDate || left.generatedDate || right.generatedDate,
    publishedDate: preferred.publishedDate || left.publishedDate || right.publishedDate,
    url: preferred.url || left.url || right.url,
    views: Math.max(left.views, right.views),
    engagement: Math.max(left.engagement, right.engagement),
    followersGained: Math.max(left.followersGained, right.followersGained),
  }
}

/** 把同一来源文章生成的小红书、口播等衍生笔记合并为一行内容资产。 */
export function aggregateContentRecords(records: ContentRecord[]): ContentRecord[] {
  const aliases = new Map<string, string>()
  for (const record of records.filter((item) => !item.sourcePath)) {
    const key = cleanPath(record.id || record.filePath)
    aliases.set(cleanPath(record.filePath), key)
    aliases.set(key, key)
  }
  for (const record of records.filter((item) => item.sourcePath)) {
    const key = cleanPath(record.id || record.filePath)
    if (!aliases.has(cleanPath(record.filePath))) aliases.set(cleanPath(record.filePath), key)
    if (!aliases.has(key)) aliases.set(key, key)
  }
  const groups = new Map<string, ContentRecord>()
  for (const record of records) {
    const source = cleanPath(record.sourcePath)
    const key = (source && aliases.get(source)) || source || cleanPath(record.id || record.filePath)
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...record, relatedFiles: [...record.relatedFiles] })
      continue
    }
    const preferRecord = KIND_PRIORITY[record.kind] > KIND_PRIORITY[existing.kind]
    const primary = preferRecord ? record : existing
    const platforms = Object.fromEntries(
      PLATFORM_IDS.map((id) => [id, mergePlatform(existing.platforms[id], record.platforms[id])]),
    ) as Record<PlatformId, PlatformState>
    groups.set(key, {
      ...existing,
      ...(preferRecord
        ? {
            title: primary.title,
            filePath: primary.filePath,
            kind: primary.kind,
            contentStage: primary.contentStage,
            sourceSkill: primary.sourceSkill,
            createdDate: primary.createdDate,
            draftDate: primary.draftDate,
          }
        : {}),
      sourcePath: existing.sourcePath || record.sourcePath,
      relatedFiles: [...new Set([...existing.relatedFiles, ...record.relatedFiles])],
      platforms,
      wechatStatus: platforms.wechat.stage === 'published' ? '已正式发布' : existing.wechatStatus,
      videoStatus: platforms.shipinhao.stage === 'published' ? '视频已发布' : existing.videoStatus,
      xiaohongshuStatus: platforms.xiaohongshu.stage === 'published' ? '小红书已发布' : existing.xiaohongshuStatus,
      douyinStatus: platforms.douyin.stage === 'published' ? '抖音已发布' : existing.douyinStatus,
      hasLocalImages: existing.hasLocalImages || record.hasLocalImages,
      contentMetrics: { ...existing.contentMetrics, ...record.contentMetrics },
      modifiedAt: Math.max(existing.modifiedAt, record.modifiedAt),
    })
  }
  return [...groups.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** 兼容 CEO 驾驶舱旧的公众号五阶段统计。 */
export function boardLane(record: ContentRecord): BoardLane | null {
  if (record.wechatStatus === '已正式发布') return 'published'
  if (record.wechatStatus === '已发送公众号草稿箱') return 'draftbox'
  if (record.kind === '选题') return record.contentStage === '待写选题' ? 'topic' : null
  return record.hasLocalImages ? 'format' : 'write'
}

export function pipelineLane(record: ContentRecord): PipelineLane {
  const states = PLATFORM_IDS.map((id) => record.platforms[id].stage)
  const published = states.filter((stage) => stage === 'published').length
  const remaining = states.filter((stage) => stage === 'planned' || stage === 'ready').length
  if (published > 0 && remaining > 0) return 'distribution'
  if (published > 0) return 'done'
  if (record.kind === '选题' && record.contentStage === '待写选题') return 'topic'
  const channelProduction = record.platforms.xiaohongshu.stage === 'ready' || record.platforms.shipinhao.stage === 'ready' || record.platforms.douyin.stage === 'ready'
  if (record.hasLocalImages || record.contentStage === '制作中' || channelProduction) return 'production'
  return 'draft'
}

export function publishedDates(record: ContentRecord): string[] {
  return PLATFORM_IDS.map((id) => record.platforms[id].publishedDate).filter(Boolean)
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

export function consecutivePublishDays(records: ContentRecord[]): number {
  const dates = [...new Set(records.flatMap(publishedDates))].sort().reverse()
  if (dates.length === 0) return 0
  let streak = 1
  let cursor = parseLocalDate(dates[0])
  if (!cursor) return 0
  for (const value of dates.slice(1)) {
    const next = parseLocalDate(value)
    if (!next) continue
    const diff = Math.round((cursor.getTime() - next.getTime()) / 86_400_000)
    if (diff !== 1) break
    streak++
    cursor = next
  }
  return streak
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
      抖音状态: '未开始',
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
      抖音状态: '未开始',
      创建日期: args.date,
      草稿日期: args.date,
    }
  }
  return null
}

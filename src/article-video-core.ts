export const ARTICLE_VIDEO_DURATIONS = [30, 60, 90, 120] as const

/** 用户界面的固定名称；内部路由 slug 继续使用 article-to-video，避免破坏升级兼容。 */
export const ARTICLE_VIDEO_DISPLAY_NAME = '文章转短视频：当前文章➡️极简信息解说视频'

export type ArticleVideoDuration = (typeof ARTICLE_VIDEO_DURATIONS)[number]
export type ArticleVideoSceneType =
  | 'hook'
  | 'quote'
  | 'number'
  | 'comparison'
  | 'flow'
  | 'steps'
  | 'timeline'
  | 'summary'

export interface ArticleVideoScene {
  id: string
  type: ArticleVideoSceneType
  headline: string
  support?: string
  voiceover: string
  number?: string
  unit?: string
  left?: { label: string; value: string }
  right?: { label: string; value: string }
  items?: Array<{ title: string; detail?: string }>
}

export interface ArticleVideoStoryboard {
  title: string
  durationTarget: ArticleVideoDuration
  brand: {
    name: string
    background: string
    primary: string
    accent: string
  }
  scenes: ArticleVideoScene[]
}

export const ARTICLE_VIDEO_DEFAULT_BRAND = {
  name: 'AI霖子',
  background: '#FFFBEA',
  primary: '#173B6C',
  accent: '#F28C28',
} as const

const SCENE_TYPES = new Set<ArticleVideoSceneType>([
  'hook', 'quote', 'number', 'comparison', 'flow', 'steps', 'timeline', 'summary',
])

const DURATION_SCENE_RANGE: Record<ArticleVideoDuration, [number, number]> = {
  30: [5, 6],
  60: [5, 8],
  90: [7, 10],
  120: [9, 12],
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '')
}

/**
 * 官方内置 Article to Video 的本机快路由。只认明确的“文章/当前笔记 → 视频”动作，
 * 不拦截“修改这个 Skill / Article to Video 怎么设计”之类管理或咨询问题。
 */
export function isBuiltInArticleVideoIntent(text: string): boolean {
  const value = normalized(text)
  if (
    !value ||
    /(?:修改|更新|创建|安装|打包|导出|上架|开发).{0,10}(?:skill|技能)/iu.test(value) ||
    /(?:为什么|怎么|能不能|是否|有什么|介绍|说明).{0,12}(?:article[- ]?to[- ]?video|文章转短视频|文章.{0,6}短视频)/iu.test(value)
  ) return false
  const namesOfficialSkill = /(?:article[- ]?to[- ]?video|文章转短视频)/iu.test(value)
  const namesSource = /(?:当前|这篇|这份|打开的).{0,8}(?:文章|笔记|文档|内容)|(?:文章|笔记|文档).{0,8}(?:转|变|做|生成).{0,6}(?:短视频|视频)/u.test(value)
  const asksToRun = /(?:用|调用|运行|执行|处理|制作|生成|转成|变成|做成)/u.test(value)
  return asksToRun && namesSource && (namesOfficialSkill || /(?:文章|笔记|文档)/u.test(value))
}

export function articleVideoDurationFromText(text: string): ArticleVideoDuration {
  const value = normalized(text)
  if (/(?:2|两)分钟|120秒/u.test(value)) return 120
  if (/(?:1\.5|一分半|1分30秒)|90秒/u.test(value)) return 90
  if (/(?:半分钟|30秒)/u.test(value)) return 30
  if (/(?:1|一)分钟|60秒/u.test(value)) return 60
  return 60
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function item(value: unknown): { title: string; detail?: string } | null {
  if (typeof value === 'string') {
    const title = text(value, 36)
    return title ? { title } : null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const title = text(record.title ?? record.name ?? record.text, 36)
  const detail = text(record.detail ?? record.desc, 52)
  return title ? { title, ...(detail ? { detail } : {}) } : null
}

function side(value: unknown): { label: string; value: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const label = text(record.label, 20)
  const body = text(record.value, 44)
  return label && body ? { label, value: body } : undefined
}

function extractJsonObject(raw: string): unknown {
  const value = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(value.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseArticleVideoStoryboard(
  raw: string,
  expectedDuration: ArticleVideoDuration,
): ArticleVideoStoryboard | null {
  const parsed = extractJsonObject(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const title = text(record.title, 40)
  const rawScenes: unknown[] = Array.isArray(record.scenes) ? record.scenes as unknown[] : []
  const scenes: ArticleVideoScene[] = []
  const ids = new Set<string>()

  for (let index = 0; index < rawScenes.length; index += 1) {
    const value = rawScenes[index]
    if (!value || typeof value !== 'object') continue
    const scene = value as Record<string, unknown>
    const type = text(scene.type, 20) as ArticleVideoSceneType
    const headline = text(scene.headline, 36)
    const voiceover = text(scene.voiceover, 360)
    if (!SCENE_TYPES.has(type) || !headline || !voiceover) continue
    const proposedId = text(scene.id, 40).replace(/[^a-z0-9_-]/giu, '')
    const id = proposedId && !ids.has(proposedId) ? proposedId : `scene-${index + 1}`
    ids.add(id)
    const support = text(scene.support, 72)
    const items = (Array.isArray(scene.items) ? scene.items : [])
      .map(item)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, 4)
    const next: ArticleVideoScene = {
      id,
      type,
      headline,
      voiceover,
      ...(support ? { support } : {}),
    }
    const number = text(scene.number, 24)
    const unit = text(scene.unit, 16)
    if (number) next.number = number
    if (unit) next.unit = unit
    const left = side(scene.left)
    const right = side(scene.right)
    if (left) next.left = left
    if (right) next.right = right
    if (items.length > 0) next.items = items
    if (type === 'number' && !next.number) continue
    if (type === 'comparison' && (!next.left || !next.right)) continue
    if (['flow', 'steps', 'timeline', 'summary'].includes(type) && items.length < 2) continue
    scenes.push(next)
  }

  const [minScenes, maxScenes] = DURATION_SCENE_RANGE[expectedDuration]
  if (!title || scenes.length < minScenes || scenes.length > maxScenes) return null
  if (new Set(scenes.map((scene) => scene.type)).size < 3) return null
  if (scenes[0]?.type !== 'hook') return null
  return {
    title,
    durationTarget: expectedDuration,
    brand: { ...ARTICLE_VIDEO_DEFAULT_BRAND },
    scenes,
  }
}

export function safeArticleVideoName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%]/gu, '-')
    .replace(/\s+/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48) || '文章转短视频'
}

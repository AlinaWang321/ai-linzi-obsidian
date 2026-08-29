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

export const ARTICLE_VIDEO_SCENE_TYPE_LABELS: Record<ArticleVideoSceneType, string> = {
  hook: '开场钩子',
  quote: '金句',
  number: '数字重点',
  comparison: '对比',
  flow: '流程',
  steps: '步骤',
  timeline: '时间线',
  summary: '总结',
}

export const ARTICLE_VIDEO_HOMEBREW_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
export const ARTICLE_VIDEO_HOMEBREW_INSTALL_URL = 'https://brew.sh/zh-cn/'
export const ARTICLE_VIDEO_WINDOWS_APP_INSTALLER_URL = 'https://apps.microsoft.com/detail/9nblggh4nns1'
export const ARTICLE_VIDEO_NODE_INSTALL_URL = 'https://nodejs.org/zh-cn/download'
export const ARTICLE_VIDEO_FFMPEG_INSTALL_URL = 'https://ffmpeg.org/download.html'
export const ARTICLE_VIDEO_HYPERFRAMES_INSTALL_URL = 'https://www.npmjs.com/package/hyperframes'
export const ARTICLE_VIDEO_NODE_MIN_MAJOR = 22
export const ARTICLE_VIDEO_HYPERFRAMES_MIN_VERSION = '0.8.15'
export const ARTICLE_VIDEO_HYPERFRAMES_INSTALL_COMMAND = 'npm install --global hyperframes@latest'

export type ArticleVideoEnvironmentDependency = 'node' | 'ffmpeg' | 'hyperframes'

/**
 * 市场版只生成一份可复制给本机 AI 的安装任务，不在 Obsidian 内执行安装。
 * 版本策略写最低兼容线 + 最新稳定版，避免课程截图里的补丁版本日后过期。
 */
export function buildArticleVideoLocalAiInstallPrompt(input: {
  platform?: 'macos' | 'windows' | 'unsupported'
  missing?: ArticleVideoEnvironmentDependency[]
} = {}): string {
  const platform = input.platform === 'macos'
    ? 'macOS'
    : input.platform === 'windows'
      ? 'Windows'
      : '请先检测当前操作系统'
  const missing = input.missing?.length
    ? input.missing.map((item) => item === 'node'
      ? `Node.js >= ${ARTICLE_VIDEO_NODE_MIN_MAJOR}`
      : item === 'ffmpeg'
        ? 'FFmpeg（必须同时包含 FFprobe）'
        : `HyperFrames >= ${ARTICLE_VIDEO_HYPERFRAMES_MIN_VERSION}`).join('、')
    : `Node.js >= ${ARTICLE_VIDEO_NODE_MIN_MAJOR}、FFmpeg / FFprobe、HyperFrames >= ${ARTICLE_VIDEO_HYPERFRAMES_MIN_VERSION}`

  return [
    '请帮我为 Obsidian 的 AI霖子“文章转短视频”功能配置本机视频环境。',
    '',
    `当前系统提示：${platform}。当前缺少或版本不兼容：${missing}。`,
    '',
    '请按下面规则逐项完成：',
    `1. 先只读检测操作系统、CPU 架构、PATH、现有版本和可用包管理器；Node.js 的最低兼容版本是 ${ARTICLE_VIDEO_NODE_MIN_MAJOR}，HyperFrames 的最低兼容版本是 ${ARTICLE_VIDEO_HYPERFRAMES_MIN_VERSION}。`,
    '2. 已满足最低版本的依赖不要降级或重复安装；缺失或过旧时，优先通过官方来源/系统包管理器安装当前最新稳定版或最新 LTS，不要写死旧补丁版本。',
    '3. macOS 优先使用 Homebrew；Windows 优先使用 WinGet/微软 App Installer。FFmpeg 安装后必须同时能调用 ffmpeg 与 ffprobe。HyperFrames 使用 npm 全局安装最新稳定版。',
    '4. 每次需要管理员权限、sudo、修改系统 PATH 或安装系统软件前，先用中文告诉我将执行的准确命令、用途和影响，并等待我明确确认。不要关闭安全软件，不要执行来路不明的脚本。',
    '5. 不要卸载或更改无关软件，不要修改 Obsidian Vault 内的任何文件，也不要读取我的业务内容。',
    '6. 安装完成后逐项执行并展示验证结果：node --version、npm --version、ffmpeg -version、ffprobe -version、hyperframes --version。确认 Node.js 和 HyperFrames 达到上述最低版本。',
    '7. 如果某一步失败，先解释原因并给出安全的修复选项，不要跳过验证，也不要把“命令已运行”当成“安装成功”。',
    '8. 全部验证通过后，提醒我完全退出并重新打开 Obsidian，然后回到 AI霖子点击“安装完成，重新检测并继续”。',
  ].join('\n')
}

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

export type ArticleVideoReviewPhase =
  | 'draft'
  | 'revising'
  | 'superseded'
  | 'confirmed'
  | 'setup-required'
  | 'running'
  | 'cancelled'
  | 'failed'
  | 'complete'

export type ArticleVideoPlatform = 'macos' | 'windows' | 'unsupported'
export type ArticleVideoVoiceProvider = 'local' | 'fish'

export interface ArticleVideoPronunciationOverride {
  display: string
  spoken: string
}

export interface ArticleVideoLaunchOptions {
  projectName: string
  videoTitle: string
  theme: string
  voiceProvider: ArticleVideoVoiceProvider
}

export interface ArticleVideoSetupState {
  kind: 'fish-audio' | 'environment'
  platform?: ArticleVideoPlatform
  missing?: string[]
  message?: string
}

/**
 * 只保存在 Obsidian 本机会话中的脚本审稿状态。它不保存原文正文、API Key、
 * 绝对路径或终端输出；恢复时按 sourcePath + sourceHash 重新核对锁定文章。
 */
export interface ArticleVideoReviewState {
  kind: 'article-video-review'
  sourcePath: string
  sourceName: string
  sourceHash: string
  draftTarget: ArticleVideoDuration
  projectName: string
  theme: string
  voiceProvider: ArticleVideoVoiceProvider
  storyboard: ArticleVideoStoryboard
  revision: number
  phase: ArticleVideoReviewPhase
  pronunciations?: ArticleVideoPronunciationOverride[]
  setup?: ArticleVideoSetupState
  outputPath?: string
  error?: string
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

export function explicitArticleVideoDurationFromText(text: string): ArticleVideoDuration | undefined {
  const value = normalized(text)
  if (/(?:2|两)分钟|120秒/u.test(value)) return 120
  if (/(?:1\.5|一分半|1分30秒)|90秒/u.test(value)) return 90
  if (/(?:半分钟|30秒)/u.test(value)) return 30
  if (/(?:1|一)分钟|60秒/u.test(value)) return 60
  return undefined
}

export function articleVideoDurationFromText(text: string): ArticleVideoDuration {
  return explicitArticleVideoDurationFromText(text) ?? 60
}

export function articleVideoPlatform(value: string): ArticleVideoPlatform {
  if (value === 'darwin') return 'macos'
  if (value === 'win32') return 'windows'
  return 'unsupported'
}

export function isArticleVideoCancelIntent(text: string): boolean {
  const value = normalized(text)
  return /^(?:取消|停止|先不做了?|不做了?|结束)(?:视频|这个视频|这条视频|本次)?[。.!！]?$/u.test(value)
}

export type ArticleVideoPendingTurnAction = 'cancel' | 'confirm' | 'revise' | 'none'

/** 锁定脚本后的下一轮必须留在同一工作流；只有明确新任务才由上层另行路由。 */
export function articleVideoPendingTurnAction(
  text: string,
  phase: ArticleVideoReviewPhase,
): ArticleVideoPendingTurnAction {
  const value = text.normalize('NFKC').trim()
  if (!value || !['draft', 'failed', 'setup-required', 'complete'].includes(phase)) return 'none'
  if (isArticleVideoCancelIntent(value)) return 'cancel'
  if (/^(?:确认|可以|没问题|ok|okay|生成视频|开始生成|安装完成|配置完成|重新检测|继续生成)[。.!！]?$/iu.test(value)) {
    return 'confirm'
  }
  return 'revise'
}

/** 成片后只接管明确的视频修改，避免普通闲聊被长期锁在旧视频项目里。 */
export function isArticleVideoPostProductionRevisionIntent(text: string): boolean {
  const value = normalized(text)
  const namesVideoPart = /(?:视频|成片|脚本|配音|旁白|字幕|读音|发音|镜头|画面|转场|节奏|时长|第\s*\d+\s*幕|这一版|上一版)/u.test(value)
  const asksChange = /(?:修改|调整|改成|改为|重做|重制|重新生成|重新制作|再生成|再做|丰富|增加|减少|延长|缩短|读作|读成|继续)/u.test(value)
  const correctsPronunciation = /(?:读错|念错|发音错|应该读|应该念|读音(?:是|改)|发音(?:是|改))/u.test(value)
  const explicitlyContinues = /(?:继续|沿用|基于|按照).{0,16}(?:文章转短视频|上一版|前一版|前面|刚才|这个视频|该视频)/u.test(value)
    || /(?:文章转短视频).{0,16}(?:继续|修改|调整|重做|重制|重新生成|重新制作)/u.test(value)
  return (namesVideoPart && (asksChange || correctsPronunciation)) || correctsPronunciation || explicitlyContinues
}

function cleanPronunciationTerm(value: string): string {
  return value.normalize('NFKC').trim().replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/gu, '').trim()
}

/** 从用户明确的“字幕写 X、配音读 Y”中提取本机读音替换；不让模型改错可见文字。 */
export function extractArticleVideoPronunciationOverrides(text: string): ArticleVideoPronunciationOverride[] {
  const value = text.normalize('NFKC')
  const found: ArticleVideoPronunciationOverride[] = []
  const add = (displayValue: string | undefined, spokenValue: string | undefined) => {
    const display = cleanPronunciationTerm(displayValue ?? '')
    const spoken = cleanPronunciationTerm(spokenValue ?? '')
    if (!display || !spoken || display === spoken || display.length > 24 || spoken.length > 24 || /[\r\n]/u.test(`${display}${spoken}`)) return
    found.push({ display, spoken })
  }

  const namedCharacter = value.match(/([A-Za-z0-9\u3400-\u9fff]{2,24})的([\u3400-\u9fff]).{0,12}(?:读错|念错).{0,20}?(?:这个字)?(?:应该)?(?:读|念)(?:作|成|为)?[：:\s]*[“"「]?([\u3400-\u9fff])[”"」]?/u)
  if (namedCharacter) {
    const display = namedCharacter[1].replace(/^.*(?:配音|旁白|语音)(?:里|中)/u, '')
    add(display, display.replaceAll(namedCharacter[2], namedCharacter[3]))
  }

  const namedPhrase = value.match(/[“"「]?([A-Za-z0-9\u3400-\u9fff]{2,24})[”"」]?.{0,16}(?:配音|旁白|语音).{0,12}(?:统一)?(?:读|念)(?:作|成|为)[：:\s]*[“"「]?([A-Za-z0-9\u3400-\u9fff]{1,24})[”"」]?/u)
  if (namedPhrase) add(namedPhrase[1], namedPhrase[2])

  const subtitlePair = value.match(/字幕(?:上|里|中)?(?:仍然|仍|继续)?(?:显示|保留|写|是|用)?[：:\s]*[“"「]?([A-Za-z0-9\u3400-\u9fff]{1,24})[”"」]?.{0,24}(?:读音|配音|旁白)(?:是|改成|改为|读作|读成|念作|念成)?[：:\s]*[“"「]?([A-Za-z0-9\u3400-\u9fff]{1,24})[”"」]?/u)
  if (subtitlePair) add(subtitlePair[1], subtitlePair[2])

  const unique = new Map<string, ArticleVideoPronunciationOverride>()
  for (const item of found) unique.set(item.display, item)
  const sorted = [...unique.values()].sort((left, right) => right.display.length - left.display.length)
  return sorted.filter((item, index) => !sorted.some((larger, largerIndex) =>
    largerIndex < index && larger.display.includes(item.display) && larger.spoken.includes(item.spoken)))
}

export function mergeArticleVideoPronunciationOverrides(
  current: ArticleVideoPronunciationOverride[] | undefined,
  instruction: string,
): ArticleVideoPronunciationOverride[] {
  const merged = new Map<string, ArticleVideoPronunciationOverride>()
  for (const item of current ?? []) merged.set(item.display, item)
  for (const item of extractArticleVideoPronunciationOverrides(instruction)) merged.set(item.display, item)
  return [...merged.values()].sort((left, right) => right.display.length - left.display.length)
}

export function applyArticleVideoPronunciations(
  value: string,
  overrides: ArticleVideoPronunciationOverride[] | undefined,
): string {
  return [...(overrides ?? [])]
    .sort((left, right) => right.display.length - left.display.length)
    .reduce((result, item) => result.split(item.display).join(item.spoken), value)
}

function sceneVisualDetails(scene: ArticleVideoScene): string[] {
  if (scene.type === 'number') {
    return scene.number ? [`画面数字：${scene.number}${scene.unit ?? ''}`] : []
  }
  if (scene.type === 'comparison') {
    const sides = [scene.left, scene.right]
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => `${entry.label}：${entry.value}`)
    return sides.length > 0 ? [`画面对比：${sides.join('；')}`] : []
  }
  if ((scene.items?.length ?? 0) > 0) {
    return [`画面要点：${scene.items?.map((entry) =>
      `${entry.title}${entry.detail ? `（${entry.detail}）` : ''}`).join('；')}`]
  }
  return []
}

/** 主对话里的逐幕可读稿；不暴露内部 JSON，也不要求用户理解页型字段。 */
export function articleVideoStoryboardMarkdown(storyboard: ArticleVideoStoryboard): string {
  const narrationChars = storyboard.scenes
    .reduce((sum, scene) => sum + scene.voiceover.replace(/\s/gu, '').length, 0)
  const sections = storyboard.scenes.map((scene, index) => {
    const lines = [
      `### 第 ${index + 1} 幕｜${ARTICLE_VIDEO_SCENE_TYPE_LABELS[scene.type]}`,
      `- **屏幕主文案：** ${scene.headline}`,
      ...(scene.support ? [`- **辅助文案：** ${scene.support}`] : []),
      ...sceneVisualDetails(scene).map((line) => `- **${line.split('：')[0]}：** ${line.split('：').slice(1).join('：')}`),
      `- **旁白：** ${scene.voiceover}`,
    ]
    return lines.join('\n')
  })
  return [
    `## 视频脚本草稿｜${storyboard.title}`,
    `起草目标约 ${storyboard.durationTarget} 秒，当前共 ${storyboard.scenes.length} 幕、旁白约 ${narrationChars} 字。最终时长以确认后的真实配音为准。`,
    ...sections,
  ].join('\n\n')
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

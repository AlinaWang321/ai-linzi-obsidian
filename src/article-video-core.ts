export const ARTICLE_VIDEO_DURATIONS = [30, 60, 90, 120, 150, 180] as const
/** 真人克隆配音实测语速（四条横版成片折算），与私有后端的字数预算保持一致。 */
export const ARTICLE_VIDEO_NARRATION_CHARS_PER_SECOND = 5.2
export const ARTICLE_VIDEO_SOURCE_MAX_CHARS = 60_000
export const ARTICLE_VIDEO_SOURCE_EXTENSIONS = ['md', 'txt', 'pdf', 'docx'] as const

/** 竖版继续沿用 article-to-video；横版使用独立 slug，两个入口互不替换。 */
export const ARTICLE_VIDEO_DISPLAY_NAME = '文章转短视频（竖版）'
export const ARTICLE_VIDEO_HORIZONTAL_DISPLAY_NAME = '文章转短视频（横版）'

export type ArticleVideoFormat = 'vertical' | 'horizontal'

export function articleVideoDisplayName(format: ArticleVideoFormat = 'vertical'): string {
  return format === 'horizontal' ? ARTICLE_VIDEO_HORIZONTAL_DISPLAY_NAME : ARTICLE_VIDEO_DISPLAY_NAME
}

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
  eyebrow?: string
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

export interface ArticleVideoHorizontalChapter {
  title: string
  startScene: number
  endScene: number
}

function horizontalChapterKeyword(scene: ArticleVideoScene): string {
  const eyebrow = (scene.eyebrow ?? '').trim()
  const source = /[\u3400-\u9fff]/u.test(eyebrow) ? eyebrow : scene.headline
  const clause = source
    .normalize('NFKC')
    .replace(/^[“”"'「」《》【】\s]+/gu, '')
    .split(/[，。！？；：、｜|—-]/u)[0]
    ?.replace(/^(?:为什么|如何|不是|就是|从|把|先|再|当你|真正的?)/u, '')
    .replace(/\s+/gu, '')
  const compact = [...(clause || ARTICLE_VIDEO_SCENE_TYPE_LABELS[scene.type])].slice(0, 6).join('')
  return compact || ARTICLE_VIDEO_SCENE_TYPE_LABELS[scene.type]
}

/**
 * 横版底部只保留 3–5 个章节关键词，避免把每一幕都挤成难读的刻度。
 * 分组完全在本机完成，不增加模型调用，也不改变脚本确认流程。
 */
export function articleVideoHorizontalChapters(
  scenes: ArticleVideoScene[],
): ArticleVideoHorizontalChapter[] {
  if (scenes.length === 0) return []
  const chapterCount = scenes.length <= 6 ? 3 : scenes.length >= 10 ? 5 : 4
  const chapters: ArticleVideoHorizontalChapter[] = []
  const used = new Set<string>()
  for (let index = 0; index < chapterCount; index += 1) {
    const startScene = Math.floor(index * scenes.length / chapterCount)
    const endScene = Math.max(startScene, Math.floor((index + 1) * scenes.length / chapterCount) - 1)
    const candidates = scenes.slice(startScene, endScene + 1).reverse()
    let title = candidates.map(horizontalChapterKeyword).find((entry) => !used.has(entry))
      ?? horizontalChapterKeyword(scenes[startScene])
    if (used.has(title)) title = ARTICLE_VIDEO_SCENE_TYPE_LABELS[scenes[startScene].type]
    used.add(title)
    chapters.push({ title, startScene, endScene })
  }
  return chapters
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
  format: ArticleVideoFormat
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
  /** 旧会话没有该字段时按竖版恢复，避免破坏升级兼容。 */
  format?: ArticleVideoFormat
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

export function isArticleVideoSourceExtension(extension: string): boolean {
  return (ARTICLE_VIDEO_SOURCE_EXTENSIONS as readonly string[])
    .includes(extension.toLocaleLowerCase())
}

export const ARTICLE_VIDEO_DEFAULT_BRAND = {
  name: 'AI霖子',
  background: '#FFFBEA',
  primary: '#173B6C',
  accent: '#F28C28',
} as const

export const ARTICLE_VIDEO_HORIZONTAL_BRAND = {
  name: 'AI霖子',
  background: '#050B16',
  primary: '#0057FF',
  accent: '#F39800',
} as const

const SCENE_TYPES = new Set<ArticleVideoSceneType>([
  'hook', 'quote', 'number', 'comparison', 'flow', 'steps', 'timeline', 'summary',
])

const RENDERABLE_SCENE_RANGE: [number, number] = [5, 12]

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
  const namesCurrentSource = /(?:当前|这篇|这份|打开的).{0,8}(?:文章|笔记|文档|内容)/u.test(value)
  const asksForVideoConversion = /(?:文章|笔记|文档).{0,12}(?:转|变|做|生成).{0,8}(?:短视频|视频)/u.test(value)
  const asksToRun = /(?:用|调用|运行|执行|处理|制作|生成|转成|变成|做成)/u.test(value)
  // 不能因为一句话里同时有“处理 + 当前文档”就默认启动视频。显式点名的
  // consultation-client-workflow 等本地 Skill 必须继续进入本地 Skill 解析链。
  return asksToRun && (
    asksForVideoConversion || (namesOfficialSkill && namesCurrentSource)
  )
}

/** 未显式说横版时保持旧竖版默认；菜单入口会直接传入准确格式。 */
export function articleVideoFormatFromText(text: string): ArticleVideoFormat {
  const value = normalized(text)
  return /(?:横版|横屏|16[:：]9|16比9|宽屏)/u.test(value) ? 'horizontal' : 'vertical'
}

const CHINESE_DIGITS: Record<string, number> = {
  '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
}

function chineseNumber(raw: string): number | undefined {
  const value = raw.trim()
  if (!value) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value)
  if (value === '十') return 10
  const match = value.match(/^([一二两三四五六七八九])?十?([一二三四五六七八九])?$/u)
  if (!match || !/十/u.test(value)) {
    const single = CHINESE_DIGITS[value]
    return single === undefined ? undefined : single
  }
  return (match[1] ? CHINESE_DIGITS[match[1]] : 1) * 10 + (match[2] ? CHINESE_DIGITS[match[2]] : 0)
}

export function nearestArticleVideoDuration(seconds: number): ArticleVideoDuration {
  return [...ARTICLE_VIDEO_DURATIONS].reduce((best, candidate) =>
    Math.abs(candidate - seconds) < Math.abs(best - seconds) ? candidate : best)
}

const NUMBER = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十]+)'
const RANGE_JOIN = '(?:[-–—~～]|到|至|或)'

/**
 * 把“2-3分钟”“两分半”“三分钟”“1分30秒”“150秒”都折算成秒，再取最接近的支持档位。
 * 区间取中点：用户说 2–3 分钟时，按 150 秒起草最稳妥地落在区间内。
 * 旧版只认“2分钟/两分钟/120秒”，用户说“增加到 2-3 分钟”时目标仍停在 60 秒。
 */
export function explicitArticleVideoDurationFromText(text: string): ArticleVideoDuration | undefined {
  const value = normalized(text)
  if (!value) return undefined
  const minutesUnit = '分钟?'
  const patterns: Array<{ regex: RegExp; seconds: (match: RegExpMatchArray) => number | undefined }> = [
    {
      // 2分钟到3分钟 / 2-3分钟 / 两到三分钟 / 2～3分钟
      regex: new RegExp(`${NUMBER}(?:${minutesUnit})?${RANGE_JOIN}${NUMBER}${minutesUnit}`, 'u'),
      seconds: (match) => {
        const low = chineseNumber(match[1])
        const high = chineseNumber(match[2])
        return low !== undefined && high !== undefined ? ((low + high) / 2) * 60 : undefined
      },
    },
    {
      // 1分30秒 / 两分半 / 2分半钟
      regex: new RegExp(`${NUMBER}分(?:钟)?(?:(半)|${NUMBER}秒)`, 'u'),
      seconds: (match) => {
        const minutes = chineseNumber(match[1])
        if (minutes === undefined) return undefined
        if (match[2]) return minutes * 60 + 30
        const seconds = chineseNumber(match[3] ?? '')
        return seconds === undefined ? undefined : minutes * 60 + seconds
      },
    },
    {
      regex: /半分钟/u,
      seconds: () => 30,
    },
    {
      // 3分钟 / 三分钟 / 1.5分钟
      regex: new RegExp(`${NUMBER}${minutesUnit}`, 'u'),
      seconds: (match) => {
        const minutes = chineseNumber(match[1])
        return minutes === undefined ? undefined : minutes * 60
      },
    },
    {
      // 120秒 / 一百二十秒不支持，只认阿拉伯数字秒数
      regex: /(\d{2,3})秒/u,
      seconds: (match) => Number(match[1]),
    },
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern.regex)
    if (!match) continue
    const seconds = pattern.seconds(match)
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) continue
    return nearestArticleVideoDuration(seconds)
  }
  return undefined
}

export function articleVideoNarrationChars(storyboard: Pick<ArticleVideoStoryboard, 'scenes'>): number {
  return storyboard.scenes.reduce((sum, scene) => sum + scene.voiceover.replace(/\s/gu, '').length, 0)
}

export function estimateArticleVideoSeconds(narrationChars: number): number {
  return Math.round(narrationChars / ARTICLE_VIDEO_NARRATION_CHARS_PER_SECOND)
}

/** 与私有后端一致：目标秒数 × 实测语速，下限 92%。低于下限时成片必然短于目标。 */
export function articleVideoNarrationMinChars(duration: ArticleVideoDuration): number {
  return Math.round(duration * ARTICLE_VIDEO_NARRATION_CHARS_PER_SECOND * 0.92 / 5) * 5
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
  const narrationChars = articleVideoNarrationChars(storyboard)
  const estimatedSeconds = estimateArticleVideoSeconds(narrationChars)
  const minChars = articleVideoNarrationMinChars(storyboard.durationTarget)
  const lengthHint = narrationChars < minChars
    ? `⚠️ 旁白只有 ${narrationChars} 字，按真人配音语速预计约 ${estimatedSeconds} 秒，达不到 ${storyboard.durationTarget} 秒目标（至少需要约 ${minChars} 字）。可以直接回复“旁白扩写到 ${minChars} 字，补原文里的例子和做法”。`
    : `按真人配音语速预计约 ${estimatedSeconds} 秒。`
  const sections = storyboard.scenes.map((scene, index) => {
    const lines = [
      `### 第 ${index + 1} 幕｜${ARTICLE_VIDEO_SCENE_TYPE_LABELS[scene.type]}`,
      ...(scene.eyebrow ? [`- **章节提示：** ${scene.eyebrow}`] : []),
      `- **屏幕主文案：** ${scene.headline}`,
      ...(scene.support ? [`- **辅助文案：** ${scene.support}`] : []),
      ...sceneVisualDetails(scene).map((line) => `- **${line.split('：')[0]}：** ${line.split('：').slice(1).join('：')}`),
      `- **旁白：** ${scene.voiceover}`,
    ]
    return lines.join('\n')
  })
  return [
    `## 视频脚本草稿｜${storyboard.title}`,
    `起草目标约 ${storyboard.durationTarget} 秒，当前共 ${storyboard.scenes.length} 幕、旁白约 ${narrationChars} 字。${lengthHint}最终时长以确认后的真实配音为准。`,
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
    let type = text(scene.type, 20) as ArticleVideoSceneType
    const headline = text(scene.headline, 36)
    const voiceover = text(scene.voiceover, 360)
    if (!SCENE_TYPES.has(type) || !headline || !voiceover) continue
    const proposedId = text(scene.id, 40).replace(/[^a-z0-9_-]/giu, '')
    const id = proposedId && !ids.has(proposedId) ? proposedId : `scene-${index + 1}`
    ids.add(id)
    const support = text(scene.support, 72)
    const eyebrow = text(scene.eyebrow, 18)
    const items = (Array.isArray(scene.items) ? scene.items : [])
      .map(item)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, 4)
    const number = text(scene.number, 24)
    const unit = text(scene.unit, 16)
    const left = side(scene.left)
    const right = side(scene.right)
    const lacksTypePayload = (type === 'number' && !number)
      || (type === 'comparison' && (!left || !right))
      || (['flow', 'steps', 'timeline', 'summary'].includes(type) && items.length < 2)
    if (lacksTypePayload) type = 'quote'
    const next: ArticleVideoScene = {
      id,
      type,
      headline,
      voiceover,
      ...(eyebrow ? { eyebrow } : {}),
      ...(support ? { support } : {}),
    }
    if (type === 'number' && number) next.number = number
    if (type === 'number' && unit) next.unit = unit
    if (type === 'comparison' && left) next.left = left
    if (type === 'comparison' && right) next.right = right
    if (['flow', 'steps', 'timeline', 'summary'].includes(type) && items.length > 0) next.items = items
    scenes.push(next)
  }

  const [minScenes, maxScenes] = RENDERABLE_SCENE_RANGE
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

function articleVideoNumberVisualWeight(value: string): number {
  return [...value.trim()].reduce((total, character) => {
    if (/\p{Script=Han}/u.test(character)) return total + 1
    if (/[0-9]/u.test(character)) return total + 0.62
    if (/[-–—.→]/u.test(character)) return total + 0.45
    return total + 0.7
  }, 0)
}

export function articleVideoVerticalNumberLayout(value: string): { fontSize: number; wide: boolean } {
  const visualWeight = articleVideoNumberVisualWeight(value)
  return {
    fontSize: Math.max(88, Math.min(310, Math.floor(850 / Math.max(visualWeight, 1)))),
    wide: visualWeight > 3.2,
  }
}

export function articleVideoHorizontalNumberLayout(value: string): { fontSize: number; wide: boolean } {
  const visualWeight = articleVideoNumberVisualWeight(value)
  return {
    fontSize: Math.max(76, Math.min(180, Math.floor(410 / Math.max(visualWeight, 1)))),
    wide: visualWeight > 2.8,
  }
}

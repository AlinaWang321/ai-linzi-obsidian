export type PluginSkillActionId =
  | 'interview'
  | 'topic-radar'
  | 'wechat-writer'
  | 'distribute'
  | 'sales-review'
  | 'illustration'

export interface PluginSkillSuggestion {
  slug: string
  label: string
  actionId: PluginSkillActionId
}

/**
 * 云端推荐 slug → 插件本地可执行动作。
 * consulting-visual 是 v0.4.5 以前错误推荐的下架技能，只保留为历史消息兼容别名。
 */
const PLUGIN_SKILLS: Record<string, PluginSkillSuggestion> = {
  'article-illustration': {
    slug: 'article-illustration',
    label: '文章配图 · 极简手绘',
    actionId: 'illustration',
  },
  'consulting-visual': {
    slug: 'article-illustration',
    label: '文章配图 · 极简手绘',
    actionId: 'illustration',
  },
  'wechat-writer': { slug: 'wechat-writer', label: '公众号写作', actionId: 'wechat-writer' },
  'topic-radar': { slug: 'topic-radar', label: '内容选题雷达', actionId: 'topic-radar' },
  'sales-review': { slug: 'sales-review', label: '谈单复盘', actionId: 'sales-review' },
  'wechat-interview': { slug: 'wechat-interview', label: '原创访谈写作', actionId: 'interview' },
}

const MARKER_RE = /<<<\s*推荐技能[\s　]+([a-z0-9-]+)\s*>>>/g
const HANGING_RE = /\n?<{1,3}(?:\s*推?荐?技?能?[\s　]*[a-z0-9-]*)?$/

export function isArticleIllustrationIntent(text: string): boolean {
  return /(?:文章配图|正文配图|配图|插图|图片|封面)/.test(text) &&
    (/(?:生成|生图|做图|配图|插图|加图|加入|插入)/.test(text) || isArticleIllustrationEditIntent(text))
}

export function isArticleIllustrationEditIntent(text: string): boolean {
  return /(?:配图|插图|图片|封面)/.test(text) &&
    /(?:修改|改一下|改图|改成|改为|换成|换为|换掉|调整|重做|重新生成|替换|错字|写错|不对|去掉|移除|删除|修正|校对)/.test(text)
}

/**
 * 主对话里的单张新增配图请求。它和“给整篇文章配图”分开：前者会读取当前笔记、
 * 自动生成一张候选图；后者才进入完整的封面 + 多张正文图流程。
 */
export function isSingleArticleIllustrationIntent(text: string): boolean {
  if (isArticleIllustrationEditIntent(text)) return false
  const directSingleImage = /(?:再|另|新增|增加|加上?|补充?|插入|放|配)(?:给|到|在)?[^。！？!?\n]{0,12}(?:一|1)\s*张图/i.test(text)
  if (!isArticleIllustrationIntent(text) && !directSingleImage) return false
  return /(?:再|另|新增|增加|加上|补充|补一|插入|放一|配一|一张|1\s*张|part\s*0*\d+|第[一二三四五六七八九十\d]+(?:部分|章|节)|这(?:一)?段|某一段)/i.test(text)
}

export function extractExactTextHints(text: string): string[] {
  const hints: string[] = []
  const add = (value: string) => {
    const clean = value.trim()
    if (clean.length >= 2 && clean.length <= 20 && !hints.includes(clean)) hints.push(clean)
  }
  for (const match of text.matchAll(/[「“‘"]([^」”’"]{2,20})[」”’"]/g)) add(match[1])
  for (const match of text.matchAll(/(?:标题|文字|文案)?\s*(?:改成|改为|换成|换为|替换为)\s*[：:]?\s*([^\n。！？!?]{2,20})/g)) {
    add(match[1])
  }
  if (/AI\s*霖子/i.test(text)) add('AI霖子')
  return hints.slice(0, 5)
}

export function extractPluginSkillSuggestions(
  text: string,
  previousUserText = '',
): { cleanText: string; suggestions: PluginSkillSuggestion[] } {
  const suggestions: PluginSkillSuggestion[] = []
  const singleIllustration = isSingleArticleIllustrationIntent(previousUserText)
  const add = (skill: PluginSkillSuggestion | undefined) => {
    if (!skill || suggestions.some((item) => item.slug === skill.slug)) return
    suggestions.push(skill)
  }
  let cleanText = text.replace(MARKER_RE, (_marker, slug: string) => {
    const skill = PLUGIN_SKILLS[slug]
    // 服务端旧缓存或模型偶发仍可能输出整篇配图标记；单张补图由主对话自动执行，
    // 这里必须吞掉该标记，不能让用户再次点回完整技能。
    if (!(singleIllustration && skill?.slug === 'article-illustration')) add(skill)
    return ''
  })
  cleanText = cleanText.replace(HANGING_RE, '').trimEnd()
  if (isArticleIllustrationIntent(previousUserText) && !singleIllustration) {
    add(PLUGIN_SKILLS['article-illustration'])
  }
  return { cleanText, suggestions }
}

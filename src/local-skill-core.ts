/**
 * Vault 本地 Skill 的纯函数核心。
 *
 * 默认只接受用户显式调用，不做语义猜测：
 * - `用咨询简报技能处理当前笔记`
 * - `调用 咨询简报`
 * - `/咨询简报`
 *
 * v0.7.28 起，Skill 作者还可以在正文的“AI霖子自动调用”章节主动列出
 * 完整动作短语。插件只做确定性短语匹配，description 不参与自动调用。
 *
 * Skill 正文只在命中后由 local-skills.ts 读取，并且只进入当前一轮请求。
 */

/**
 * 「我的 Skills」当前默认目录。空值/非法值一律回退到这里（0.7.54 修复：旧实现回退到
 * 已废弃的 LEGACY_LOCAL_SKILL_ROOT，用户清空输入框想恢复默认，反而把技能写进死目录，
 * 且 0.7.53 的孤儿提醒因为"配置==旧默认"而主动闭嘴——等于几秒内重造技能孤儿事故）。
 */
export const LOCAL_SKILL_ROOT = '05_System/Skills'
/** 0.7.52 及更早版本的默认目录；只用于孤儿检测与保护规则兼容，绝不作为回退值。 */
export const LEGACY_LOCAL_SKILL_ROOT = 'system/skills'
/**
 * The entry chunk sent with the first model turn. Larger Skills stay usable:
 * the agent must continue with read_skill_file until it reaches end-of-file.
 */
export const LOCAL_SKILL_MAX_CONTENT_CHARS = 12_000
export const LOCAL_SKILL_MAX_ENTRY_CHARS = 120_000

/** Only continuous coverage from character zero counts as fully read. */
export function extendContiguousRead(
  alreadyReadThrough: number,
  offset: number,
  contentLength: number,
): number {
  if (offset > alreadyReadThrough) return alreadyReadThrough
  return Math.max(alreadyReadThrough, offset + contentLength)
}

export function localSkillLinkedPathCandidates(
  rawPath: string,
  directory: string,
  root: string,
): string[] {
  const raw = rawPath.trim().replace(/\\/g, '/').replace(/^<|>$/g, '')
  if (!raw || /^(?:https?:|file:)/i.test(raw)) return []
  const normalize = (value: string): string | null => {
    const parts: string[] = []
    for (const part of value.replace(/^\/+/, '').split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (parts.length === 0) return null
        parts.pop()
        continue
      }
      if (part.startsWith('.')) return null
      parts.push(part)
    }
    return parts.join('/') || null
  }
  const direct = normalize(raw)
  const relative = normalize(`${directory}/${raw}`)
  const vaultTopFolder = root.split('/')[0]
  if (raw.startsWith('/')) return direct ? [direct] : []
  if (raw.startsWith('./') || raw.startsWith('../')) return relative ? [relative] : []
  if (vaultTopFolder && raw.startsWith(`${vaultTopFolder}/`)) return direct ? [direct] : []
  return [...new Set([relative, direct].filter((path): path is string => Boolean(path)))]
}

export type LocalSkillOutput =
  | 'chat'
  | 'create-note'
  | 'update-current-note'
  | 'create-artifact'

export interface LocalSkillDescriptor {
  name: string
  /** Vault 中实际承载该 Skill 的文件夹名（单文件 Skill 则为文件名）。 */
  folderName: string
  /** 标准 SKILL.md 的首个 H1；用于中文展示与显式调用别名，不写回 YAML。 */
  displayName: string
  description: string
  triggers: string[]
  /** 用户在 SKILL.md 正文中主动声明的精确自然语言触发短语。 */
  autoTriggers: string[]
  /** 可选的结构校验模板路径；运行时只授权读取这一文件。 */
  templatePath?: string
  output: LocalSkillOutput
  path: string
}

export type LocalSkillMatch =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; skills: LocalSkillDescriptor[] }
  | { kind: 'matched'; skill: LocalSkillDescriptor; automatic?: boolean }

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * 用户设置的本地 Skill 根目录。只允许 Vault 内普通可见目录；空值或危险路径回退默认值。
 * 点号开头的隐藏目录不走 Obsidian 普通文件索引，也容易与应用内部目录混淆。
 */
export function normalizeLocalSkillRoot(value: string | undefined): string {
  const normalized = normalizePath(value?.trim() || LOCAL_SKILL_ROOT)
  const segments = normalized.split('/').map((segment) => segment.trim()).filter(Boolean)
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.') ||
        // eslint-disable-next-line no-control-regex -- 路径安全校验必须拒绝控制字符。
        /[:*?"<>|#^[\]\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    return LOCAL_SKILL_ROOT
  }
  return segments.join('/')
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean)
  }
  const raw = stringValue(value)
  return raw ? raw.split(/[,，、;；\n]/).map((item) => item.trim()).filter(Boolean) : []
}

function firstValue(frontmatter: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(frontmatter[key])
    if (value) return value
  }
  return ''
}

function normalizeOutput(value: unknown): LocalSkillOutput {
  const raw = normalizeText(stringValue(value))
  if (
    [
      'createartifact',
      'createdashboard',
      '生成成品',
      '生成html看板',
      '生成交互看板',
      '创建html看板',
      '创建交互看板',
    ].includes(raw)
  ) {
    return 'create-artifact'
  }
  if (
    [
      'updatecurrentnote',
      'editcurrentnote',
      'modifycurrentnote',
      '更新当前笔记',
      '修改当前笔记',
      '编辑当前笔记',
    ].includes(raw)
  ) {
    return 'update-current-note'
  }
  if (
    ['createnote', 'newnote', 'saveasnote', '新建笔记', '创建笔记', '另存为笔记'].includes(raw)
  ) {
    return 'create-note'
  }
  return 'chat'
}

/**
 * Agent Skills 兼容文件只在 Markdown 正文里声明 AI霖子的本地输出方式，
 * 避免往标准 YAML frontmatter 里增加私有字段。
 */
export function localSkillOutputFromMarkdown(content: string): LocalSkillOutput {
  const match = content.match(
    /^#{1,6}\s*(?:AI\s*霖子\s*)?输出方式\s*$\r?\n\s*`?(chat|create-note|update-current-note|create-artifact|新建笔记|创建笔记|更新当前笔记|修改当前笔记|生成成品|生成HTML看板|生成交互看板)`?\s*$/imu,
  )
  return normalizeOutput(match?.[1] ?? '')
}

/**
 * Skill 作者明确把输入锁定为当前/指定文件，同时禁止扫描其他资料时，
 * 插件必须把这条文字边界落实成工具权限，而不能只依赖模型自觉遵守。
 */
export function localSkillForbidsVaultExpansion(content: string): boolean {
  // 按句子判断，不让“只读任务所需内容”和后文一个毫不相干的
  // “一个…文件”跨行拼成单文件权限。只有明确单数或当前笔记描述才上锁。
  const statements = content
    .split(/\r?\n|[。；;]/u)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/u, '').trim())
    .filter(Boolean)
  const locksOneInput = statements.some((statement) =>
    /(?:只|仅)(?:接受|读取|处理|使用)\s*(?:(?:由)?用户(?:明确)?(?:打开|指定)的?)?\s*(?:一份|一个|一篇|单篇|单个|唯一(?:一份|一个|一篇)?)\s*(?:由用户(?:明确)?(?:打开|指定)的?)?[^,，。；;\n]{0,20}(?:逐字稿|笔记|文件(?!夹)|文档|材料)/iu.test(statement) ||
    /(?:只|仅)(?:接受|读取|处理|使用)\s*(?:当前|这|该)(?:明确打开|打开|指定)?的?(?:一篇|一份|一个|篇|份|个)?\s*(?:逐字稿|笔记|文件(?!夹)|文档|材料)/iu.test(statement),
  )
  const forbidsExpansion = statements.some((statement) =>
    /(?:(?:不得|禁止|不要|不能|不应)[^,，。；;\n]{0,16}|不(?:主动|再|去|擅自)?)(?:扫描|遍历|读取|搜索)[^,，。；;\n]{0,36}(?:其他|未指定|整个|全部|全库|知识库|文件夹)/iu.test(statement),
  )
  return locksOneInput && forbidsExpansion
}

export interface LocalSkillScopedInputBindings {
  rawRoot: string
  wikiRoot: string
  outputRoot: string
}

export type LocalSkillScopedInputResolution =
  | { status: 'locked'; path: string }
  | { status: 'ambiguous'; paths: string[] }
  | { status: 'missing' }

export function localSkillQuestionNamesInputFile(question: string): boolean {
  const normalized = question.normalize('NFKC').replace(/[\\／]+/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.length > 800) return false
  return (
    /\$?(?:raw|wiki|output)\s*\//iu.test(normalized) ||
    /(?:原始素材|知识库|输出)(?:文件夹)?\s*\//u.test(normalized) ||
    /(?:路径|文件名|文件|文档|笔记|稿子|逐字稿)/u.test(normalized) ||
    /\.(?:md|txt|pdf|docx|html?|pptx|xlsx)(?:\s|$|[，。！？、；：)）])/iu.test(normalized)
  )
}

function comparablePath(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\\／]+/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim()
    .toLocaleLowerCase()
}

function comparableLoose(value: string): string {
  return comparablePath(value).replace(/[^\p{L}\p{N}]+/gu, '')
}

function withoutExtension(value: string): string {
  return value.replace(/\.[\p{L}\p{N}]{1,8}$/u, '')
}

function rootAliasVariants(
  path: string,
  bindings: LocalSkillScopedInputBindings,
): string[] {
  const normalized = comparablePath(path)
  const roots: Array<[string, string[]]> = [
    [bindings.rawRoot, ['$raw', 'raw', '原始素材']],
    [bindings.wikiRoot, ['$wiki', 'wiki', '知识库']],
    [bindings.outputRoot, ['$output', 'output', '输出']],
  ]
  const variants = [normalized]
  for (const [configuredRoot, aliases] of roots) {
    const root = comparablePath(configuredRoot)
    if (!root || (normalized !== root && !normalized.startsWith(`${root}/`))) continue
    const rest = normalized === root ? '' : normalized.slice(root.length + 1)
    variants.push(...aliases.map((alias) => rest ? `${alias}/${rest}` : alias))
  }
  return [...new Set(variants.filter(Boolean))]
}

const SCOPED_INPUT_GENERIC_TERMS = [
  '朋友圈知识卡片',
  '经验萃取',
  '商业咨询',
  '咨询逐字稿',
  '销售逐字稿',
  '逐字稿文本',
  '逐字稿',
  '当前打开',
  '明确指定',
  '用户指定',
  '请帮我',
  '帮我',
  '处理',
  '读取',
  '整理',
  '使用',
  '调用',
  '生成',
  '这一个',
  '这一份',
  '这份',
  '一份',
  '一个',
  '当前',
  '咨询',
  '记录',
  '原稿',
  '稿子',
  '文件',
  '文档',
  '材料',
  '笔记',
  'skill',
  '技能',
  'raw',
  'wiki',
  'output',
  '的',
].sort((left, right) => right.length - left.length)

function distinctiveScopedInputTokens(value: string): string[] {
  const chunks = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter(Boolean)
  const tokens: string[] = []
  for (const chunk of chunks) {
    let cleaned = chunk
    for (const term of SCOPED_INPUT_GENERIC_TERMS) cleaned = cleaned.split(term).join(' ')
    tokens.push(...cleaned.split(/\s+/).map(comparableLoose).filter((item) => item.length >= 2))
  }
  return [...new Set(tokens)].sort((left, right) => right.length - left.length)
}

/**
 * “只处理用户明确指定的一份文件”的 Skill 仍需要一种比全库搜索更窄的定位能力。
 * 这里全程只比较 Vault 文件路径/文件名元数据，不读任何正文：
 * - 完整路径或完整文件名优先；
 * - `Raw/Wiki/Output` 与 `$RAW/$WIKI/$OUTPUT` 按驾驶舱设置解析；
 * - 用户给出文件夹 + 唯一姓名/日期等特征时，只在该文件夹内锁定唯一候选；
 * - 同名或不唯一时绝不猜测，把候选交还给用户选择。
 */
export function resolveLocalSkillScopedInput(
  question: string,
  filePaths: string[],
  bindings: LocalSkillScopedInputBindings,
  ignoredTerms: string[] = [],
): LocalSkillScopedInputResolution {
  const comparableQuestion = comparablePath(question)
  const files = [...new Set(filePaths.map((path) => comparablePath(path)).filter(Boolean))]
    .map((normalized) => ({
      path: filePaths.find((path) => comparablePath(path) === normalized) ?? normalized,
      normalized,
      basename: normalized.split('/').at(-1) ?? normalized,
      parent: normalized.split('/').slice(0, -1).join('/'),
    }))
  if (!comparableQuestion || files.length === 0) return { status: 'missing' }

  const exactMatches = files
    .map((file) => {
      const aliases = [...rootAliasVariants(file.normalized, bindings), file.basename]
        .flatMap((alias) => [alias, withoutExtension(alias)])
        .filter((alias) => alias.length >= 3 && comparableQuestion.includes(alias))
      return { file, score: aliases.reduce((max, alias) => Math.max(max, alias.length), 0) }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
  if (exactMatches.length > 0) {
    const best = exactMatches[0].score
    const top = exactMatches.filter((item) => item.score === best)
    if (top.length === 1) return { status: 'locked', path: top[0].file.path }
    return { status: 'ambiguous', paths: top.map((item) => item.file.path).slice(0, 8) }
  }

  const parentMatches = files
    .flatMap((file) => rootAliasVariants(file.parent, bindings).map((alias) => ({ alias, parent: file.parent })))
    .filter((item) => item.alias.length >= 2 && comparableQuestion.includes(item.alias))
    .sort((left, right) => right.alias.length - left.alias.length)
  const longestParentAlias = parentMatches[0]?.alias.length ?? 0
  const matchedParents = new Set(
    parentMatches
      .filter((item) => item.alias.length === longestParentAlias)
      .map((item) => item.parent),
  )
  const narrowed = matchedParents.size > 0
    ? files.filter((file) => matchedParents.has(file.parent))
    : files

  const tail = parentMatches[0]
    ? comparableQuestion.slice(comparableQuestion.indexOf(parentMatches[0].alias) + parentMatches[0].alias.length)
    : comparableQuestion
  const tokens = [...new Set([
    ...distinctiveScopedInputTokens(tail),
    ...distinctiveScopedInputTokens(comparableQuestion),
  ])].filter(
    (token) => !ignoredTerms.some((term) => token === comparableLoose(term)),
  )
  const fuzzyMatches = narrowed
    .map((file) => {
      const basename = comparableLoose(withoutExtension(file.basename))
      const matchedTokens = tokens.filter((token) => basename.includes(token))
      return {
        file,
        score: matchedTokens.reduce((sum, token) => sum + token.length * token.length, 0),
        longest: matchedTokens[0]?.length ?? 0,
      }
    })
    .filter((item) => item.longest >= 2)
    .sort((left, right) => right.score - left.score || right.longest - left.longest)
  if (fuzzyMatches.length > 0) {
    const top = fuzzyMatches.filter(
      (item) => item.score === fuzzyMatches[0].score && item.longest === fuzzyMatches[0].longest,
    )
    if (top.length === 1) return { status: 'locked', path: top[0].file.path }
    return { status: 'ambiguous', paths: top.map((item) => item.file.path).slice(0, 8) }
  }

  if (narrowed.length > 1 && matchedParents.size > 0) {
    return { status: 'ambiguous', paths: narrowed.map((file) => file.path).slice(0, 8) }
  }
  return { status: 'missing' }
}

export function localSkillDisplayNameFromMarkdown(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  const heading = body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? ''
  return heading.replace(/[*_`[\]]/g, '').trim().slice(0, 80)
}

function markdownSection(content: string, title: RegExp): string {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{2,6}\s+/.test(line) && title.test(line.replace(/^#{2,6}\s+/, '').trim()))
  if (start < 0) return ''
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,6}\s+/.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n').trim()
}

/** 只有 Skill 作者主动列出的完整短语才允许自动调用，普通 description 不参与猜测。 */
export function localSkillAutoTriggersFromMarkdown(content: string): string[] {
  const section = markdownSection(content, /^(?:AI\s*霖子\s*)?自动(?:调用|触发)$/iu)
  if (!section) return []
  const visibleLines: string[] = []
  let fenced = false
  for (const rawLine of section.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/u.test(rawLine)) {
      fenced = !fenced
      continue
    }
    if (!fenced) visibleLines.push(rawLine)
  }
  const clean = (value: string) => value.replace(/^`|`$/g, '').trim()
  const validLength = (value: string) => value.length >= 4 && value.length <= 80
  // 新格式只认 Markdown 列表项。只要存在一个合法列表项，说明作者已经采用
  // 结构化写法；说明文字和示例行绝不能再混进自动触发短语。
  const listed = visibleLines
    .map((line) => /^\s*[-*+]\s+(.+?)\s*$/u.exec(line)?.[1] ?? '')
    .map(clean)
    .filter(validLength)
  if (listed.length > 0) return [...new Set(listed)].slice(0, 12)

  // 兼容 0.7.28 以前没有项目符号的旧 Skill。回退时仍过滤明显的 Markdown
  // 结构行、标签和“说明/示例”提示，避免把整句教程当成可执行触发词。
  const legacy = visibleLines
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s|^>/u.test(line))
    .filter((line) => !/[:：]\s*$/u.test(line))
    .filter((line) => !/^(?:说明|示例|例如|比如|提示)(?:[:：\s]|$)/u.test(line))
    .map(clean)
    .filter(validLength)
  return [...new Set(legacy)].slice(0, 12)
}

export function localSkillTemplatePathFromMarkdown(content: string): string | undefined {
  const section = markdownSection(content, /^(?:AI\s*霖子\s*)?模板校验$/iu)
  if (!section) return undefined
  const linked = /\[?[^\]\n]*\]?\(([^)\r\n]+)\)|`([^`\r\n]+)`|([^\s\r\n]+\.(?:md|txt))/iu.exec(section)
  return (linked?.[1] || linked?.[2] || linked?.[3])?.trim()
}

export function isLocalSkillPath(path: string, configuredRoot = LOCAL_SKILL_ROOT): boolean {
  const normalized = normalizePath(path)
  const lower = normalized.toLocaleLowerCase()
  const normalizedRoot = normalizeLocalSkillRoot(configuredRoot)
  const root = normalizedRoot.toLocaleLowerCase()
  if (!lower.startsWith(`${root}/`) || !lower.endsWith('.md')) return false
  const rest = normalized.slice(normalizedRoot.length + 1).split('/')
  return rest.length === 1 || (rest.length === 2 && rest[1].toLocaleLowerCase() === 'skill.md')
}

export function buildLocalSkillDescriptor(
  path: string,
  frontmatter: Record<string, unknown> = {},
  content = '',
  configuredRoot = LOCAL_SKILL_ROOT,
): LocalSkillDescriptor | null {
  if (!isLocalSkillPath(path, configuredRoot)) return null
  const normalized = normalizePath(path)
  const segments = normalized.split('/')
  const filename = segments.at(-1) ?? ''
  const fallbackName =
    filename.toLocaleLowerCase() === 'skill.md'
      ? segments.at(-2) ?? '未命名 Skill'
      : filename.replace(/\.md$/i, '')
  const name =
    firstValue(frontmatter, ['name', 'skill', '技能名', '名称']) || fallbackName
  const displayName = localSkillDisplayNameFromMarkdown(content) || name
  const description = firstValue(frontmatter, [
    'description',
    'summary',
    '一句话描述',
    '描述',
  ])
  const triggerValues = [
    ...stringList(frontmatter.triggers),
    ...stringList(frontmatter.trigger),
    ...stringList(frontmatter['触发词']),
  ]
  const triggers = [
    ...new Set([name, displayName, ...triggerValues].map((item) => item.trim()).filter(Boolean)),
  ]
  return {
    name: name.slice(0, 80),
    folderName: fallbackName.slice(0, 120),
    displayName,
    description: description.slice(0, 240),
    triggers,
    autoTriggers: localSkillAutoTriggersFromMarkdown(content),
    templatePath: localSkillTemplatePathFromMarkdown(content),
    output: normalizeOutput(
      frontmatter.output ??
        frontmatter.outputMode ??
        frontmatter['输出方式'] ??
        frontmatter['输出模式'] ??
        localSkillOutputFromMarkdown(content),
    ),
    path: normalized,
  }
}

export function isLocalSkillListIntent(message: string): boolean {
  const trimmed = message.trim()
  if (/^\/skills?$/iu.test(trimmed)) return true
  const normalized = normalizeText(message)
  return [
    '我的skills',
    '我的skill',
    '查看我的skills',
    '查看我的skill',
    '查看我的技能',
    '打开我的skills',
    '打开我的skill',
    '打开我的技能',
    '我的本地skills',
    '我的本地skill',
    '我有哪些本地skills',
    '我有哪些本地skill',
    '我有哪些本地技能',
    '查看本地skills',
    '查看本地skill',
    '查看本地技能',
    '列出本地skills',
    '列出本地skill',
    '列出本地技能',
    'system里有哪些skills',
    'system里有哪些skill',
    'system里有哪些技能',
  ].some((intent) => normalized.includes(normalizeText(intent)))
}

function invocationContext(message: string): {
  normalized: string
  explicit: boolean
  missingIntent: boolean
  slash: boolean
  mentionsSkillWord: boolean
} {
  const trimmed = message.trim()
  return {
    normalized: normalizeText(trimmed),
    explicit:
      /(?:^|[\s，,。.!！?？:：]|请|帮我)(?:用|使用|调用|运行|执行|启用|按照|按)\s*/u.test(
        trimmed,
      ),
    // “没有找到 Skill”只按 0.7.72 收窄口径失败关闭：slash，或六个明确
    // 调用动词与 Skill/技能同时出现。“按/按照”仍可命中已存在的名称，但
    // 名称没命中时不应劫持普通说明句。
    missingIntent:
      // 失败关闭只在“调用动词确实指向 Skill/技能”时生效，不能把整句话里
      // 任意位置出现的两个词硬拼起来。例如“做一份标题含 Skill 的讲义，
      // 使用课程排版”是在生成 Word，不是在调用一个不存在的 Skill。
      /(?:^|[\s，,。.!！?？:：]|请|帮我)(?:用|使用|调用|运行|执行|启用)\s*[^，,。.!！?？\r\n]{0,80}?(?:skill|技能)/iu.test(trimmed),
    slash: /^\/[^\s/]+/u.test(trimmed),
    mentionsSkillWord: /(?:skill|技能)/iu.test(trimmed),
  }
}

/**
 * 学员会自然省略显示名末尾重复的“Skill/技能/工作流”，例如把
 * “经验萃取技能”说成“经验萃取 Skill”。这里只生成确定性的后缀别名，
 * 不做语义模糊匹配；若两个 Skill 得到同一个短名，后续评分仍会返回 ambiguous。
 */
function localSkillAliases(skill: LocalSkillDescriptor): Array<{ alias: string; normalized: string }> {
  const aliases = new Set([
    skill.name,
    skill.displayName,
    skill.folderName,
    ...skill.triggers,
  ])
  for (const alias of [...aliases]) {
    const withoutTypeSuffix = alias.replace(/(?:\s*(?:skill|技能|工作流))\s*$/iu, '').trim()
    if (withoutTypeSuffix) aliases.add(withoutTypeSuffix)
  }
  return [...aliases]
    .map((alias) => ({ alias, normalized: normalizeText(alias) }))
    .filter((item) => item.normalized.length >= 2)
}

export function matchLocalSkillInvocation(
  message: string,
  skills: LocalSkillDescriptor[],
  options: { allowAutomatic?: boolean } = {},
): LocalSkillMatch {
  const context = invocationContext(message)
  if (!context.explicit && !context.slash) {
    if (!options.allowAutomatic) return { kind: 'none' }
    const normalized = context.normalized
    const automatic = skills
      .map((skill) => {
        const trigger = skill.autoTriggers
          .map((value) => ({ value, normalized: normalizeText(value) }))
          .filter((item) => item.normalized.length >= 4 && normalized.includes(item.normalized))
          .sort((left, right) => right.normalized.length - left.normalized.length)[0]
        return trigger ? { skill, score: trigger.normalized.length } : null
      })
      .filter((item): item is { skill: LocalSkillDescriptor; score: number } => Boolean(item))
      .sort((left, right) => right.score - left.score)
    if (automatic.length === 0) return { kind: 'none' }
    const top = automatic.filter((item) => item.score === automatic[0].score)
    return top.length === 1
      ? { kind: 'matched', skill: top[0].skill, automatic: true }
      : { kind: 'ambiguous', skills: top.map((item) => item.skill) }
  }

  const candidates = skills
    .map((skill) => {
      const aliases = localSkillAliases(skill)
      const matched = aliases
        .filter((item) => context.normalized.includes(item.normalized))
        .sort((left, right) => right.normalized.length - left.normalized.length)[0]
      return matched
        ? {
            skill,
            score:
              matched.normalized.length * 10 +
              (normalizeText(skill.name) === matched.normalized ? 5 : 0),
          }
        : null
    })
    .filter((item): item is { skill: LocalSkillDescriptor; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score)

  if (candidates.length === 0) {
    return context.slash || (context.missingIntent && context.mentionsSkillWord)
      ? { kind: 'missing' }
      : { kind: 'none' }
  }
  const topScore = candidates[0].score
  const top = candidates.filter((candidate) => candidate.score === topScore)
  if (top.length > 1) return { kind: 'ambiguous', skills: top.map((item) => item.skill) }
  return { kind: 'matched', skill: top[0].skill, automatic: false }
}

const LOCAL_SKILL_UPDATE_ACTION_PATTERN =
  /(?:修改|更新|调整|优化|改进|重写|补充|删掉|删除|移除|改一下|改成|改为|换成|以后.{0,12}(?:放到|保存到|输出到)|(?:让|允许|授权|开放|放开|限制|收窄|扩大|缩小).{0,32}(?:读取|搜索|访问|权限|范围)|(?:读取|搜索|访问)(?:范围|权限)?.{0,16}(?:开放|放开|限制|收窄|扩大|缩小))/u

const LOCAL_SKILL_NEGATED_UPDATE_ACTION_PATTERN =
  /(?:不要|不得|别|无需|不需要|不用|禁止|避免|暂不|先不)(?:(?![。！？!?；;\n]).){0,32}(?:修改|更新|调整|优化|改进|重写|补充|删掉|删除|移除|改一下|改成|改为|换成)/gu

/**
 * 候选判断只看“这是一个修改动作”，最终仍必须由已安装 Skill 的精确名称匹配
 * 决定是否进入更新器。这样可以支持“请修改 codex-daily-reflection”这种自然说法，
 * 又不会把“更新客户档案”一类普通业务动作直接当成 Skill 管理。
 */
export function isPotentialLocalSkillUpdateIntent(message: string): boolean {
  const actionable = message
    .trim()
    .replace(LOCAL_SKILL_NEGATED_UPDATE_ACTION_PATTERN, '')
  return LOCAL_SKILL_UPDATE_ACTION_PATTERN.test(actionable)
}

/**
 * “修改/更新某个 Skill”是管理已安装 Skill，不是运行它，也不是创建同名 Skill。
 * 显式口径仍要求出现 Skill/技能/工作流；省略类型词时只允许后面的强名称匹配放行。
 */
export function isExplicitLocalSkillUpdateIntent(message: string): boolean {
  const clauses = message
    .normalize('NFKC')
    .split(/[，,。.!！?？:：；;\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
  return clauses.some((clause) => {
    if (!/(?:skill|技能|工作流)/iu.test(clause)) return false
    const actionable = clause.replace(LOCAL_SKILL_NEGATED_UPDATE_ACTION_PATTERN, '')
    return LOCAL_SKILL_UPDATE_ACTION_PATTERN.test(actionable)
  })
}

function hasStrongUnlabelledSkillReference(message: string, skill: LocalSkillDescriptor): boolean {
  const source = message.normalize('NFKC').toLocaleLowerCase()
  const exactPortableNames = [skill.name, skill.folderName]
    .map((value) => value.normalize('NFKC').toLocaleLowerCase().trim())
    .filter((value) => /[a-z0-9_-]/u.test(value))
  if (exactPortableNames.some((value) => source.includes(value))) return true

  const quotedAliases = localSkillAliases(skill)
    .map((item) => item.alias.normalize('NFKC').toLocaleLowerCase().trim())
    .filter(Boolean)
  return quotedAliases.some((alias) =>
    [`“${alias}”`, `"${alias}"`, `「${alias}」`, `『${alias}』`, `‘${alias}’`, `'${alias}'`]
      .some((wrapped) => source.includes(wrapped)),
  )
}

export function matchLocalSkillUpdateIntent(
  message: string,
  skills: LocalSkillDescriptor[],
): LocalSkillMatch {
  if (!isPotentialLocalSkillUpdateIntent(message)) return { kind: 'none' }
  const explicit = isExplicitLocalSkillUpdateIntent(message)
  const normalized = normalizeText(message)
  const candidates = skills
    .map((skill) => {
      const aliases = localSkillAliases(skill)
      const matched = aliases
        .filter((item) => normalized.includes(item.normalized))
        .sort((left, right) => right.normalized.length - left.normalized.length)[0]
      return matched
        ? {
            skill,
            score: matched.normalized.length * 10 +
              (normalizeText(skill.name) === matched.normalized ? 5 : 0),
          }
        : null
    })
    .filter((item): item is { skill: LocalSkillDescriptor; score: number } =>
      Boolean(item) && (explicit || hasStrongUnlabelledSkillReference(message, item!.skill)),
    )
    .sort((left, right) => right.score - left.score)
  if (candidates.length === 0) return explicit ? { kind: 'missing' } : { kind: 'none' }
  const top = candidates.filter((candidate) => candidate.score === candidates[0].score)
  return top.length === 1
    ? { kind: 'matched', skill: top[0].skill }
    : { kind: 'ambiguous', skills: top.map((item) => item.skill) }
}

export function formatLocalSkillList(
  skills: LocalSkillDescriptor[],
  configuredRoot = LOCAL_SKILL_ROOT,
): string {
  const root = normalizeLocalSkillRoot(configuredRoot)
  if (skills.length === 0) {
    return (
      `“我的 Skills”中还没有 Skill。你可以直接在主对话中让我创建，` +
      `创建后会保存在 \`${root}/\`。`
    )
  }
  const rows = skills.map(
    (skill, index) => `${index + 1}. **${localSkillMenuTitle(skill)}**`,
  )
  return [
    `“我的 Skills”中共有 ${skills.length} 个 Skill（保存在 \`${root}/\`）：`,
    '',
    ...rows,
    '',
    '调用示例：`用咨询简报技能处理当前笔记`。',
  ].join('\n')
}

export function formatMissingLocalSkillError(
  skills: LocalSkillDescriptor[],
  configuredRoot = LOCAL_SKILL_ROOT,
): string {
  const available = skills.slice(0, 8).map(localSkillMenuTitle)
  const suffix = skills.length > available.length ? `等 ${skills.length} 个` : ''
  return available.length > 0
    ? `没有找到你点名的 Skill。当前可用：${available.join('、')}${suffix}。` +
        '请改用“用/调用 + 完整 Skill 名称”重试。'
    : `没有找到你点名的 Skill。“我的 Skills”文件夹 ${normalizeLocalSkillRoot(configuredRoot)}/ 目前为空。`
}

/** 菜单只展示可辨认的名字与文件夹，不把给模型看的长 description 铺满屏幕。 */
export function localSkillMenuTitle(skill: LocalSkillDescriptor): string {
  const folder = skill.folderName || skill.name
  return skill.displayName === folder ? skill.displayName : `${skill.displayName} · ${folder}`
}

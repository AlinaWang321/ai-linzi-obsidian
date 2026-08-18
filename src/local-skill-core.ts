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

export type LocalSkillOutput = 'chat' | 'create-note' | 'update-current-note'

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
    /^#{1,6}\s*(?:AI\s*霖子\s*)?输出方式\s*$\r?\n\s*`?(chat|create-note|update-current-note|新建笔记|创建笔记|更新当前笔记|修改当前笔记)`?\s*$/imu,
  )
  return normalizeOutput(match?.[1] ?? '')
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
  return [...new Set(section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*+]\s+/, '').replace(/^`|`$/g, '').trim())
    .filter((line) => line.length >= 4 && line.length <= 80))]
    .slice(0, 12)
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
  slash: boolean
  mentionsSkillWord: boolean
} {
  const trimmed = message.trim()
  return {
    normalized: normalizeText(trimmed),
    explicit:
      /(?:^|[\s，,。.!！?？:：]|请|帮我)(?:用|调用|运行|执行|启用|按照|按)\s*/u.test(
        trimmed,
      ),
    slash: /^\/[^\s/]+/u.test(trimmed),
    mentionsSkillWord: /(?:skill|技能)/iu.test(trimmed),
  }
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
      const aliases = [...new Set([skill.name, ...skill.triggers])]
        .map((alias) => ({ alias, normalized: normalizeText(alias) }))
        .filter((item) => item.normalized.length >= 2)
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
    return context.slash || context.mentionsSkillWord ? { kind: 'missing' } : { kind: 'none' }
  }
  const topScore = candidates[0].score
  const top = candidates.filter((candidate) => candidate.score === topScore)
  if (top.length > 1) return { kind: 'ambiguous', skills: top.map((item) => item.skill) }
  return { kind: 'matched', skill: top[0].skill, automatic: false }
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

/** 菜单只展示可辨认的名字与文件夹，不把给模型看的长 description 铺满屏幕。 */
export function localSkillMenuTitle(skill: LocalSkillDescriptor): string {
  const folder = skill.folderName || skill.name
  return skill.displayName === folder ? skill.displayName : `${skill.displayName} · ${folder}`
}

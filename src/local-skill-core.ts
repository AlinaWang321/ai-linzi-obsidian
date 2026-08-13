/**
 * Vault 本地 Skill 的纯函数核心。
 *
 * v1 只接受用户显式调用，不做语义猜测：
 * - `用咨询简报技能处理当前笔记`
 * - `调用 咨询简报`
 * - `/咨询简报`
 *
 * Skill 正文只在命中后由 local-skills.ts 读取，并且只进入当前一轮请求。
 */

export const LOCAL_SKILL_ROOT = 'system/skills'
export const LOCAL_SKILL_MAX_CONTENT_CHARS = 12_000

export type LocalSkillOutput = 'chat' | 'create-note' | 'update-current-note'

export interface LocalSkillDescriptor {
  name: string
  /** 标准 SKILL.md 的首个 H1；用于中文展示与显式调用别名，不写回 YAML。 */
  displayName: string
  description: string
  triggers: string[]
  output: LocalSkillOutput
  path: string
}

export type LocalSkillMatch =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; skills: LocalSkillDescriptor[] }
  | { kind: 'matched'; skill: LocalSkillDescriptor }

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
    displayName,
    description: description.slice(0, 240),
    triggers,
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
): LocalSkillMatch {
  const context = invocationContext(message)
  if (!context.explicit && !context.slash) return { kind: 'none' }

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
  return { kind: 'matched', skill: top[0].skill }
}

export function formatLocalSkillList(
  skills: LocalSkillDescriptor[],
  configuredRoot = LOCAL_SKILL_ROOT,
): string {
  const root = normalizeLocalSkillRoot(configuredRoot)
  if (skills.length === 0) {
    return (
      `还没有找到本地 Skill。请把技能文件放进 \`${root}/\`，` +
      '支持 `技能名.md` 或 `技能名/SKILL.md`。'
    )
  }
  const rows = skills.map((skill, index) => {
    const description = skill.description ? `：${skill.description}` : ''
    const machineName =
      skill.displayName === skill.name ? '' : `（\`${skill.name}\`）`
    return `${index + 1}. **${skill.displayName}**${machineName}${description}`
  })
  return [
    `我在 \`${root}/\` 找到 ${skills.length} 个本地 Skill：`,
    '',
    ...rows,
    '',
    '调用示例：`用咨询简报技能处理当前笔记`。',
  ].join('\n')
}

/**
 * Vault agent public protocol + pure validation helpers.
 *
 * The model may only request these read tools. All filesystem access and every
 * mutation are validated and executed by the local Obsidian plugin.
 */

import {
  ARTIFACT_FORMATS,
  ARTIFACT_MAX_CONTENT_CHARS,
  ARTIFACT_MAX_TITLE_CHARS,
  type ArtifactFormat,
  type ArtifactTheme,
  type CreateArtifactOperation,
} from './artifact-renderer-core'
import {
  PRESENTATION_FORMATS,
  PRESENTATION_MAX_SLIDES,
  PRESENTATION_MAX_TITLE_CHARS,
  PRESENTATION_MAX_TOTAL_CHARS,
  normalizePresentationSlide,
  normalizePresentationTheme,
  presentationCharacterCount,
  type CreatePresentationOperation,
  type PresentationFormat,
} from './presentation-renderer-core'

export const VAULT_AGENT_MAX_ROUNDS = 6
export const VAULT_AGENT_MAX_CALLS_PER_ROUND = 4
export const VAULT_AGENT_MAX_PLAN_OPERATIONS = 60
export const VAULT_NOTE_WRITE_MAX_CHARS = 30_000
export const VAULT_NOTE_UPDATE_MAX_OPERATIONS = 30

export type VaultAgentToolName =
  | 'vault_search'
  | 'list_folder'
  | 'read_note'
  | 'read_skill_file'
  | 'propose_skill_action'
export type VaultAgentIntent = 'auto' | 'answer' | 'organize'

export interface VaultAgentToolCall {
  id: string
  name: VaultAgentToolName
  arguments: Record<string, unknown>
}

export interface VaultAgentToolResult {
  callId: string
  name: VaultAgentToolName
  ok: boolean
  output: string
}

export type VaultOrganizeOperation =
  | { type: 'create_folder'; path: string; reason?: string }
  | { type: 'move'; from: string; to: string; reason?: string }
  | { type: 'trash_note'; path: string; reason?: string }
  | { type: 'create_note'; path: string; content: string; reason?: string }
  | { type: 'append_note'; path: string; content: string; reason?: string }
  | { type: 'replace_note'; path: string; content: string; reason?: string }
  | CreateArtifactOperation
  | CreatePresentationOperation
  | {
      type: 'update_note'
      path: string
      replacements?: { old: string; new: string; all?: boolean; reason?: string }[]
      frontmatter?: { old: string; new: string; reason?: string }
      reason?: string
    }

export interface VaultOrganizePlan {
  title: string
  summary: string
  operations: VaultOrganizeOperation[]
  notes: string[]
}

/** 方案生成时锁定的本地文件版本；只保存在插件本机会话。 */
export interface VaultWriteSnapshot {
  path: string
  mtime: number
  size: number
}

export interface VaultToolCallExtraction {
  cleanText: string
  calls: VaultAgentToolCall[]
  invalid: boolean
}

export interface VaultPlanExtraction {
  cleanText: string
  plan?: VaultOrganizePlan
  invalid: boolean
}

export type VaultAnswerRetryReason =
  | 'deferred_answer'
  | 'missing_count'
  | 'missing_tool_use'
  | 'invalid_plan'
  | 'empty_response'
  | 'unexpected_plan'
  | 'stalled_write_flow'

/**
 * 跨用户轮次的 Vault 任务状态（2026-08-17 阶段 A）。
 *
 * 只保存任务元数据与路径快照；原始正文、搜索片段和工具输出只存进程内存，
 * 跨轮恢复时按受控路径重新读取本地文件（见交接手册 §8.1）。用户说「对」
 * 「继续」时，插件凭这份状态接续上一轮任务，而不是重新从 round 0 理解需求。
 */
export interface PendingVaultTask {
  id: string
  /** 用户原话摘要，跨轮提醒模型任务目标。 */
  goal: string
  intent: 'answer' | 'organize'
  stage: 'searching' | 'searched' | 'source_read' | 'target_read' | 'previewed'
  /** 搜索命中的候选路径（≤12，仅本机使用，不进云端历史）。 */
  candidatePaths: string[]
  /** 已读取来源的版本快照；恢复时 mtime/size 变化必须重读。 */
  sourcePaths: VaultWriteSnapshot[]
  targetPath?: string
  createdAt: number
  updatedAt: number
}

export const VAULT_TASK_MAX_AGE_MS = 30 * 60 * 1000
export const VAULT_TASK_MAX_CANDIDATES = 12

const VAULT_TASK_STAGE_ORDER: Record<PendingVaultTask['stage'], number> = {
  searching: 0,
  searched: 1,
  source_read: 2,
  target_read: 3,
  previewed: 4,
}

export function vaultTaskStageAtLeast(
  stage: PendingVaultTask['stage'],
  min: PendingVaultTask['stage'],
): boolean {
  return VAULT_TASK_STAGE_ORDER[stage] >= VAULT_TASK_STAGE_ORDER[min]
}

export type VaultTaskEvent =
  | { type: 'search'; candidatePaths: string[] }
  | { type: 'read'; snapshot: VaultWriteSnapshot; isTarget: boolean }
  | { type: 'previewed'; targetPath: string }

/** 纯 reducer：按本机真实发生的工具事件推进任务阶段，绝不因模型措辞变化。 */
export function advanceVaultTask(
  task: PendingVaultTask,
  event: VaultTaskEvent,
  now: number,
): PendingVaultTask {
  const next: PendingVaultTask = { ...task, updatedAt: now }
  if (event.type === 'search') {
    const merged = [...new Set([...task.candidatePaths, ...event.candidatePaths])]
    next.candidatePaths = merged.slice(0, VAULT_TASK_MAX_CANDIDATES)
    if (!vaultTaskStageAtLeast(task.stage, 'searched')) next.stage = 'searched'
    return next
  }
  if (event.type === 'read') {
    const rest = task.sourcePaths.filter((item) => item.path !== event.snapshot.path)
    next.sourcePaths = [...rest, event.snapshot].slice(-VAULT_TASK_MAX_CANDIDATES)
    if (event.isTarget) {
      next.targetPath = event.snapshot.path
      if (!vaultTaskStageAtLeast(task.stage, 'target_read')) next.stage = 'target_read'
    } else if (!vaultTaskStageAtLeast(task.stage, 'source_read')) {
      next.stage = 'source_read'
    }
    return next
  }
  next.targetPath = event.targetPath
  next.stage = 'previewed'
  return next
}

export function isVaultTaskExpired(task: PendingVaultTask, now: number): boolean {
  return now - task.updatedAt > VAULT_TASK_MAX_AGE_MS
}

/**
 * 写入流程的结构化完成判定（阶段 A 核心）：合法终态只有三种——
 * 本轮有真实工具调用 / 已产出通过预检的方案卡 / 明确声明缺信息。
 * 「已搜到目标但没读原文就收尾」在这里被结构性拦截，与模型措辞无关。
 */
export function vaultWriteFlowRetryReason(
  task: PendingVaultTask | null,
  intent: VaultAgentIntent,
  hasPlanCard: boolean,
  hasToolCalls: boolean,
): VaultAnswerRetryReason | undefined {
  if (hasToolCalls || hasPlanCard) return undefined
  if (intent !== 'organize') return undefined
  if (!task) return 'missing_tool_use'
  if (!vaultTaskStageAtLeast(task.stage, 'target_read')) return 'stalled_write_flow'
  return undefined
}

/**
 * intent 只允许 auto → organize 单向升级，写入任务进入 organize 后不得降级。
 * 用户本轮明确拒绝写入时绝不升级——模型越权产出的方案不能反过来改变授权边界。
 */
export function upgradeVaultIntent(
  current: VaultAgentIntent,
  input: { question: string; sawPlan: boolean; pendingTask: PendingVaultTask | null },
): VaultAgentIntent {
  if (current === 'organize') return 'organize'
  if (isVaultMutationExplicitlyDenied(input.question)) return current
  if (input.sawPlan) return 'organize'
  if (isStructuredNoteWriteIntent(input.question)) return 'organize'
  if (input.pendingTask?.intent === 'organize') return 'organize'
  return current
}

/**
 * 「对」「继续」「就这样」这类短确认视为承接上一轮任务：完整恢复工具结果并
 * 继承 intent。较长的新消息只携带任务元数据，由模型自行判断是否相关——新话题
 * 正常收尾时任务会被清空，绝不把旧目标硬塞进无关请求。
 */
export function isVaultTaskContinuation(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\s。，！!？?～~、.]/g, '')
    .toLocaleLowerCase()
  if (!normalized) return false
  if (normalized.length <= 6) return true
  return normalized.length <= 12 &&
    /^(?:对|嗯|好|行|可以|继续|接着|就这样|没问题|开始|去做|执行|确认|ok|okay|yes|go)/.test(normalized)
}

/** 云端工具轮标记：v0.7.35 起第 0 轮不挂云端写工具，模型判断需要时单独输出。 */
export const CLOUD_TOOLS_TURN_MARKER = '<<<CLOUD_TOOLS_TURN>>>'

export function isCloudToolsTurnRequest(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.includes(CLOUD_TOOLS_TURN_MARKER)) return false
  // 标记必须单独成段出现；混在长答复里视为普通文本，避免模型两头下注。
  return trimmed.replace(CLOUD_TOOLS_TURN_MARKER, '').trim().length <= 120
}

export function isVaultAgentToolAllowed(
  name: VaultAgentToolName,
  access: { vault: boolean; localSkill: boolean },
): boolean {
  if (name === 'read_skill_file' || name === 'propose_skill_action') return access.localSkill
  return access.vault
}

/** 只提取插件本机工具明确返回的确定性 fact；普通搜索片段绝不能走直答。 */
export function deterministicVaultFactAnswer(
  results: VaultAgentToolResult[],
): string | undefined {
  for (const result of results) {
    if (!result.ok || result.name !== 'vault_search') continue
    const parsed = safeJsonObject(result.output)
    const fact = parsed?.fact
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) continue
    const excerpt = shortText((fact as Record<string, unknown>).excerpt, 4_000)
    if (excerpt) return excerpt
  }
  return undefined
}

const TOOL_BLOCK_RE =
  /<<<VAULT_TOOL_CALLS>>>\s*([\s\S]*?)\s*<<<VAULT_TOOL_CALLS_END>>>/g
const PLAN_BLOCK_RE =
  /<<<VAULT_ORGANIZE_PLAN>>>\s*([\s\S]*?)\s*<<<VAULT_ORGANIZE_PLAN_END>>>/g

const TOOL_NAMES = new Set<VaultAgentToolName>([
  'vault_search',
  'list_folder',
  'read_note',
  'read_skill_file',
  'propose_skill_action',
])

function cleaned(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function safeJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function shortText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function boundedContent(value: unknown, max = VAULT_NOTE_WRITE_MAX_CHARS): string | null {
  if (typeof value !== 'string') return null
  const content = value.trim()
  return content && content.length <= max ? content : null
}

function artifactExtension(path: string): string {
  const filename = path.split('/').at(-1) ?? ''
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLocaleLowerCase() : ''
}

export function normalizeVaultRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/^[\\/]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return null
  const raw = trimmed.replace(/\\/g, '/').replace(/\/+$/g, '')
  if (!raw || raw.length > 240 || /[\u0000-\u001f]/.test(raw)) return null
  const parts = raw.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        /[:*?"<>|]/.test(part),
    )
  ) {
    return null
  }
  return parts.join('/')
}

/**
 * 路径为什么被保护。null = 不受保护。
 *
 * 分开返回原因是因为「本地 Skill 目录」和其他几类保护性质不同：
 * 隐藏目录 / 回收站 / AGENTS.md 这些是**任何操作**都不许碰；
 * 而 Skill 目录只是不许 AI 读写里面的内容，**新建这个空文件夹本身是无害的**。
 * 见 shouldBlockPlanPath()。
 */
export type ProtectedVaultPathReason = 'hidden' | 'trash' | 'agent-file' | 'skills-root'

export function protectedVaultPathReason(
  path: string,
  localSkillsRoot = 'system/skills',
): ProtectedVaultPathReason | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const lower = normalized.toLocaleLowerCase()
  const root = localSkillsRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase()
  const basename = lower.split('/').at(-1) ?? ''
  if (lower === '.trash' || lower.startsWith('.trash/')) return 'trash'
  if (lower.split('/').some((part) => part.startsWith('.'))) return 'hidden'
  if (lower === 'trash' || lower.startsWith('trash/')) return 'trash'
  if (basename === 'agents.md' || basename === 'claude.md' || basename === '_sub-agent-summaries.md') {
    return 'agent-file'
  }
  if (root && (lower === root || lower.startsWith(`${root}/`))) return 'skills-root'
  return null
}

export function isProtectedVaultPath(path: string, localSkillsRoot = 'system/skills'): boolean {
  return protectedVaultPathReason(path, localSkillsRoot) !== null
}

/**
 * 整理方案里的某个路径要不要拦。
 *
 * 只有 create_folder 落在本地 Skill 目录时放行——新建空文件夹既读不到也覆盖不了
 * 任何 Skill 内容，而拦下来会让整份方案连坐失败。
 *
 * 背景（2026-08-17）：插件默认 localSkillsFolder = `05_System/Skills`，而「一键生成
 * 目录」由模型生成方案，它经常会把 `05_System/Skills` 一起列进去。旧逻辑只要方案里
 * 有一个受保护路径就把**整份 8 项方案**拒掉，用户看到「执行失败：方案涉及保护目录」，
 * 一个文件夹都建不出来。
 */
export function shouldBlockPlanPath(
  path: string,
  operationType: string,
  localSkillsRoot = 'system/skills',
): boolean {
  const reason = protectedVaultPathReason(path, localSkillsRoot)
  if (!reason) return false
  if (reason === 'skills-root' && operationType === 'create_folder') return false
  return true
}

export function extractVaultToolCalls(text: string): VaultToolCallExtraction {
  const calls: VaultAgentToolCall[] = []
  let invalid = false
  let sawBlock = false
  const cleanText = text.replace(TOOL_BLOCK_RE, (_match, rawJson: string) => {
    sawBlock = true
    const parsed = safeJsonObject(rawJson)
    const rawCalls = parsed && Array.isArray(parsed.calls) ? parsed.calls : null
    if (!rawCalls) {
      invalid = true
      return ''
    }
    for (const item of rawCalls.slice(0, VAULT_AGENT_MAX_CALLS_PER_ROUND)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        invalid = true
        continue
      }
      const record = item as Record<string, unknown>
      const id = shortText(record.id, 64)
      const name = shortText(record.name, 40) as VaultAgentToolName
      const args =
        record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
          ? (record.arguments as Record<string, unknown>)
          : {}
      if (!id || !TOOL_NAMES.has(name) || calls.some((call) => call.id === id)) {
        invalid = true
        continue
      }
      calls.push({ id, name, arguments: args })
    }
    if (rawCalls.length > VAULT_AGENT_MAX_CALLS_PER_ROUND || calls.length === 0) invalid = true
    return ''
  })
  if (text.includes('<<<VAULT_TOOL_CALLS>>>') && !sawBlock) invalid = true
  return { cleanText: cleaned(cleanText), calls, invalid }
}

function parsePlanOperation(value: unknown): VaultOrganizeOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = shortText(record.type, 32)
  const reason = shortText(record.reason, 240) || undefined
  if (type === 'create_folder') {
    const path = normalizeVaultRelativePath(record.path)
    return path ? { type, path, reason } : null
  }
  if (type === 'move') {
    const from = normalizeVaultRelativePath(record.from)
    const to = normalizeVaultRelativePath(record.to)
    if (!from || !to || from === to) return null
    return { type, from, to, reason }
  }
  if (type === 'trash_note') {
    const path = normalizeVaultRelativePath(record.path)
    return path ? { type, path, reason } : null
  }
  if (type === 'create_note' || type === 'append_note' || type === 'replace_note') {
    const path = normalizeVaultRelativePath(record.path)
    const content = boundedContent(record.content)
    return path && content ? { type, path, content, reason } : null
  }
  if (type === 'create_artifact') {
    const path = normalizeVaultRelativePath(record.path)
    const format = shortText(record.format, 12).toLocaleLowerCase() as ArtifactFormat
    const title = shortText(record.title, ARTIFACT_MAX_TITLE_CHARS)
    const content = boundedContent(record.content, ARTIFACT_MAX_CONTENT_CHARS)
    const themeValue = shortText(record.theme, 12).toLocaleLowerCase()
    const theme = (themeValue === 'brand' || themeValue === 'clean')
      ? themeValue as ArtifactTheme
      : undefined
    if (
      !path ||
      !ARTIFACT_FORMATS.includes(format) ||
      artifactExtension(path) !== format ||
      !title ||
      !content
    ) {
      return null
    }
    return { type, path, format, title, content, theme, reason }
  }
  if (type === 'create_presentation') {
    const basePath = normalizeVaultRelativePath(record.basePath)
    const title = shortText(record.title, PRESENTATION_MAX_TITLE_CHARS)
    const subtitle = shortText(record.subtitle, 260) || undefined
    const rawFormats = Array.isArray(record.formats) ? record.formats : []
    const formats = [...new Set(rawFormats.map((item) => shortText(item, 12).toLocaleLowerCase()))]
      .filter((item): item is PresentationFormat => PRESENTATION_FORMATS.includes(item as PresentationFormat))
    const rawSlides = Array.isArray(record.slides) ? record.slides : []
    const slides = rawSlides
      .map(normalizePresentationSlide)
      .filter((slide): slide is NonNullable<typeof slide> => Boolean(slide))
    if (
      !basePath ||
      /\.(?:html|pptx|pdf)$/i.test(basePath) ||
      !title ||
      formats.length === 0 ||
      formats.length !== rawFormats.length ||
      slides.length === 0 ||
      slides.length !== rawSlides.length ||
      slides.length > PRESENTATION_MAX_SLIDES
    ) {
      return null
    }
    const operation: CreatePresentationOperation = {
      type,
      basePath,
      formats,
      title,
      subtitle,
      theme: normalizePresentationTheme(record.theme),
      slides,
      reason,
    }
    if (presentationCharacterCount(operation) > PRESENTATION_MAX_TOTAL_CHARS) return null
    return operation
  }
  if (type === 'update_note') {
    const path = normalizeVaultRelativePath(record.path)
    const rawReplacements = Array.isArray(record.replacements) ? record.replacements : []
    const rawFrontmatter = record.frontmatter && typeof record.frontmatter === 'object' && !Array.isArray(record.frontmatter)
      ? (record.frontmatter as Record<string, unknown>)
      : null
    const frontmatterOld = rawFrontmatter ? boundedContent(rawFrontmatter.old, 12_000) : null
    const frontmatterNew = rawFrontmatter ? boundedContent(rawFrontmatter.new, 12_000) : null
    const frontmatter = rawFrontmatter && frontmatterOld && frontmatterNew && frontmatterOld !== frontmatterNew
      ? {
          old: frontmatterOld,
          new: frontmatterNew,
          reason: shortText(rawFrontmatter.reason, 240) || undefined,
        }
      : undefined
    if (
      !path ||
      rawReplacements.length > VAULT_NOTE_UPDATE_MAX_OPERATIONS ||
      (rawReplacements.length === 0 && !frontmatter) ||
      (rawFrontmatter && !frontmatter)
    ) {
      return null
    }
    const replacements = rawReplacements.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const replacement = item as Record<string, unknown>
      const oldText = boundedContent(replacement.old, 12_000)
      const newText = typeof replacement.new === 'string' && replacement.new.length <= 12_000
        ? replacement.new
        : null
      if (!oldText || newText === null || oldText === newText) return null
      return {
        old: oldText,
        new: newText,
        all: replacement.all === true || undefined,
        reason: shortText(replacement.reason, 240) || undefined,
      }
    })
    if (replacements.some((item) => item === null)) return null
    return {
      type,
      path,
      replacements: replacements.length > 0
        ? replacements as NonNullable<Extract<VaultOrganizeOperation, { type: 'update_note' }>['replacements']>
        : undefined,
      frontmatter,
      reason,
    }
  }
  return null
}

export function extractVaultOrganizePlan(text: string): VaultPlanExtraction {
  let plan: VaultOrganizePlan | undefined
  let invalid = false
  let sawBlock = false
  const cleanText = text.replace(PLAN_BLOCK_RE, (_match, rawJson: string) => {
    sawBlock = true
    if (plan) {
      invalid = true
      return ''
    }
    const parsed = safeJsonObject(rawJson)
    const rawOperations = parsed && Array.isArray(parsed.operations) ? parsed.operations : null
    if (!parsed || !rawOperations || rawOperations.length > VAULT_AGENT_MAX_PLAN_OPERATIONS) {
      invalid = true
      return ''
    }
    const operations = rawOperations
      .map(parsePlanOperation)
      .filter((operation): operation is VaultOrganizeOperation => Boolean(operation))
    if (operations.length !== rawOperations.length || operations.length === 0) {
      invalid = true
      return ''
    }
    const title = shortText(parsed.title, 80) || 'Vault 整理方案'
    const summary = shortText(parsed.summary, 800)
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.map((note) => shortText(note, 240)).filter(Boolean).slice(0, 8)
      : []
    plan = { title, summary, operations, notes }
    return ''
  })
  if (text.includes('<<<VAULT_ORGANIZE_PLAN>>>') && !sawBlock) invalid = true
  return { cleanText: cleaned(cleanText), plan, invalid }
}

export function operationLabel(operation: VaultOrganizeOperation): string {
  if (operation.type === 'create_folder') return `新建文件夹：${operation.path}`
  if (operation.type === 'trash_note') return `移入回收站：${operation.path}`
  if (operation.type === 'create_note') return `新建笔记：${operation.path}`
  if (operation.type === 'append_note') return `追加到笔记：${operation.path}`
  if (operation.type === 'replace_note') return `整篇覆盖笔记：${operation.path}`
  if (operation.type === 'update_note') return `局部更新笔记：${operation.path}`
  if (operation.type === 'create_artifact') return `生成 ${operation.format.toUpperCase()}：${operation.path}`
  if (operation.type === 'create_presentation') return `生成演示文稿：${operation.basePath}（${operation.formats.join('/').toUpperCase()}）`
  return `移动/重命名：${operation.from} → ${operation.to}`
}

/** 模型可能跨轮复用 ID；插件本机加轮次和序号后再累计回传。 */
export function namespaceVaultToolCalls(
  calls: VaultAgentToolCall[],
  round: number,
): VaultAgentToolCall[] {
  return calls.map((call, index) => ({
    ...call,
    id: `r${round + 1}-${index + 1}-${call.id}`.slice(0, 64),
  }))
}

function isDraftOnlyWriteIntent(normalized: string): boolean {
  return /(?:输出|生成|整理|改写|优化).{0,60}(?:可(?:以)?|用于|供|方便)(?:直接)?(?:写入|写进|追加|保存).{0,30}(?:草稿|章节|内容|版本)/.test(
    normalized,
  )
}

/** 只用于拒绝越权方案，不参与“是否给 Luna 工具”的能力路由。 */
export function isVaultMutationExplicitlyDenied(text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
  if (
    /(?:确认|同意|批准|我点确认).{0,12}(?:前|之前).{0,8}(?:不要|别)(?:真的)?(?:写入|写进|追加|保存|更新)/.test(
      normalized,
    )
  ) {
    return false
  }
  return (
    isDraftOnlyWriteIntent(normalized) ||
    /(?:先|暂时|现在)?(?:不要|别)(?:再)?(?:帮我)?(?:直接|真的|立刻|立即)?(?:写入|写进|追加|保存|新建|创建|更新|移动|改名|重命名|删除|删掉)/.test(
      normalized,
    ) ||
    /(?:只|仅)(?:需要|要|做)?(?:读取|查找|搜索|分析|总结|生成|输出).{0,24}(?:草稿|建议|方案|内容|结果)?/.test(
      normalized,
    )
  )
}

/** 删除必须由用户本轮明确说出；检索到的笔记内容不能替用户授予回收站权限。 */
export function isExplicitVaultTrashIntent(text: string): boolean {
  if (isVaultMutationExplicitlyDenied(text)) return false
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  return /(?:删除|删掉|移入(?:废纸篓|回收站)|放入(?:废纸篓|回收站)|丢到(?:废纸篓|回收站)|\b(?:delete|trash)\b)/.test(
    normalized,
  )
}

export function detectVaultAgentIntent(text: string): VaultAgentIntent {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  if (isStructuredNoteWriteIntent(text)) return 'organize'
  // “确认前不要写入”是在要求预览 + 二次确认的安全写入流程，不等于取消写入。
  // 这类句子通常同时点名准确目标和追加/写入动作，必须先进入 organize，
  // 否则模型会只口头说“已读取”，却不给真正可执行的确认卡。
  if (
    /(?:确认|同意|批准|我点确认).{0,12}(?:前|之前).{0,8}(?:不要|别)(?:真的)?(?:写入|写进|追加|保存|更新)/.test(normalized) &&
    /(?:追加到|写入|写进|保存到|更新到|更新进|新建|创建).{0,80}(?:\.md|wiki|知识库|客户档案|学员档案|笔记|文档|文件)/.test(normalized)
  ) {
    return 'organize'
  }
  if (/(?:不要|别)(?:再)?(?:帮我)?(?:先|直接|现在|立刻|立即)?(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站|写入|写进|追加|保存|新建|创建|更新)/.test(normalized)) return 'answer'
  if (isDraftOnlyWriteIntent(normalized)) return 'answer'
  return /(?:请|帮我|把|将|需要|想要|能否|可以).*?(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)|^(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)|(?:写入|追加到|保存到|新建|创建|更新).{0,40}(?:wiki|知识库|客户档案|学员档案|笔记|文档|文件)|(?:wiki|知识库|客户档案|学员档案|笔记|文档|文件).{0,40}(?:写入|追加|保存|新建|创建|更新)|\b(?:organize|move|rename|reorganize|delete|trash)\b/.test(
    normalized,
  )
    ? 'organize'
    : 'answer'
}

/**
 * YAML/frontmatter、模板结构或客户档案字段不能走只修改正文的旧补丁协议。
 * 这些明确请求必须进入带预检和二次确认的单笔记写入流程。
 */
export function isStructuredNoteWriteIntent(text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const edit = /(?:修改|更新|补全|完善|统一|套用|按照|按|改成|改为|新增|添加|写入|覆盖)/.test(normalized)
  const structure = /(?:yaml|frontmatter|文档属性|笔记属性|属性字段|统一模板|固定模板|客户档案模板|学员档案模板|tags?\b)/.test(normalized)
  const customerProfile = /(?:客户档案|学员档案)/.test(normalized) && /(?:字段|模板|格式|结构|客户称呼|真实姓名|档案状态|咨询次数|咨询日期|报名日期|到期日期|续费日期|推荐人|微信id|手机号)/.test(normalized)
  return edit && (structure || customerProfile)
}

/**
 * 明确要求删除当前打开的单篇笔记时，插件可直接使用已经锁定的 noteContext.path
 * 生成本机确认方案，不再让模型猜路径。这样既避免耗时工具循环，也保证用户切换
 * 标签页后仍然只处理发送瞬间锁定的那篇笔记。
 */
export function isExplicitCurrentNoteTrashRequest(text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
  if (detectVaultAgentIntent(text) !== 'organize') return false
  const trashAction = /(?:删除|删掉|移入(?:废纸篓|回收站)|放入(?:废纸篓|回收站)|丢到(?:废纸篓|回收站)|\b(?:delete|trash)\b)/.test(
    normalized,
  )
  const currentTarget = /(?:当前|这篇|本篇|这份|这个|正在打开|刚打开|打开的).{0,10}(?:笔记|文章|文件)|(?:把|将)(?:它|这篇|这个|这份)(?:删除|删掉|移入|放入|丢到)/.test(
    normalized,
  )
  return trashAction && currentTarget
}

function isVaultCountQuestion(text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  return /(?:多少|几\s*(?:场|次|份|篇|个|条)|数量|统计|一共|总共|合计)/.test(normalized)
}

/**
 * 防止模型把“稍后再回答”或没有数字的统计承诺当成最终答案。
 *
 * 这里只做协议级完成校验，不判断答案是否正确；准确性仍由本机全量统计、
 * list_folder/read_note 等确定性工具和最终证据共同保证。
 */
/**
 * 句级结构判定：最终答复的收尾句是否在宣告「我接下来还要做本机动作」。
 * 一个真正完成的回答不会以宣告后续读取/整理收尾；面向用户的建议
 * （句中含「你/您」）不算。这比逐词扩充承诺正则稳健：换措辞逃不掉句式。
 */
export function isTrailingActionAnnouncement(answer: string): boolean {
  const normalized = answer.normalize('NFKC').replace(/\s+/g, '').trim()
  const sentences = normalized.split(/[。！？!?]/).filter(Boolean)
  const last = sentences.at(-1) ?? ''
  if (!last) return false
  // 「建议你继续读」＝用户是执行者，豁免；「给你一份预览」的你只是接收者，不豁免。
  if (/[你您](?:们)?[^，,；;]{0,4}(?:继续|再|先|去|可以|试|读|查|看|翻)/.test(last)) return false
  // 「需要的话我可以继续…」是条件式主动提议，不是把承诺当结论。
  if (/(?:需要|如果|若|要不要|想不想|吗)/.test(last)) return false
  return (
    /我/.test(last) &&
    /(?:继续|接下来|然后|稍后|随后|下一步|现在|马上|立刻|这就|先)/.test(last) &&
    /(?:读取|检索|搜索|查|核对|翻阅|整理|生成|输出|追加|写入|补进|补充|更新)/.test(last)
  )
}

export function vaultAnswerRetryReason(
  question: string,
  answer: string,
): VaultAnswerRetryReason | undefined {
  if (isTrailingActionAnnouncement(answer)) return 'deferred_answer'
  const normalized = answer.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const deferred =
    /(?:等我|待我|稍后|接下来|下一步|我先|我会继续).{0,120}(?:查|检索|核对|去重|统计|检查|读取|翻阅).{0,120}(?:再|然后|之后|后|就会).{0,80}(?:给你|告诉你|回复|回答|汇报|输出|准确|结果|结论|场次|数量)/.test(
      normalized,
    ) ||
    /^(?:我先|接下来|下一步|稍后).{0,100}(?:查|检索|核对|去重|统计|检查|读取|翻阅)[。！.!]?$/.test(
      normalized,
    ) ||
    /(?:^|[。！；;])\s*(?:我)?(?:继续|接着).{0,180}(?:查|检索|核对|统计|检查|读取|翻阅).{0,180}(?:再|然后|之后).{0,80}(?:去重|核对|统计|确认|回答)[。！.!]?$/.test(
      normalized,
    )
  if (deferred) return 'deferred_answer'

  if (!isVaultCountQuestion(question)) return undefined
  const consultationQuestion = /(?:咨询|私教|辅导|多少\s*场|几\s*场)/.test(
    question.normalize('NFKC'),
  )
  const hasCount = new RegExp(
    `(?:\\d+|[零〇一二两三四五六七八九十百千万]+)\\s*(?:${
      consultationQuestion ? '场|次' : '场|次|份|篇|个|条'
    })`,
  ).test(normalized)
  const hasExplicitLimit =
    /(?:无法|不能|资料不足|记录不足|未找到|没有找到|缺少).{0,80}(?:准确|统计|确认|判断|回答|场次|数量|记录|资料)/.test(
      normalized,
    )
  return hasCount || hasExplicitLimit ? undefined : 'missing_count'
}

/**
 * 自主工具判断模式下的结果完整性护栏。它不决定是否进入 Vault 模式，只阻止
 * 模型谎称“已经搜索/读取/写入”或错误声称自己没有权限。
 *
 * 阶段 A（2026-08-17）：不再因为“已有任意一条工具结果”就整轮豁免——那正是
 * “搜到目标却不读原文就收尾”能通过的原因。有工具结果时仍拦两类谎报：
 * 声称无权限、声称已写入/将写入（写入只能以确认卡结束，由结构化判定把关）。
 */
export function vaultAutoAnswerRetryReason(
  answer: string,
  hasVaultToolResults: boolean,
): VaultAnswerRetryReason | undefined {
  const normalized = answer.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (hasVaultToolResults) {
    const claimsWriteDone =
      /(?:已经|已|刚刚)(?:帮你)?(?:写入|追加|更新|修改|覆盖|保存)(?:到|进)?.{0,40}(?:档案|笔记|文件|知识库|wiki)/i.test(
        normalized,
      )
    return claimsWriteDone ? 'missing_tool_use' : undefined
  }
  const unsupportedClaim =
    /(?:我|这里|当前)(?:暂时)?(?:无法|不能|没法|没有权限).{0,30}(?:访问|搜索|检索|扫描|读取|查看|打开|修改|改写|更新|追加|覆盖|写入).{0,30}(?:vault|obsidian|知识库|本地|文件|笔记|档案|逐字稿)/i.test(
      normalized,
    )
  const ungroundedSuccess =
    /(?:我(?:已经|刚刚|已)?|已经|刚刚)(?:在.{0,20})?(?:搜索|检索|扫描|读取|查看|打开|找到|定位到|修改|更新|追加|覆盖|写入|新建|创建).{0,50}(?:vault|obsidian|知识库|本地|文件|笔记|档案|逐字稿)/i.test(
      normalized,
    )
  const ungroundedWritePromise =
    /(?:收到[，,。 ]*)?(?:我|这边)(?:现在|马上|立即|已经|已|刚刚|这就|会|将|把).{0,100}(?:追加|写入|更新|修改|改写|覆盖|新建|创建).{0,60}(?:vault|obsidian|知识库|本地|文件|笔记|档案)/i.test(
      normalized,
    )
  return unsupportedClaim || ungroundedSuccess || ungroundedWritePromise
    ? 'missing_tool_use'
    : undefined
}

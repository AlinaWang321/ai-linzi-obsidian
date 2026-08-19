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
  type ArtifactLayout,
  type ArtifactTheme,
  type CreateArtifactOperation,
} from './artifact-renderer-core'

/**
 * 2026-08-18 Alina 拍板开放（打卡营实测：批量/长文档整理在 6 轮 + 10 万字符下
 * 反复撞「总量超出安全上限」）：轮次 6→12，本机结果预算 10 万→36 万字符。
 * Luna 上下文 105 万 token（输入 92.2 万），预算远未触顶；成本由用户积分承担，
 * Alina 明确接受。预算用尽不再报错断头，改为提示模型立即收尾（见下方函数）。
 */
export const VAULT_AGENT_MAX_ROUNDS = 12
export const VAULT_AGENT_MAX_CALLS_PER_ROUND = 4
export const VAULT_AGENT_MAX_TOTAL_RESULT_CHARS = 360_000
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
  /** 用户确认执行后本机失败的原因；下一轮开场作为合成工具结果一次性交回模型。 */
  lastExecuteError?: { planTitle: string; message: string; at: number }
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
  // 0.7.54：短消息也必须过确认词表。旧实现对任意 ≤6 字消息无条件返回 true，
  // 用户在有未完成整理任务时问「今天天气怎样」也会被当成「继续上一轮」，
  // 插件回去翻旧文件（与本函数注释承诺的「绝不把旧目标硬塞进无关请求」相悖）。
  return normalized.length <= 12 &&
    /^(?:对|嗯|好|行|可以|继续|接着|就这样|没问题|开始|去做|执行|确认|全部|都|一起|剩下|其余|ok|okay|yes|go)/.test(normalized)
}

/** 云端工具轮标记：v0.7.35 起第 0 轮不挂云端写工具，模型判断需要时单独输出。 */
export const CLOUD_TOOLS_TURN_MARKER = '<<<CLOUD_TOOLS_TURN>>>'

export function isCloudToolsTurnRequest(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.includes(CLOUD_TOOLS_TURN_MARKER)) return false
  // 标记必须单独成段出现；混在长答复里视为普通文本，避免模型两头下注。
  return trimmed.replace(CLOUD_TOOLS_TURN_MARKER, '').trim().length <= 120
}

/**
 * 模型自主切换文件操作引擎的标记（0.7.52，与 CLOUD_TOOLS_TURN 同款两段式）。
 * 背景：意图词表连漏四轮（把/处理/给我/「名字前面加上日期」），而模型本人每次
 * 都听懂了需求——判断权交还给模型，词表只做兜底快路径。
 */
export const VAULT_NATIVE_TURN_MARKER = '<<<VAULT_NATIVE_TURN>>>'

export function isVaultNativeTurnRequest(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.includes(VAULT_NATIVE_TURN_MARKER)) return false
  return trimmed.replace(VAULT_NATIVE_TURN_MARKER, '').trim().length <= 120
}

export function isVaultAgentToolAllowed(
  name: VaultAgentToolName,
  access: { vault: boolean; localSkill: boolean },
): boolean {
  if (name === 'read_skill_file' || name === 'propose_skill_action') return access.localSkill
  return access.vault
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
  localSkillsRoot = '05_System/Skills',
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
  // 0.7.54：当前配置根之外，旧默认目录 system/skills 也一并保护——老用户的技能可能
  // 还留在那里（技能有独立调用通道，正文绝不能被当普通资料读写）。
  for (const skillsRoot of [root, 'system/skills']) {
    if (skillsRoot && (lower === skillsRoot || lower.startsWith(`${skillsRoot}/`))) return 'skills-root'
  }
  return null
}

export function isProtectedVaultPath(path: string, localSkillsRoot = '05_System/Skills'): boolean {
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
  localSkillsRoot = '05_System/Skills',
): boolean {
  const reason = protectedVaultPathReason(path, localSkillsRoot)
  if (!reason) return false
  if (reason === 'skills-root' && operationType === 'create_folder') return false
  return true
}

/** 预检时对 Vault 的最小只读视图：某个路径当前是什么。 */
export type VaultPathKind = 'file' | 'folder' | null

/**
 * 整理方案（新建文件夹/移动/删除）的本机预检：在渲染确认卡之前把注定执行
 * 失败的方案拦下来，并一次列出全部问题，反馈给模型自我纠正。
 *
 * 背景（2026-08-17 客户反馈）：模型跳过 list_folder 直接猜路径时，旧流程要等
 * 用户点「确认执行」才在 applyPlan 里抛「源文件不存在」，且错误只弹 Notice，
 * 模型毫不知情，下一轮继续口头答应。本函数只校验不执行；applyPlan 在确认
 * 瞬间仍按同样规则复检（确认前本地状态可能变化）。校验口径必须与 applyPlan
 * 一致，改任何一边都要同步另一边。
 */
export function collectOrganizePlanProblems(
  plan: VaultOrganizePlan,
  pathKind: (path: string) => VaultPathKind,
  localSkillsRoot = '05_System/Skills',
): string[] {
  const problems: string[] = []
  const push = (text: string) => {
    if (!problems.includes(text)) problems.push(text)
  }
  const opCount = plan.operations.length
  const trashOps = plan.operations.filter(
    (operation): operation is Extract<VaultOrganizeOperation, { type: 'trash_note' }> =>
      operation.type === 'trash_note',
  )
  const noteWriteOps = plan.operations.filter(
    (operation): operation is Extract<
      VaultOrganizeOperation,
      { type: 'create_note' | 'append_note' | 'replace_note' | 'update_note' }
    > =>
      operation.type === 'create_note' ||
      operation.type === 'append_note' ||
      operation.type === 'replace_note' ||
      operation.type === 'update_note',
  )
  const artifactOps = plan.operations.filter(
    (operation): operation is CreateArtifactOperation => operation.type === 'create_artifact',
  )
  const moveOps = plan.operations.filter(
    (operation): operation is Extract<VaultOrganizeOperation, { type: 'move' }> =>
      operation.type === 'move',
  )
  const createOps = plan.operations.filter(
    (operation): operation is Extract<VaultOrganizeOperation, { type: 'create_folder' }> =>
      operation.type === 'create_folder',
  )

  for (const operation of plan.operations) {
    // create_artifact 的实际落盘路径依赖输出根目录设置，由 validateArtifactOperation 单独校验。
    if (operation.type === 'create_artifact') continue
    const paths = operation.type === 'move' ? [operation.from, operation.to] : [operation.path]
    for (const path of paths) {
      if (shouldBlockPlanPath(path, operation.type, localSkillsRoot)) {
        push(`方案涉及保护目录，已拒绝：${path}`)
      }
    }
  }
  // v0.7.42 起：回收站方案允许批量、允许任意文件类型和文件夹，但必须
  // 纯删除成卡（不与移动/新建/写入混排），确认卡文案才能与行为一致。
  if (trashOps.length > 0 && trashOps.length !== opCount) {
    push('移入回收站的方案不能混入移动、新建等其他操作，请拆成两次确认')
  }
  if (noteWriteOps.length > 0 && opCount !== 1) {
    push('为避免跨文件误写，每次确认只能写入一篇 Markdown 笔记，不能混入其他操作')
  }
  if (artifactOps.length > 0 && opCount !== 1) {
    push('为避免误写，每次确认只能生成一个成品文件，不能混入其他操作')
  }
  const trashTargets = new Set<string>()
  for (const operation of trashOps) {
    if (trashTargets.has(operation.path)) push(`重复的删除目标：${operation.path}`)
    trashTargets.add(operation.path)
    if (!pathKind(operation.path)) {
      push(`没有找到要移入回收站的文件或文件夹：${operation.path}`)
    }
  }
  for (const path of trashTargets) {
    for (const other of trashTargets) {
      if (path !== other && path.startsWith(`${other}/`)) {
        push(`「${path}」已在待删除文件夹「${other}」内，请去掉重复项`)
      }
    }
  }
  for (const operation of noteWriteOps) {
    if (artifactExtension(operation.path) !== 'md') {
      push('跨文件写入只允许 Markdown 笔记，不能修改附件或其他文件类型')
      continue
    }
    const kind = pathKind(operation.path)
    if (operation.type === 'create_note') {
      if (kind) push(`目标笔记已存在，绝不覆盖：${operation.path}`)
    } else if (kind !== 'file') {
      push(`没有找到要写入的笔记：${operation.path}`)
    }
  }
  const sources = new Set<string>()
  const destinations = new Set<string>()
  for (const operation of moveOps) {
    if (sources.has(operation.from)) push(`重复移动同一路径：${operation.from}`)
    if (destinations.has(operation.to)) push(`多个文件指向同一位置：${operation.to}`)
    sources.add(operation.from)
    destinations.add(operation.to)
    const sourceKind = pathKind(operation.from)
    if (!sourceKind) {
      push(`源文件不存在：${operation.from}`)
      continue
    }
    if (pathKind(operation.to)) push(`目标已存在，绝不覆盖：${operation.to}`)
    if (sourceKind === 'file' && artifactExtension(operation.from) !== artifactExtension(operation.to)) {
      push(`移动/重命名不能改变文件类型：${operation.from}`)
    }
    if (sourceKind === 'folder' && operation.to.startsWith(`${operation.from}/`)) {
      push(`不能把文件夹移动到自己内部：${operation.from}`)
    }
  }
  const moveSources = [...sources]
  for (let index = 0; index < moveSources.length; index++) {
    for (let other = index + 1; other < moveSources.length; other++) {
      if (
        moveSources[index].startsWith(`${moveSources[other]}/`) ||
        moveSources[other].startsWith(`${moveSources[index]}/`)
      ) {
        push('同一方案不能同时移动父文件夹和其中的子文件，请让 AI 拆成两次')
      }
    }
  }
  // 执行时 ensureFolder 会自动补建缺失的父目录；只有「路径段已被文件占用」会失败。
  const ensureFolderConflicts = (path: string) => {
    if (!path) return
    let current = ''
    for (const segment of path.split('/')) {
      current = current ? `${current}/${segment}` : segment
      if (pathKind(current) === 'file') push(`目标父路径不是文件夹：${current}`)
    }
  }
  for (const operation of createOps) ensureFolderConflicts(operation.path)
  for (const operation of moveOps) {
    ensureFolderConflicts(operation.to.split('/').slice(0, -1).join('/'))
  }
  for (const operation of noteWriteOps) {
    ensureFolderConflicts(operation.path.split('/').slice(0, -1).join('/'))
  }
  return problems
}

/**
 * 用户点「确认执行」后本机执行失败时，把失败原因作为下一轮的合成工具结果交回
 * 模型（复用 read_note 结果通道，服务端按既有校验放行）。没有这一步，失败只
 * 出现在 9 秒的 Notice 里，模型毫不知情，只会继续口头答应。
 */
export const VAULT_AGENT_BUDGET_EXHAUSTED_NOTE =
  '本机工具结果预算已用满，不能再读取更多内容。请立即基于已读材料收尾：' +
  '整理/写入任务现在就产出待确认方案；材料不够就说明还差哪些、建议用户分批处理。不要再请求任何工具。'

/**
 * 把新一批工具结果并入累计列表（2026-08-18 预算开放配套）：
 * ① 内容完全相同的重复读取（承接回灌 + 模型重复读同一段）只保留一份，不重复占预算；
 * ② 超出预算时截断最后一条并追加「预算已用满」提示，让模型立即收尾——
 *    此前是整轮 400 报错断头（「Vault 工具结果总量超出安全上限」），任务全部作废。
 * exhausted 为真后调用方应关闭后续工具轮（canRequestTools=false）。
 */
export function appendToolResultsWithinBudget(
  existing: VaultAgentToolResult[],
  incoming: VaultAgentToolResult[],
  cap = VAULT_AGENT_MAX_TOTAL_RESULT_CHARS,
): { results: VaultAgentToolResult[]; exhausted: boolean } {
  const results = [...existing]
  const seen = new Set(
    results.filter((item) => item.ok).map((item) => `${item.name}\n${item.output}`),
  )
  let total = results.reduce((sum, item) => sum + item.output.length, 0)
  let exhausted = false
  for (const item of incoming) {
    const key = `${item.name}\n${item.output}`
    if (item.ok && seen.has(key)) continue
    const remaining = cap - total
    if (remaining <= 0) {
      exhausted = true
      break
    }
    if (item.output.length > remaining) {
      const output = `${item.output.slice(0, Math.max(0, remaining - 40))}…[已达本机结果预算上限，内容截断]`
      results.push({ ...item, output })
      total += output.length
      exhausted = true
      break
    }
    results.push(item)
    if (item.ok) seen.add(key)
    total += item.output.length
  }
  if (exhausted && !results.some((item) => item.output === VAULT_AGENT_BUDGET_EXHAUSTED_NOTE)) {
    results.push({
      callId: `budget-exhausted-${results.length + 1}`,
      name: 'read_note',
      ok: false,
      output: VAULT_AGENT_BUDGET_EXHAUSTED_NOTE,
    })
  }
  return { results, exhausted }
}

export function buildVaultExecuteFailureToolResult(
  planTitle: string,
  errorMessage: string,
): VaultAgentToolResult {
  return {
    callId: 'vault-execute-failure',
    name: 'read_note',
    ok: false,
    output:
      `用户已确认执行整理方案「${planTitle.slice(0, 60)}」，但本机执行失败：${errorMessage.slice(0, 400)}。` +
      '请先用 list_folder 或 vault_search 核对真实路径与现状，再生成修正后的新方案；' +
      '不要原样重复失败的方案，也不要声称已完成。',
  }
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
    // 0.7.54：HTML 版式（document 长文 / dashboard 交互看板）；不合法值一律忽略，
    // 交由 resolveArtifactLayout 按内容特征自动判断。
    const layoutValue = shortText(record.layout, 12).toLocaleLowerCase()
    const layout = (layoutValue === 'document' || layoutValue === 'dashboard')
      ? layoutValue as ArtifactLayout
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
    return { type, path, format, title, content, theme, layout, reason }
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

/**
 * 「用户明确拒绝动文件」的唯一真相源（0.7.54）。
 *
 * 此前同一语义在两处各写一份词表且内容不同：意图判定那份含「整理/归档/分类/移入回收站」，
 * 越权拦截那份没有 → 「别把这些文件整理了」两道闸门同时漏，插件照样启动整理引擎、
 * 最后弹一张用户刚拒绝的方案卡（白烧 12 轮积分且违背指令）。
 * 同时放宽否定词与动词之间的距离：旧正则要求动词紧跟在「不要/别」后面，中间一插宾语
 * （「别把这些文件整理了」）就漏。
 */
const NEGATED_MUTATION_VERBS =
  '整理|归类|归档|分类|移动|移入回收站|移到|移进|挪到|放到|放进|放入|归到|收进|重命名|改名|删除|删掉|写入|写进|追加|保存|新建|创建|更新'
const NEGATED_MUTATION_RE = new RegExp(
  `(?:不要|不用|无需|别|勿)[^。，,！!？?；;]{0,16}?(?:${NEGATED_MUTATION_VERBS})`,
)

export function isNegatedVaultMutation(text: string): boolean {
  return NEGATED_MUTATION_RE.test(text.normalize('NFKC').toLocaleLowerCase())
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
  // 「整理这批文件，仅生成一份清单」这类句子里的「仅生成」是对产出形态的限定，
  // 不是拒绝写入。旧正则尾组整体可选 + 前面无排他，导致这类正常整理请求被判成
  // 只读，方案一出就被拦、反复重试直到撞满轮次（0.7.54 修复）。
  const readOnlyOnly =
    /(?:^|[，,。；;])(?:只|仅)(?:需要|要|想|想要|帮我|给我|做)?(?:读取|查找|搜索|分析|总结)/.test(normalized) &&
    !/(?:整理|归类|分类|归档|移动|移到|挪到|重命名|改名|删除|删掉|写入|写进|追加|保存|新建|创建|更新)/.test(normalized)
  return (
    isDraftOnlyWriteIntent(normalized) ||
    isNegatedVaultMutation(normalized) ||
    readOnlyOnly
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
  if (isNegatedVaultMutation(normalized)) return 'answer'
  if (isDraftOnlyWriteIntent(normalized)) return 'answer'
  // 0.7.48 追加：「处理/放到 + 文件对象」也是整理请求（Alina 08-18 截图实测的
  // 第三批逃逸句式：「给我按照分类处理 raw 文件夹」「把它们放到 wiki 文件夹里去」）。
  // 疑问词豁免：「逐字稿怎么处理」这类请教型问题仍是普通问答，不得强制进整理流程。
  const fileHandlingAsk =
    /(?:处理|整理|归类|分类).{0,16}(?:文件夹|文件|资料|素材|逐字稿|raw|wiki)|(?:放到|放进|移到|移进|挪到|归到|整理到).{0,20}(?:wiki|知识库|文件夹|目录)|(?:文件名|文件|档案|笔记|名字).{0,12}(?:加上|加个|改成|改为|统一|重命名|命名)|(?:加上|统一|改成).{0,10}(?:日期|前缀|后缀|编号)/.test(
      normalized,
    ) && !/(?:怎么|如何|怎样|为什么|什么时候|该不该|要不要)/.test(normalized)
  return /(?:请|帮我|给我|把|将|需要|想要|能否|可以).*?(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)|^(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)|(?:写入|追加到|保存到|新建|创建|更新).{0,40}(?:wiki|知识库|客户档案|学员档案|笔记|文档|文件)|(?:wiki|知识库|客户档案|学员档案|笔记|文档|文件).{0,40}(?:写入|追加|保存|新建|创建|更新)|\b(?:organize|move|rename|reorganize|delete|trash)\b/.test(
    normalized,
  ) || fileHandlingAsk
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
  // 0.7.54：豁免必须锚定在句首条件从句或句尾疑问收尾——旧实现全句扫「需要/吗」，
  // 于是「我现在需要继续读取剩下的档案」这种典型空承诺被豁免掉（正是连报四次的
  // 「一直回复不执行」在收尾护栏上的漏洞）。
  if (/^(?:如果|若|要是|需要的话|需要我|要不要|想不想)/.test(last)) return false
  if (/(?:吗|呢)[？?]?$/.test(last) && !/我(?:现在|马上|立刻|这就|接下来)/.test(last)) return false
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

/**
 * 文件夹名的宽松匹配（0.7.59）。
 *
 * 用户口语里的目录名和磁盘上的真实目录名经常对不上：说「output」真实叫「03 output」，
 * 说「客户档案」真实是「02_Wiki/01_客户档案」。旧实现要求逐字相同，对不上就报
 * 「没有找到文件夹」，AI 只好一个个列目录去猜，表现成「反复说继续却不干活」。
 *
 * 归一化规则：去掉序号前缀（01_/02 /③）、忽略大小写、忽略下划线连字符空格的差异。
 * 只做名字匹配，不碰权限与保护规则——调用方仍会对结果再做保护目录校验。
 */
export function normalizeFolderKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[\s_\-.]*[0-9①-⑳]{1,3}[\s_\-.）)、.]*/u, '')
    .replace(/[\s_\-.]/g, '')
}

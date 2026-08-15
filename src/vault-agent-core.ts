/**
 * Vault agent public protocol + pure validation helpers.
 *
 * The model may only request these read tools. All filesystem access and every
 * mutation are validated and executed by the local Obsidian plugin.
 */

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
export type VaultAgentIntent = 'answer' | 'organize'

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
  | {
      type: 'update_note'
      path: string
      replacements: { old: string; new: string; all?: boolean; reason?: string }[]
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

export type VaultAnswerRetryReason = 'deferred_answer' | 'missing_count' | 'missing_tool_use'

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

export function isProtectedVaultPath(path: string, localSkillsRoot = 'system/skills'): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const lower = normalized.toLocaleLowerCase()
  const root = localSkillsRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase()
  const basename = lower.split('/').at(-1) ?? ''
  return (
    lower.split('/').some((part) => part.startsWith('.')) ||
    lower === 'trash' ||
    lower.startsWith('trash/') ||
    lower === '.trash' ||
    lower.startsWith('.trash/') ||
    basename === 'agents.md' ||
    basename === 'claude.md' ||
    basename === '_sub-agent-summaries.md' ||
    Boolean(root && (lower === root || lower.startsWith(`${root}/`)))
  )
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
  if (type === 'update_note') {
    const path = normalizeVaultRelativePath(record.path)
    const rawReplacements = Array.isArray(record.replacements) ? record.replacements : null
    if (!path || !rawReplacements || rawReplacements.length === 0 || rawReplacements.length > VAULT_NOTE_UPDATE_MAX_OPERATIONS) {
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
      replacements: replacements as Extract<VaultOrganizeOperation, { type: 'update_note' }>['replacements'],
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

export function detectVaultAgentIntent(text: string): VaultAgentIntent {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  if (/(?:不要|别)(?:再)?(?:帮我)?(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)/.test(normalized)) return 'answer'
  return /(?:请|帮我|把|将|需要|想要|能否|可以).*?(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)|^(?:整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站)|(?:写入|追加到|保存到|新建|创建|更新).{0,40}(?:wiki|知识库|客户档案|学员档案|笔记|文档|文件)|(?:wiki|知识库|客户档案|学员档案|笔记|文档|文件).{0,40}(?:写入|追加|保存|新建|创建|更新)|\b(?:organize|move|rename|reorganize|delete|trash)\b/.test(
    normalized,
  )
    ? 'organize'
    : 'answer'
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

/**
 * v0.7.17 起不再要求用户先找开关。只有文字明确指向本地 Vault/文件任务，
 * 或正在继续上一轮已经授权的 Vault 对话时，才允许进入本机工具循环。
 * 普通闲聊不会因此读取或发送任何 Vault 片段。
 */
export function shouldUseVaultAgent(text: string, continuingVaultTask = false): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
  if (detectVaultAgentIntent(text) === 'organize') return true
  const businessFileObject =
    /(?:咨询(?:交付|服务)?逐字稿|交付(?:顾问)?咨询逐字稿|销售逐字稿|谈单逐字稿|咨询记录|销售记录|客户档案|学员档案|客户资料|学员资料|聊天记录|会议逐字稿|课程逐字稿|直播逐字稿|访谈逐字稿)/.test(normalized)
  const explicitVaultObject =
    /(?:vault|obsidian|知识库|数字大脑|第二大脑|我的大脑|文件仓库|资料仓库|文档仓库|本地仓库)/.test(normalized) ||
    businessFileObject ||
    /(?:本地|我的|这个|那个|当前).{0,12}(?:笔记|文件|文件夹|目录|知识库|资料|文档|仓库)|(?:笔记|文件|文件夹|目录|知识库|资料库|文档|仓库).{0,12}(?:里|中|内|下|在哪里|在哪)/.test(normalized)
  const explicitVaultAction =
    /(?:搜索|搜一下|搜一搜|扫描|查找|查一下|查一查|查查|查阅|找一下|找一找|找出|找到|定位|在哪|哪里|有什么|哪些|翻找|读取|打开|查看|看看|列出|统计|汇总|盘点|总结|对比|整理|移动|重命名|改名|归档|分类|删除|删掉|移入回收站|写入|追加|保存到|新建|创建)/.test(normalized) ||
    (businessFileObject && /^(?:请|帮我|麻烦)?(?:处理|分析|复盘|提炼|优化)/.test(normalized))
  if (explicitVaultObject && explicitVaultAction) return true
  if (!continuingVaultTask) return false
  return /^(?:继续|再|那|这个|那个|它|它们|这些|那些|刚才|刚刚|上面|前面|这里|另外|然后|接着|同样|也|改成|移到|放到|归到|删掉|删除|移入回收站)/.test(normalized)
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
export function vaultAnswerRetryReason(
  question: string,
  answer: string,
): VaultAnswerRetryReason | undefined {
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

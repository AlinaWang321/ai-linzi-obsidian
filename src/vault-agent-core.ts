/**
 * Vault agent public protocol + pure validation helpers.
 *
 * The model may only request these read tools. All filesystem access and every
 * mutation are validated and executed by the local Obsidian plugin.
 */

export const VAULT_AGENT_MAX_ROUNDS = 6
export const VAULT_AGENT_MAX_CALLS_PER_ROUND = 4
export const VAULT_AGENT_MAX_PLAN_OPERATIONS = 60

export type VaultAgentToolName = 'vault_search' | 'list_folder' | 'read_note'
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

export interface VaultOrganizePlan {
  title: string
  summary: string
  operations: VaultOrganizeOperation[]
  notes: string[]
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

export type VaultAnswerRetryReason = 'deferred_answer' | 'missing_count'

const TOOL_BLOCK_RE =
  /<<<VAULT_TOOL_CALLS>>>\s*([\s\S]*?)\s*<<<VAULT_TOOL_CALLS_END>>>/g
const PLAN_BLOCK_RE =
  /<<<VAULT_ORGANIZE_PLAN>>>\s*([\s\S]*?)\s*<<<VAULT_ORGANIZE_PLAN_END>>>/g

const TOOL_NAMES = new Set<VaultAgentToolName>([
  'vault_search',
  'list_folder',
  'read_note',
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
  return operation.type === 'create_folder'
    ? `新建文件夹：${operation.path}`
    : `移动/重命名：${operation.from} → ${operation.to}`
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
  if (/不要(?:整理|移动|重命名|改名|归档|分类)/.test(normalized)) return 'answer'
  return /(?:请|帮我|把|将|需要|想要|能否|可以).*?(?:整理|移动|重命名|改名|归档|分类)|\b(?:organize|move|rename|reorganize)\b/.test(
    normalized,
  )
    ? 'organize'
    : 'answer'
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

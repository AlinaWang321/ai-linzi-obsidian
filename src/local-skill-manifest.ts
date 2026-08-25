import type { LocalSkillOutput } from './local-skill-core'
import type { PluginContextMode } from './plugin-context-policy'

export type LocalSkillVaultReadScope =
  | 'current-note'
  | 'user-specified-files'
  | 'user-specified-folder'
  | 'whole-vault'

export interface LocalSkillVaultReadPolicy {
  scope: LocalSkillVaultReadScope
  /** 旧 manifest 兼容字段；新安装不再保存固定文件夹，运行时点名范围只影响当轮搜索顺序。 */
  fixedFolder?: string
  /** 允许只列出 Vault 路径、类型和修改时间；不允许读取或搜索正文。 */
  metadataDiscovery: boolean
  /** 有用户指定文件夹时先查该范围；这不是权限边界。 */
  preferUserScope: boolean
  /** 指定范围没有命中时是否允许继续搜索整个 Vault。 */
  fallbackToWholeVault: boolean
  /** 单轮最多完整读取的文件数；搜索目录与 Bloom 索引不计入正文读取。 */
  maxFiles: number
}

export interface LocalSkillVaultWritePolicy {
  mode: LocalSkillOutput | 'none'
  confirmation: 'single-atomic-plan'
  overwrite: false
}

export interface LocalSkillRuntimePolicy {
  schemaVersion: 1 | 2
  source: 'structured-v2' | 'legacy-v1'
  vaultRead: LocalSkillVaultReadPolicy
  vaultWrite: LocalSkillVaultWritePolicy
  network: 'none' | 'ai-linzi-only'
  /** 控制服务端预加载哪些个人上下文；不改变本机 Vault 读取权限。 */
  contextMode?: PluginContextMode
}

export type LocalSkillManifestResult =
  | { kind: 'missing' }
  | { kind: 'valid'; policy: LocalSkillRuntimePolicy }
  | { kind: 'invalid'; message: string }

const READ_SCOPES = new Set<LocalSkillVaultReadScope>([
  'current-note',
  'user-specified-files',
  'user-specified-folder',
  'whole-vault',
])
const WRITE_MODES = new Set<LocalSkillVaultWritePolicy['mode']>([
  'none', 'chat', 'create-note', 'update-current-note', 'create-artifact',
])
const CONTEXT_MODES = new Set<PluginContextMode>([
  'source-only', 'personalized-content', 'business-coach', 'vault-data',
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function permissions(value: Record<string, unknown>): string[] {
  return Array.isArray(value.permissions)
    ? value.permissions.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : []
}

function boundedMaxFiles(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  if (!Number.isInteger(value)) return null
  const parsed = Number(value)
  return parsed >= 1 && parsed <= 200 ? parsed : null
}

function defaultMaxFiles(scope: LocalSkillVaultReadScope): number {
  if (scope === 'current-note') return 1
  if (scope === 'user-specified-files') return 12
  if (scope === 'user-specified-folder') return 80
  return 120
}

function normalizedFixedFolder(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (
    !normalized ||
    normalized.startsWith('.') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) return null
  return normalized
}

function parseV2(value: Record<string, unknown>, expectedOutput: LocalSkillOutput): LocalSkillManifestResult {
  const read = record(value.vaultRead)
  const write = record(value.vaultWrite)
  if (!read || !write) {
    return { kind: 'invalid', message: 'manifest v2 缺少 vaultRead 或 vaultWrite' }
  }
  const scope = read.scope
  if (typeof scope !== 'string' || !READ_SCOPES.has(scope as LocalSkillVaultReadScope)) {
    return { kind: 'invalid', message: 'manifest v2 的 vaultRead.scope 无效' }
  }
  const typedScope = scope as LocalSkillVaultReadScope
  const fixedFolder = normalizedFixedFolder(read.fixedFolder)
  if (fixedFolder === null) {
    return { kind: 'invalid', message: 'manifest v2 的 vaultRead.fixedFolder 不是安全的 Vault 相对文件夹' }
  }
  if (
    fixedFolder !== undefined &&
    typedScope !== 'user-specified-folder' &&
    typedScope !== 'whole-vault'
  ) {
    return { kind: 'invalid', message: 'vaultRead.fixedFolder 只允许用于文件夹优先搜索或 whole-vault' }
  }
  const preferUserScope = read.preferUserScope
  const fallbackToWholeVault = read.fallbackToWholeVault
  const metadataDiscovery = read.metadataDiscovery === true
  if (read.metadataDiscovery !== undefined && typeof read.metadataDiscovery !== 'boolean') {
    return { kind: 'invalid', message: 'manifest v2 的 vaultRead.metadataDiscovery 必须是布尔值' }
  }
  if (typeof preferUserScope !== 'boolean' || typeof fallbackToWholeVault !== 'boolean') {
    return { kind: 'invalid', message: 'manifest v2 的读取回退字段必须是布尔值' }
  }
  if (typedScope === 'current-note' && (preferUserScope || fallbackToWholeVault)) {
    return { kind: 'invalid', message: 'current-note 不能扩大到文件夹或整个 Vault' }
  }
  if (
    (typedScope === 'user-specified-files' || typedScope === 'user-specified-folder') &&
    fallbackToWholeVault
  ) {
    return { kind: 'invalid', message: `${typedScope} 不能回退到整个 Vault` }
  }
  const maxFiles = boundedMaxFiles(read.maxFiles, defaultMaxFiles(typedScope))
  if (maxFiles === null || (typedScope === 'current-note' && maxFiles !== 1)) {
    return { kind: 'invalid', message: 'manifest v2 的 vaultRead.maxFiles 无效' }
  }
  const mode = write.mode
  if (typeof mode !== 'string' || !WRITE_MODES.has(mode as LocalSkillVaultWritePolicy['mode'])) {
    return { kind: 'invalid', message: 'manifest v2 的 vaultWrite.mode 无效' }
  }
  if (write.confirmation !== 'single-atomic-plan' || write.overwrite !== false) {
    return { kind: 'invalid', message: 'manifest v2 必须使用一次原子确认且禁止静默覆盖' }
  }
  const normalizedMode = mode as LocalSkillVaultWritePolicy['mode']
  const expectedMode = expectedOutput === 'chat' ? 'chat' : expectedOutput
  if (normalizedMode !== expectedMode && !(normalizedMode === 'none' && expectedMode === 'chat')) {
    return { kind: 'invalid', message: 'manifest v2 的写入方式与 SKILL.md 输出方式不一致' }
  }
  const network = value.network
  if (network !== 'none' && network !== 'ai-linzi-only') {
    return { kind: 'invalid', message: 'manifest v2 的 network 无效' }
  }
  if (permissions(value).length === 0 || !Array.isArray(value.programs)) {
    return { kind: 'invalid', message: 'manifest v2 缺少可展示权限或 programs 清单' }
  }
  const context = value.context === undefined ? null : record(value.context)
  if (value.context !== undefined && !context) {
    return { kind: 'invalid', message: 'manifest v2 的 context 必须是对象' }
  }
  const contextMode = context?.mode
  if (
    contextMode !== undefined &&
    (typeof contextMode !== 'string' || !CONTEXT_MODES.has(contextMode as PluginContextMode))
  ) {
    return { kind: 'invalid', message: 'manifest v2 的 context.mode 无效' }
  }
  return {
    kind: 'valid',
    policy: {
      schemaVersion: 2,
      source: 'structured-v2',
      vaultRead: {
        scope: typedScope,
        ...(fixedFolder ? { fixedFolder } : {}),
        metadataDiscovery,
        preferUserScope,
        fallbackToWholeVault,
        maxFiles,
      },
      vaultWrite: {
        mode: normalizedMode,
        confirmation: 'single-atomic-plan',
        overwrite: false,
      },
      network,
      ...(contextMode ? { contextMode: contextMode as PluginContextMode } : {}),
    },
  }
}

/**
 * AI霖子的 Vault 读取能力属于插件，而不是某一个模型或 Skill。
 *
 * 旧版/外部 Skill 的 current-note、指定文件或指定文件夹声明仍用于确定本轮的
 * 首要输入与优先搜索范围，但不再阻止模型按需搜索当前整个 Vault。正文仍由
 * 本机索引先筛选，只发送完成任务所需的候选文件；Vault 外文件永远不可见。
 */
export function withWholeVaultReadAccess(
  policy: LocalSkillRuntimePolicy | undefined,
): LocalSkillRuntimePolicy | undefined {
  if (!policy) return undefined
  const { fixedFolder: _legacyFixedFolder, ...readPolicy } = policy.vaultRead
  return {
    ...policy,
    vaultRead: {
      ...readPolicy,
      scope: 'whole-vault',
      metadataDiscovery: true,
      preferUserScope: true,
      fallbackToWholeVault: true,
      maxFiles: Math.max(120, policy.vaultRead.maxFiles),
    },
  }
}

function inferLegacyPolicy(value: Record<string, unknown>, expectedOutput: LocalSkillOutput): LocalSkillManifestResult {
  const items = permissions(value)
  if (items.length === 0) return { kind: 'invalid', message: 'manifest v1 权限清单为空' }
  const joined = items.join('\n').normalize('NFKC')
  let scope: LocalSkillVaultReadScope = 'user-specified-files'
  if (/(?:整个|全部|所有|全库|整库)\s*(?:Vault|知识库)|(?:最近|过去)\s*\d+\s*天.{0,24}(?:Vault|文档|文件|正文)/iu.test(joined)) {
    scope = 'whole-vault'
  }
  else if (/(?:文件夹|目录)/u.test(joined)) scope = 'user-specified-folder'
  else if (/(?:当前(?:打开)?|一份|一个|一篇|单篇|单个)/u.test(joined)) scope = 'current-note'
  const fallbackToWholeVault = scope === 'whole-vault' ||
    /(?:没找到|未找到|找不到|无结果).{0,20}(?:整个|全部|全库|整库)\s*(?:Vault|知识库)/iu.test(joined)
  return {
    kind: 'valid',
    policy: {
      schemaVersion: 1,
      source: 'legacy-v1',
      vaultRead: {
        scope,
        metadataDiscovery: false,
        preferUserScope: scope === 'whole-vault' || scope === 'user-specified-folder',
        fallbackToWholeVault,
        maxFiles: defaultMaxFiles(scope),
      },
      vaultWrite: {
        mode: expectedOutput,
        confirmation: 'single-atomic-plan',
        overwrite: false,
      },
      network: 'ai-linzi-only',
    },
  }
}

export function parseLocalSkillManifest(
  content: string | undefined,
  expectedOutput: LocalSkillOutput,
): LocalSkillManifestResult {
  if (content === undefined) return { kind: 'missing' }
  let value: Record<string, unknown> | null
  try {
    value = record(JSON.parse(content))
  } catch {
    return { kind: 'invalid', message: 'manifest 不是合法 JSON' }
  }
  if (!value) return { kind: 'invalid', message: 'manifest 顶层必须是对象' }
  if (value.schemaVersion === 2) return parseV2(value, expectedOutput)
  if (value.schemaVersion === 1) return inferLegacyPolicy(value, expectedOutput)
  return { kind: 'invalid', message: 'manifest schemaVersion 只支持 1 或 2' }
}

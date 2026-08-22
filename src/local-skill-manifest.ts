import type { LocalSkillOutput } from './local-skill-core'

export type LocalSkillVaultReadScope =
  | 'current-note'
  | 'user-specified-files'
  | 'user-specified-folder'
  | 'whole-vault'

export interface LocalSkillVaultReadPolicy {
  scope: LocalSkillVaultReadScope
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
  return {
    kind: 'valid',
    policy: {
      schemaVersion: 2,
      source: 'structured-v2',
      vaultRead: {
        scope: typedScope,
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

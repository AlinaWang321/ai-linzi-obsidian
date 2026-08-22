import {
  CREATE_LOCAL_SKILL_MAX_FILES,
  CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS,
  isPortableSkillName,
  parsePortableSkillContent,
} from './create-local-skill'

export interface SkillUpdateWriteFile {
  path: string
  content: string
}

export interface SkillUpdateProposal {
  name: string
  expectedBaseVersion: string
  reason: string
  writeFiles: SkillUpdateWriteFile[]
  deleteFiles: string[]
}

export interface SkillUpdateExtraction {
  cleanText: string
  proposals: SkillUpdateProposal[]
  invalidBlocks: number
}

export interface SkillFileFingerprint {
  path: string
  mtime: number
  size: number
  sha256: string
}

export interface SkillTreeFingerprint {
  files: SkillFileFingerprint[]
  sha256: string
}

export interface PreparedSkillUpdateChange {
  path: string
  kind: 'create' | 'update' | 'delete'
  oldContent?: string
  newContent?: string
  oldSize?: number
  oldSha256?: string
}

/** 只保存可序列化的预检证据；原始二进制只在本轮事务内存中用于失败回滚。 */
export interface PreparedSkillUpdate {
  skillRoot: string
  entryPath: string
  currentVersion: string
  nextVersion: string
  reason: string
  preparedAt: number
  proposalSha256: string
  baseline: SkillTreeFingerprint
  changes: PreparedSkillUpdateChange[]
}

export interface SkillUpdateSource {
  name: string
  currentVersion: string
  files: SkillUpdateWriteFile[]
  preservedBinaryFiles: { path: string; size: number; sha256: string }[]
}

export const SKILL_VERSION_MANIFEST_PATH = 'references/ai-linzi-skill-manifest.json'
/** 兼容旧版已生成的历史目录：新版不再创建，也不把它当作正式 Skill 文件改写或删除。 */
export const SKILL_VERSION_HISTORY_FOLDER = 'ai-linzi-versions'
export const SKILL_UPDATE_MAX_DELETE_FILES = 12
export const SKILL_UPDATE_MAX_AFFECTED_FILES = 20

// 每段最多 9 位，保证 Number 比较保持有界；第三方 Skill
// 不能用超长数字制造 Infinity/NaN 后绕过升降级判断。
const SEMVER_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u
const UPDATE_BLOCK_RE =
  /<<<更新Skill\s+name=([^>\s]{1,100})\s+base=([^>\s]{1,40})>>>\r?\n?([\s\S]*?)\r?\n?<<<更新Skill结束>>>/giu
const UPDATE_REASON_RE =
  /<<<Skill更新原因>>>\r?\n?([\s\S]*?)\r?\n?<<<Skill更新原因结束>>>/giu
const UPDATE_WRITE_RE =
  /<<<Skill写入\s+path=([^>\n]{1,200})>>>\r?\n?([\s\S]*?)\r?\n?<<<Skill写入结束>>>/giu
const UPDATE_DELETE_RE = /<<<Skill删除\s+path=([^>\n]{1,200})>>>/giu
const TEXT_FILE_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'html', 'htm', 'css', 'svg',
])
const DELETE_ROOTS = new Set(['references', 'assets', 'scripts'])

export function isSkillSemver(value: string): boolean {
  return SEMVER_RE.test(value.trim())
}

export function compareSkillSemver(left: string, right: string): number {
  if (!isSkillSemver(left) || !isSkillSemver(right)) return Number.NaN
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const diff = a[index] - b[index]
    if (diff !== 0) return diff
  }
  return 0
}

function safeRelativePath(value: string, maxParts: number): string[] | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  // eslint-disable-next-line no-control-regex -- 用户文件路径必须显式拒绝控制字符。
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f:*?"<>|]/u.test(normalized)) return null
  const parts = normalized.split('/')
  if (
    parts.length > maxParts ||
    parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  ) {
    return null
  }
  return parts
}

/**
 * AI 更新本车次不允许新建/改写 scripts：普通用户创建 Skill 不应顺手获得代码生成面。
 * 已有脚本仍会原样保留；若用户明确淘汰旧脚本，可以在 deleteFiles 中单列。
 */
export function normalizeSkillUpdateWritePath(value: string): string | null {
  const parts = safeRelativePath(value, 6)
  if (!parts) return null
  if (parts.length === 1 && parts[0].toLocaleLowerCase() === 'skill.md') return 'SKILL.md'
  const root = parts[0].toLocaleLowerCase()
  if (!['references', 'assets'].includes(root) || parts.length < 2) return null
  const extension = parts.at(-1)?.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  return TEXT_FILE_EXTENSIONS.has(extension) ? parts.join('/') : null
}

export function normalizeSkillUpdateDeletePath(value: string): string | null {
  const parts = safeRelativePath(value, 6)
  if (!parts || parts.length < 2 || !DELETE_ROOTS.has(parts[0].toLocaleLowerCase())) return null
  const normalized = parts.join('/')
  const lower = normalized.toLocaleLowerCase()
  if (lower === SKILL_VERSION_MANIFEST_PATH || lower.startsWith(`${SKILL_VERSION_HISTORY_FOLDER}/`)) {
    return null
  }
  return normalized
}

export function skillVersionFromManifestContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) &&
      typeof parsed.skillVersion === 'string' && isSkillSemver(parsed.skillVersion)
      ? parsed.skillVersion
      : null
  } catch {
    return null
  }
}

export function proposalNextVersion(proposal: SkillUpdateProposal): string | null {
  const manifest = proposal.writeFiles.find(
    (file) => file.path.toLocaleLowerCase() === SKILL_VERSION_MANIFEST_PATH,
  )
  return manifest ? skillVersionFromManifestContent(manifest.content) : null
}

function parseSkillUpdateBlock(
  rawName: string,
  rawBaseVersion: string,
  rawBody: string,
): SkillUpdateProposal | null {
  const name = rawName.trim()
  const expectedBaseVersion = rawBaseVersion.trim()
  if (!isPortableSkillName(name) || !isSkillSemver(expectedBaseVersion)) return null

  const reasons: string[] = []
  let invalid = false
  let remainder = rawBody.replace(UPDATE_REASON_RE, (_match, rawReason: string) => {
    const reason = rawReason.trim()
    if (!reason || reason.length > 500 || reasons.length > 0) invalid = true
    else reasons.push(reason)
    return ''
  })

  const writeFiles: SkillUpdateWriteFile[] = []
  remainder = remainder.replace(UPDATE_WRITE_RE, (_match, rawPath: string, rawContent: string) => {
    const path = normalizeSkillUpdateWritePath(rawPath)
    const content = rawContent.replace(/^\uFEFF/u, '').trim()
    if (
      !path ||
      !content ||
      writeFiles.some((file) => file.path.toLocaleLowerCase() === path.toLocaleLowerCase())
    ) {
      invalid = true
    } else {
      writeFiles.push({ path, content })
    }
    return ''
  })

  const deleteFiles: string[] = []
  remainder = remainder.replace(UPDATE_DELETE_RE, (_match, rawPath: string) => {
    const path = normalizeSkillUpdateDeletePath(rawPath)
    if (!path || deleteFiles.some((item) => item.toLocaleLowerCase() === path.toLocaleLowerCase())) {
      invalid = true
    } else {
      deleteFiles.push(path)
    }
    return ''
  })

  if (
    invalid ||
    remainder.trim() ||
    reasons.length !== 1 ||
    writeFiles.length === 0 ||
    writeFiles.length > CREATE_LOCAL_SKILL_MAX_FILES ||
    deleteFiles.length > SKILL_UPDATE_MAX_DELETE_FILES ||
    writeFiles.length + deleteFiles.length > SKILL_UPDATE_MAX_AFFECTED_FILES ||
    writeFiles.reduce((sum, file) => sum + file.content.length, 0) > CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS
  ) {
    return null
  }

  const overlap = writeFiles.some((write) =>
    deleteFiles.some((path) => path.toLocaleLowerCase() === write.path.toLocaleLowerCase()),
  )
  if (overlap) return null

  const entry = writeFiles.find((file) => file.path === 'SKILL.md')
  if (entry && !parsePortableSkillContent(name, entry.content)) return null

  const proposal = {
    name,
    expectedBaseVersion,
    reason: reasons[0],
    writeFiles,
    deleteFiles,
  }
  const nextVersion = proposalNextVersion(proposal)
  if (!nextVersion || compareSkillSemver(nextVersion, expectedBaseVersion) <= 0) return null
  return proposal
}

export function extractSkillUpdateProposals(text: string): SkillUpdateExtraction {
  const proposals: SkillUpdateProposal[] = []
  let invalidBlocks = 0
  const cleanText = text
    .replace(UPDATE_BLOCK_RE, (_match, rawName: string, rawBase: string, rawBody: string) => {
      const proposal = parseSkillUpdateBlock(rawName, rawBase, rawBody)
      if (proposal && proposals.length === 0) proposals.push(proposal)
      else invalidBlocks += 1
      return ''
    })
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  if (text.includes('<<<更新Skill') && proposals.length === 0 && invalidBlocks === 0) invalidBlocks = 1
  return { cleanText, proposals, invalidBlocks }
}

export function formatSkillUpdateProposal(proposal: SkillUpdateProposal): string {
  const writes = proposal.writeFiles
    .map((file) => `<<<Skill写入 path=${file.path}>>>\n${file.content}\n<<<Skill写入结束>>>`)
    .join('\n')
  const deletes = proposal.deleteFiles.map((path) => `<<<Skill删除 path=${path}>>>`).join('\n')
  return [
    `<<<更新Skill name=${proposal.name} base=${proposal.expectedBaseVersion}>>>`,
    '<<<Skill更新原因>>>',
    proposal.reason,
    '<<<Skill更新原因结束>>>',
    writes,
    deletes,
    '<<<更新Skill结束>>>',
  ].filter(Boolean).join('\n')
}

export function skillTreeFingerprintsEqual(
  left: SkillTreeFingerprint,
  right: SkillTreeFingerprint,
): boolean {
  if (left.sha256 !== right.sha256 || left.files.length !== right.files.length) return false
  return left.files.every((file, index) => {
    const other = right.files[index]
    return Boolean(
      other &&
      file.path === other.path &&
      file.mtime === other.mtime &&
      file.size === other.size &&
      file.sha256 === other.sha256,
    )
  })
}

export function skillUpdateProposalCanonicalText(proposal: SkillUpdateProposal): string {
  return JSON.stringify({
    name: proposal.name,
    expectedBaseVersion: proposal.expectedBaseVersion,
    reason: proposal.reason,
    writeFiles: [...proposal.writeFiles].sort((a, b) => a.path.localeCompare(b.path)),
    deleteFiles: [...proposal.deleteFiles].sort((a, b) => a.localeCompare(b)),
  })
}

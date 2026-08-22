import {
  SKILL_VERSION_MANIFEST_PATH,
  compareSkillSemver,
  normalizeSkillUpdateWritePath,
  proposalNextVersion,
  skillTreeFingerprintsEqual,
  skillUpdateProposalCanonicalText,
  skillVersionFromManifestContent,
  type PreparedSkillUpdate,
  type PreparedSkillUpdateChange,
  type SkillFileFingerprint,
  type SkillTreeFingerprint,
  type SkillUpdateProposal,
  type SkillUpdateSource,
} from './skill-update-core'
import {
  CREATE_LOCAL_SKILL_MAX_FILES,
  CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS,
  parsePortableSkillContent,
} from './create-local-skill'

export interface SkillCapturedFile extends SkillFileFingerprint {
  bytes: ArrayBuffer
}

export interface SkillCapturedTree {
  files: SkillCapturedFile[]
  fingerprint: SkillTreeFingerprint
}

export interface SkillUpdateTransactionHost {
  captureFormalFiles(skillRoot: string): Promise<Array<Omit<SkillCapturedFile, 'sha256'>>>
  writeFormalText(skillRoot: string, relativePath: string, content: string): Promise<void>
  writeFormalBinary(skillRoot: string, relativePath: string, bytes: ArrayBuffer): Promise<void>
  deleteFormalFile(skillRoot: string, relativePath: string): Promise<void>
}

export interface AppliedSkillUpdate {
  previousVersion: string
  nextVersion: string
}

/** 12 个可更新文本 + 最多 100 个只读保留文件；变更前先限资源，避免导入 Skill 卡死 Obsidian。 */
export const SKILL_UPDATE_MAX_PRESERVED_FILES = 100
export const SKILL_UPDATE_MAX_TREE_FILES = CREATE_LOCAL_SKILL_MAX_FILES + SKILL_UPDATE_MAX_PRESERVED_FILES
export const SKILL_UPDATE_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024
export const SKILL_UPDATE_MAX_TREE_BYTES = 100 * 1024 * 1024

export function skillTreeResourceLimitError(
  files: Array<{ path: string; size: number }>,
): string | null {
  if (files.length > SKILL_UPDATE_MAX_TREE_FILES) {
    return `这个 Skill 有 ${files.length} 个文件，超过安全上限 ${SKILL_UPDATE_MAX_TREE_FILES} 个。`
  }
  let total = 0
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      return `${file.path} 的文件大小无效。`
    }
    if (file.size > SKILL_UPDATE_MAX_SINGLE_FILE_BYTES) {
      return `${file.path} 超过单文件 50 MB 的更新安全上限。`
    }
    total += file.size
    if (total > SKILL_UPDATE_MAX_TREE_BYTES) {
      return '这个 Skill 超过 100 MB 的整包更新安全上限。'
    }
  }
  return null
}

const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder('utf-8', { fatal: true })

function cloneBytes(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0)
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  const input =
    typeof bytes === 'string'
      ? encoder.encode(bytes).buffer
      : bytes instanceof ArrayBuffer
        ? bytes
        : new Uint8Array(bytes).slice().buffer
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function fingerprintFiles(files: SkillCapturedFile[]): Promise<SkillTreeFingerprint> {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path))
  const canonical = sorted
    .map((file) => `${file.path}\t${file.size}\t${file.sha256}`)
    .join('\n')
  return {
    files: sorted.map(({ path, mtime, size, sha256 }) => ({ path, mtime, size, sha256 })),
    sha256: await sha256Hex(canonical),
  }
}

export async function captureSkillTree(
  host: SkillUpdateTransactionHost,
  skillRoot: string,
): Promise<SkillCapturedTree> {
  const rawFiles = await host.captureFormalFiles(skillRoot)
  const resourceError = skillTreeResourceLimitError(rawFiles)
  if (resourceError) throw new Error(resourceError)
  const seen = new Set<string>()
  const files: SkillCapturedFile[] = []
  for (const file of rawFiles) {
    const key = file.path.toLocaleLowerCase()
    if (seen.has(key)) throw new Error(`Skill 中存在大小写冲突的重复路径：${file.path}`)
    seen.add(key)
    const bytes = cloneBytes(file.bytes)
    if (bytes.byteLength !== file.size) throw new Error(`读取 ${file.path} 时大小发生变化，请重试。`)
    files.push({ ...file, bytes, sha256: await sha256Hex(bytes) })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { files, fingerprint: await fingerprintFiles(files) }
}

/** 发送给专用更新模型的只是可更新文本；脚本和二进制仅发送路径/大小/哈希。 */
export async function buildSkillUpdateSource(
  host: SkillUpdateTransactionHost,
  skillRoot: string,
  skillName: string,
): Promise<SkillUpdateSource> {
  const tree = await captureSkillTree(host, skillRoot)
  const byPath = fileMap(tree.files)
  const entry = byPath.get('skill.md')
  const manifest = byPath.get(SKILL_VERSION_MANIFEST_PATH)
  if (!entry || !manifest) throw new Error('这个 Skill 缺少入口或 AI霖子版本清单，不能自动更新。')
  if (!parsePortableSkillContent(skillName, decodeTextFile(entry, 'SKILL.md'))) {
    throw new Error('这个 Skill 的入口名称或格式不符合安全更新要求。')
  }
  const currentVersion = skillVersionFromManifestContent(decodeTextFile(manifest, '版本清单'))
  if (!currentVersion) throw new Error('这个 Skill 的版本清单无效。')

  const files: SkillUpdateSource['files'] = []
  const preservedBinaryFiles: SkillUpdateSource['preservedBinaryFiles'] = []
  for (const file of tree.files) {
    if (normalizeSkillUpdateWritePath(file.path)) {
      try {
        files.push({ path: file.path, content: fatalDecoder.decode(file.bytes) })
        continue
      } catch {
        // assets 下允许存在二进制；只传不可改写的指纹，不把乱码送给模型。
      }
    }
    preservedBinaryFiles.push({ path: file.path, size: file.size, sha256: file.sha256 })
  }
  if (
    files.length > CREATE_LOCAL_SKILL_MAX_FILES ||
    files.reduce((sum, file) => sum + file.content.length, 0) > CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS
  ) {
    throw new Error('这个 Skill 的可更新文本超过安全上限，请先手工拆分后再更新。')
  }
  if (preservedBinaryFiles.length > SKILL_UPDATE_MAX_PRESERVED_FILES) {
    throw new Error(`这个 Skill 的只读保留文件超过 ${SKILL_UPDATE_MAX_PRESERVED_FILES} 个，不能自动更新。`)
  }
  return { name: skillName, currentVersion, files, preservedBinaryFiles }
}

function decodeTextFile(file: SkillCapturedFile, label: string): string {
  try {
    return fatalDecoder.decode(file.bytes)
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 文本，AI霖子不会把它当作文本覆盖。`)
  }
}

function fileMap(files: SkillCapturedFile[]): Map<string, SkillCapturedFile> {
  return new Map(files.map((file) => [file.path.toLocaleLowerCase(), file]))
}

async function expectedTreeAfterProposal(
  baseline: SkillCapturedTree,
  proposal: SkillUpdateProposal,
): Promise<SkillCapturedTree> {
  const byPath = fileMap(baseline.files)
  for (const path of proposal.deleteFiles) byPath.delete(path.toLocaleLowerCase())
  for (const write of proposal.writeFiles) {
    const bytes = encoder.encode(write.content).buffer
    const previous = byPath.get(write.path.toLocaleLowerCase())
    byPath.set(write.path.toLocaleLowerCase(), {
      path: write.path,
      mtime: previous?.mtime ?? 0,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      bytes,
    })
  }
  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  return { files, fingerprint: await fingerprintFiles(files) }
}

function validateFinalSkill(name: string, files: SkillCapturedFile[], nextVersion: string): void {
  const byPath = fileMap(files)
  const entry = byPath.get('skill.md')
  const manifest = byPath.get(SKILL_VERSION_MANIFEST_PATH)
  if (!entry || !manifest) throw new Error('更新后必须保留 SKILL.md 和 AI霖子版本清单。')
  const entryText = decodeTextFile(entry, 'SKILL.md')
  if (!parsePortableSkillContent(name, entryText)) {
    throw new Error('更新后的 SKILL.md 不符合可移植格式，或名称与当前 Skill 不一致。')
  }
  const manifestVersion = skillVersionFromManifestContent(decodeTextFile(manifest, '版本清单'))
  if (manifestVersion !== nextVersion) throw new Error('更新后的版本清单与提案版本不一致。')
}

export class SkillUpdateTransaction {
  constructor(
    private readonly host: SkillUpdateTransactionHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(
    skillRoot: string,
    entryPath: string,
    proposal: SkillUpdateProposal,
  ): Promise<PreparedSkillUpdate> {
    if (!skillRoot || !entryPath.endsWith('/SKILL.md')) throw new Error('只能更新文件夹形式的本地 Skill。')
    if (entryPath !== `${skillRoot}/SKILL.md`) throw new Error('Skill 入口路径与根目录不一致。')

    const baseline = await captureSkillTree(this.host, skillRoot)
    const byPath = fileMap(baseline.files)
    const currentEntry = byPath.get('skill.md')
    const currentManifest = byPath.get(SKILL_VERSION_MANIFEST_PATH)
    if (!currentEntry || !currentManifest) {
      throw new Error('这个 Skill 还没有 AI霖子版本清单，暂时不能自动更新。')
    }
    if (!parsePortableSkillContent(proposal.name, decodeTextFile(currentEntry, '当前 SKILL.md'))) {
      throw new Error('当前 Skill 的名称或格式不符合安全更新要求。')
    }
    const currentVersion = skillVersionFromManifestContent(
      decodeTextFile(currentManifest, '当前版本清单'),
    )
    if (!currentVersion) throw new Error('当前 Skill 的版本清单无效。')
    if (proposal.expectedBaseVersion !== currentVersion) {
      throw new Error(`版本已经变化：提案基于 ${proposal.expectedBaseVersion}，当前是 ${currentVersion}。`)
    }
    const nextVersion = proposalNextVersion(proposal)
    if (!nextVersion || compareSkillSemver(nextVersion, currentVersion) <= 0) {
      throw new Error('新版本号必须高于当前版本。')
    }

    const changes: PreparedSkillUpdateChange[] = []
    for (const write of proposal.writeFiles) {
      const previous = byPath.get(write.path.toLocaleLowerCase())
      if (previous && previous.path !== write.path) {
        throw new Error(`更新路径的大小写与现有文件不一致：${write.path}；当前路径是 ${previous.path}。`)
      }
      const newBytes = encoder.encode(write.content)
      if (previous) {
        const oldContent = decodeTextFile(previous, write.path)
        if (oldContent === write.content) continue
        changes.push({
          path: write.path,
          kind: 'update',
          oldContent,
          newContent: write.content,
          oldSize: previous.size,
          oldSha256: previous.sha256,
        })
      } else {
        changes.push({ path: write.path, kind: 'create', newContent: write.content })
      }
      if (newBytes.byteLength === 0) throw new Error(`${write.path} 不能为空。`)
    }
    for (const path of proposal.deleteFiles) {
      const previous = byPath.get(path.toLocaleLowerCase())
      if (!previous) throw new Error(`提案要删除的文件不存在：${path}`)
      if (previous.path !== path) {
        throw new Error(`删除路径的大小写与现有文件不一致：${path}；当前路径是 ${previous.path}。`)
      }
      let oldContent: string | undefined
      try {
        oldContent = fatalDecoder.decode(previous.bytes)
      } catch {
        oldContent = undefined
      }
      changes.push({
        path,
        kind: 'delete',
        oldContent,
        oldSize: previous.size,
        oldSha256: previous.sha256,
      })
    }
    if (changes.length === 0) throw new Error('更新提案没有产生任何实际变化。')

    const expected = await expectedTreeAfterProposal(baseline, proposal)
    validateFinalSkill(proposal.name, expected.files, nextVersion)
    return {
      skillRoot,
      entryPath,
      currentVersion,
      nextVersion,
      reason: proposal.reason,
      preparedAt: this.now().getTime(),
      proposalSha256: await sha256Hex(skillUpdateProposalCanonicalText(proposal)),
      baseline: baseline.fingerprint,
      changes,
    }
  }

  async apply(prepared: PreparedSkillUpdate, proposal: SkillUpdateProposal): Promise<AppliedSkillUpdate> {
    const proposalSha256 = await sha256Hex(skillUpdateProposalCanonicalText(proposal))
    if (proposalSha256 !== prepared.proposalSha256) throw new Error('更新提案在确认后发生变化，已取消。')
    const current = await captureSkillTree(this.host, prepared.skillRoot)
    if (!skillTreeFingerprintsEqual(current.fingerprint, prepared.baseline)) {
      throw new Error('Skill 在预览后被改动了。AI霖子没有写入任何文件，请重新生成更新方案。')
    }
    const expected = await expectedTreeAfterProposal(current, proposal)
    validateFinalSkill(proposal.name, expected.files, prepared.nextVersion)
    let mutationStarted = false
    try {
      mutationStarted = true
      for (const write of proposal.writeFiles) {
        await this.host.writeFormalText(prepared.skillRoot, write.path, write.content)
      }
      for (const path of proposal.deleteFiles) {
        await this.host.deleteFormalFile(prepared.skillRoot, path)
      }
      const actual = await captureSkillTree(this.host, prepared.skillRoot)
      this.assertContentTreeEqual(actual, expected, '写入后的 Skill 与确认预览不一致')
    } catch (error) {
      if (mutationStarted) await this.rollbackAffected(prepared.skillRoot, current, expected, prepared.changes)
      throw new Error(`Skill 更新失败，已恢复原版本：${this.message(error)}`)
    }

    return {
      previousVersion: prepared.currentVersion,
      nextVersion: prepared.nextVersion,
    }
  }

  private assertContentTreeEqual(actual: SkillCapturedTree, expected: SkillCapturedTree, prefix: string): void {
    const a = fileMap(actual.files)
    const b = fileMap(expected.files)
    if (a.size !== b.size) throw new Error(`${prefix}：文件数量不同。`)
    for (const [key, expectedFile] of b) {
      const actualFile = a.get(key)
      if (!actualFile || actualFile.path !== expectedFile.path || actualFile.sha256 !== expectedFile.sha256) {
        throw new Error(`${prefix}：${expectedFile.path} 校验失败。`)
      }
    }
  }

  private async rollbackAffected(
    skillRoot: string,
    original: SkillCapturedTree,
    intended: SkillCapturedTree,
    changes: PreparedSkillUpdateChange[],
  ): Promise<void> {
    const current = await captureSkillTree(this.host, skillRoot)
    const originalMap = fileMap(original.files)
    const intendedMap = fileMap(intended.files)
    const currentMap = fileMap(current.files)
    for (const change of changes) {
      const key = change.path.toLocaleLowerCase()
      const live = currentMap.get(key)
      const before = originalMap.get(key)
      const after = intendedMap.get(key)
      const safe =
        (!live && (!before || !after)) ||
        Boolean(live && before && live.path === before.path && live.sha256 === before.sha256) ||
        Boolean(live && after && live.path === after.path && live.sha256 === after.sha256)
      if (!safe) {
        throw new Error(`回滚时发现 ${change.path} 被同时编辑，已保留现场，请使用 Obsidian 文件恢复。`)
      }
    }
    for (const change of changes) {
      const before = originalMap.get(change.path.toLocaleLowerCase())
      if (before) await this.host.writeFormalBinary(skillRoot, before.path, cloneBytes(before.bytes))
      else await this.host.deleteFormalFile(skillRoot, change.path)
    }
    const restored = await captureSkillTree(this.host, skillRoot)
    for (const change of changes) {
      const before = originalMap.get(change.path.toLocaleLowerCase())
      const live = fileMap(restored.files).get(change.path.toLocaleLowerCase())
      if ((!before && live) || (before && (!live || live.sha256 !== before.sha256))) {
        throw new Error(`自动回滚后 ${change.path} 校验失败，请使用 Obsidian 文件恢复或你的备份。`)
      }
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

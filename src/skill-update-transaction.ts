import {
  SKILL_VERSION_HISTORY_KEEP,
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
  type SkillVersionMetadata,
  type SkillVersionSummary,
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

export interface StoredSkillSnapshot {
  snapshotId: string
  metadata: SkillVersionMetadata
  files: SkillCapturedFile[]
}

export interface SkillUpdateTransactionHost {
  captureFormalFiles(skillRoot: string): Promise<Array<Omit<SkillCapturedFile, 'sha256'>>>
  writeFormalText(skillRoot: string, relativePath: string, content: string): Promise<void>
  writeFormalBinary(skillRoot: string, relativePath: string, bytes: ArrayBuffer): Promise<void>
  deleteFormalFile(skillRoot: string, relativePath: string): Promise<void>
  createSnapshot(
    skillRoot: string,
    snapshotId: string,
    metadata: SkillVersionMetadata,
    files: SkillCapturedFile[],
  ): Promise<void>
  listSnapshots(skillRoot: string): Promise<SkillVersionSummary[]>
  readSnapshot(skillRoot: string, snapshotId: string): Promise<StoredSkillSnapshot>
  removeSnapshot(skillRoot: string, snapshotId: string): Promise<void>
}

export interface AppliedSkillUpdate {
  snapshotId: string
  previousVersion: string
  nextVersion: string
  historyCleanupWarning?: string
}

export interface PreparedSkillRestore {
  skillRoot: string
  skillName: string
  snapshotId: string
  targetVersion: string
  preparedAt: number
  baseline: SkillTreeFingerprint
  targetFingerprint: SkillTreeFingerprint
}

export interface AppliedSkillRestore {
  safetySnapshotId: string
  restoredSnapshotId: string
  restoredVersion: string
  historyCleanupWarning?: string
}

/** 12 个可更新文本 + 最多 100 个只读保留文件；快照前先限资源，避免导入 Skill 卡死 Obsidian。 */
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
      return `${file.path} 超过单文件 50 MB 的快照安全上限。`
    }
    total += file.size
    if (total > SKILL_UPDATE_MAX_TREE_BYTES) {
      return '这个 Skill 超过 100 MB 的整包快照安全上限。'
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

function assertSnapshotIntegrity(snapshot: StoredSkillSnapshot): Promise<SkillTreeFingerprint> {
  return (async () => {
    const files: SkillCapturedFile[] = []
    for (const file of snapshot.files) {
      const bytes = cloneBytes(file.bytes)
      const sha256 = await sha256Hex(bytes)
      if (file.size !== bytes.byteLength || file.sha256 !== sha256) {
        throw new Error(`历史版本 ${snapshot.snapshotId} 中的 ${file.path} 校验失败。`)
      }
      files.push({ ...file, bytes })
    }
    const fingerprint = await fingerprintFiles(files)
    if (fingerprint.sha256 !== snapshot.metadata.sourceSnapshotHash) {
      throw new Error(`历史版本 ${snapshot.snapshotId} 的整包校验失败。`)
    }
    const metadataFiles = [...snapshot.metadata.files].sort((a, b) => a.path.localeCompare(b.path))
    if (
      metadataFiles.length !== fingerprint.files.length ||
      metadataFiles.some((file, index) => {
        const actual = fingerprint.files[index]
        return !actual || file.path !== actual.path || file.size !== actual.size || file.sha256 !== actual.sha256
      })
    ) {
      throw new Error(`历史版本 ${snapshot.snapshotId} 的文件清单校验失败。`)
    }
    return fingerprint
  })()
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
    const snapshotId = this.snapshotId(prepared.currentVersion)
    const metadata = this.snapshotMetadata(
      proposal.name,
      prepared.currentVersion,
      proposal.reason,
      current,
    )
    await this.host.createSnapshot(prepared.skillRoot, snapshotId, metadata, current.files)

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

    const historyCleanupWarning = await this.pruneHistory(prepared.skillRoot)
    return {
      snapshotId,
      previousVersion: prepared.currentVersion,
      nextVersion: prepared.nextVersion,
      ...(historyCleanupWarning ? { historyCleanupWarning } : {}),
    }
  }

  async listVersions(skillRoot: string): Promise<SkillVersionSummary[]> {
    return (await this.host.listSnapshots(skillRoot)).sort(
      (left, right) => right.metadata.archivedAtMs - left.metadata.archivedAtMs,
    )
  }

  async prepareRestore(skillRoot: string, skillName: string, snapshotId: string): Promise<PreparedSkillRestore> {
    const current = await captureSkillTree(this.host, skillRoot)
    const snapshot = await this.host.readSnapshot(skillRoot, snapshotId)
    const targetFingerprint = await assertSnapshotIntegrity(snapshot)
    if (snapshot.metadata.skillName !== skillName) throw new Error('历史版本不属于当前 Skill。')
    validateFinalSkill(skillName, snapshot.files, snapshot.metadata.skillVersion)
    return {
      skillRoot,
      skillName,
      snapshotId,
      targetVersion: snapshot.metadata.skillVersion,
      preparedAt: this.now().getTime(),
      baseline: current.fingerprint,
      targetFingerprint,
    }
  }

  async restore(prepared: PreparedSkillRestore): Promise<AppliedSkillRestore> {
    const current = await captureSkillTree(this.host, prepared.skillRoot)
    if (!skillTreeFingerprintsEqual(current.fingerprint, prepared.baseline)) {
      throw new Error('Skill 在恢复确认前被改动了，已取消恢复。')
    }
    const snapshot = await this.host.readSnapshot(prepared.skillRoot, prepared.snapshotId)
    const targetFingerprint = await assertSnapshotIntegrity(snapshot)
    if (targetFingerprint.sha256 !== prepared.targetFingerprint.sha256) {
      throw new Error('历史版本在确认后发生变化，已取消恢复。')
    }
    const target: SkillCapturedTree = { files: snapshot.files, fingerprint: targetFingerprint }
    validateFinalSkill(prepared.skillName, target.files, prepared.targetVersion)

    const currentVersion = this.versionFromTree(current)
    const safetySnapshotId = this.snapshotId(currentVersion)
    await this.host.createSnapshot(
      prepared.skillRoot,
      safetySnapshotId,
      this.snapshotMetadata(
        prepared.skillName,
        currentVersion,
        `恢复到历史版本 ${prepared.targetVersion} 前的安全快照`,
        current,
      ),
      current.files,
    )
    try {
      await this.replaceWholeTree(prepared.skillRoot, current, target)
      const actual = await captureSkillTree(this.host, prepared.skillRoot)
      this.assertContentTreeEqual(actual, target, '恢复后的 Skill 与历史版本不一致')
    } catch (error) {
      await this.rollbackWholeTree(prepared.skillRoot, current, target)
      throw new Error(`恢复历史版本失败，已回到恢复前状态：${this.message(error)}`)
    }
    const historyCleanupWarning = await this.pruneHistory(prepared.skillRoot)
    return {
      safetySnapshotId,
      restoredSnapshotId: prepared.snapshotId,
      restoredVersion: prepared.targetVersion,
      ...(historyCleanupWarning ? { historyCleanupWarning } : {}),
    }
  }

  private snapshotId(version: string): string {
    const stamp = this.now().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, (value) => value.slice(1, 4) + 'Z')
    return `${stamp}__${version}`
  }

  private snapshotMetadata(
    skillName: string,
    version: string,
    reason: string,
    tree: SkillCapturedTree,
  ): SkillVersionMetadata {
    const archivedAt = this.now()
    return {
      schemaVersion: 1,
      skillName,
      skillVersion: version,
      archivedAt: archivedAt.toISOString(),
      archivedAtMs: archivedAt.getTime(),
      sourceSnapshotHash: tree.fingerprint.sha256,
      reason,
      files: tree.fingerprint.files,
    }
  }

  private versionFromTree(tree: SkillCapturedTree): string {
    const manifest = fileMap(tree.files).get(SKILL_VERSION_MANIFEST_PATH)
    if (!manifest) throw new Error('当前 Skill 缺少版本清单。')
    const version = skillVersionFromManifestContent(decodeTextFile(manifest, '当前版本清单'))
    if (!version) throw new Error('当前 Skill 版本清单无效。')
    return version
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
        Boolean(live && before && live.sha256 === before.sha256) ||
        Boolean(live && after && live.sha256 === after.sha256)
      if (!safe) {
        throw new Error(`回滚时发现 ${change.path} 被同时编辑，已保留现场，请从历史版本手动恢复。`)
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
        throw new Error(`自动回滚后 ${change.path} 校验失败，请从历史版本手动恢复。`)
      }
    }
  }

  private async replaceWholeTree(
    skillRoot: string,
    current: SkillCapturedTree,
    target: SkillCapturedTree,
  ): Promise<void> {
    const targetMap = fileMap(target.files)
    for (const file of target.files) {
      await this.host.writeFormalBinary(skillRoot, file.path, cloneBytes(file.bytes))
    }
    for (const file of current.files) {
      if (!targetMap.has(file.path.toLocaleLowerCase())) await this.host.deleteFormalFile(skillRoot, file.path)
    }
  }

  private async rollbackWholeTree(
    skillRoot: string,
    original: SkillCapturedTree,
    intended: SkillCapturedTree,
  ): Promise<void> {
    const live = await captureSkillTree(this.host, skillRoot)
    const originalMap = fileMap(original.files)
    const intendedMap = fileMap(intended.files)
    for (const file of live.files) {
      const key = file.path.toLocaleLowerCase()
      const before = originalMap.get(key)
      const after = intendedMap.get(key)
      if ((!before || file.sha256 !== before.sha256) && (!after || file.sha256 !== after.sha256)) {
        throw new Error(`回滚时发现 ${file.path} 被同时编辑，已保留现场，请手动恢复。`)
      }
    }
    await this.replaceWholeTree(skillRoot, live, original)
    const restored = await captureSkillTree(this.host, skillRoot)
    this.assertContentTreeEqual(restored, original, '恢复失败后的自动回滚未通过')
  }

  private async pruneHistory(skillRoot: string): Promise<string | undefined> {
    try {
      const versions = await this.listVersions(skillRoot)
      for (const version of versions.slice(SKILL_VERSION_HISTORY_KEEP)) {
        await this.host.removeSnapshot(skillRoot, version.snapshotId)
      }
      return undefined
    } catch (error) {
      return `更新已成功，但清理旧版本失败：${this.message(error)}`
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

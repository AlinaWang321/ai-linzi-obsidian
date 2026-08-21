import { App, TFile, TFolder, normalizePath } from 'obsidian'
import { SKILL_VERSION_HISTORY_FOLDER, type SkillVersionMetadata, type SkillVersionSummary } from './skill-update-core'
import type {
  SkillCapturedFile,
  SkillUpdateTransactionHost,
  StoredSkillSnapshot,
} from './skill-update-transaction'
import { sha256Hex } from './skill-update-transaction'

const SNAPSHOT_ID_RE = /^\d{8}T\d{9}Z__\d+\.\d+\.\d+$/u

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'))
}

function cloneBytes(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0)
}

function isSafeSnapshotId(value: string): boolean {
  return SNAPSHOT_ID_RE.test(value)
}

function safeStoredRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  // eslint-disable-next-line no-control-regex -- 历史快照路径必须拒绝控制字符。
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f]/u.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function parseMetadata(raw: string): SkillVersionMetadata | null {
  try {
    const value = JSON.parse(raw) as Partial<SkillVersionMetadata>
    if (
      value.schemaVersion !== 1 ||
      typeof value.skillName !== 'string' ||
      typeof value.skillVersion !== 'string' ||
      typeof value.archivedAt !== 'string' ||
      typeof value.archivedAtMs !== 'number' ||
      typeof value.sourceSnapshotHash !== 'string' ||
      typeof value.reason !== 'string' ||
      !Array.isArray(value.files) ||
      value.files.some(
        (file) =>
          !file ||
          typeof file.path !== 'string' ||
          !safeStoredRelativePath(file.path) ||
          typeof file.mtime !== 'number' ||
          typeof file.size !== 'number' ||
          typeof file.sha256 !== 'string',
      )
    ) {
      return null
    }
    return value as SkillVersionMetadata
  } catch {
    return null
  }
}

/**
 * 正式 Skill 与可见的 ai-linzi-versions 快照区全部通过 Vault API 写入。
 * 这样 Obsidian 的文件事件/缓存保持一致，同时二进制历史仍能逐字节保存。
 */
export class ObsidianSkillUpdateHost implements SkillUpdateTransactionHost {
  constructor(private readonly app: App) {}

  async captureFormalFiles(skillRoot: string): Promise<Array<Omit<SkillCapturedFile, 'sha256'>>> {
    const root = this.app.vault.getFolderByPath(normalizePath(skillRoot))
    if (!(root instanceof TFolder)) throw new Error('Skill 文件夹不存在。')
    const files: TFile[] = []
    const visit = (folder: TFolder, relativeFolder: string) => {
      for (const child of folder.children) {
        const relativePath = relativeFolder ? `${relativeFolder}/${child.name}` : child.name
        if (child instanceof TFolder) {
          if (!relativeFolder && child.name === SKILL_VERSION_HISTORY_FOLDER) continue
          visit(child, relativePath)
        } else if (child instanceof TFile) {
          files.push(child)
        }
      }
    }
    visit(root, '')
    const result: Array<Omit<SkillCapturedFile, 'sha256'>> = []
    for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
      const relativePath = file.path.slice(root.path.length + 1)
      const bytes = await this.app.vault.readBinary(file)
      result.push({
        path: relativePath,
        mtime: file.stat.mtime,
        size: file.stat.size,
        bytes: cloneBytes(bytes),
      })
    }
    return result
  }

  async writeFormalText(skillRoot: string, relativePath: string, content: string): Promise<void> {
    const fullPath = joinPath(skillRoot, relativePath)
    await this.ensureVaultParent(fullPath)
    const existing = this.app.vault.getAbstractFileByPath(fullPath)
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content)
      return
    }
    if (existing) throw new Error(`${relativePath} 与已有文件夹冲突。`)
    await this.app.vault.create(fullPath, content)
  }

  async writeFormalBinary(skillRoot: string, relativePath: string, bytes: ArrayBuffer): Promise<void> {
    const fullPath = joinPath(skillRoot, relativePath)
    await this.ensureVaultParent(fullPath)
    const existing = this.app.vault.getAbstractFileByPath(fullPath)
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, cloneBytes(bytes))
      return
    }
    if (existing) throw new Error(`${relativePath} 与已有文件夹冲突。`)
    await this.app.vault.createBinary(fullPath, cloneBytes(bytes))
  }

  async deleteFormalFile(skillRoot: string, relativePath: string): Promise<void> {
    const fullPath = joinPath(skillRoot, relativePath)
    const existing = this.app.vault.getAbstractFileByPath(fullPath)
    if (!existing) return
    if (!(existing instanceof TFile)) throw new Error(`${relativePath} 不是可删除的文件。`)
    await this.app.fileManager.trashFile(existing)
  }

  async createSnapshot(
    skillRoot: string,
    snapshotId: string,
    metadata: SkillVersionMetadata,
    files: SkillCapturedFile[],
  ): Promise<void> {
    if (!isSafeSnapshotId(snapshotId)) throw new Error('历史版本编号无效。')
    const snapshotRoot = this.snapshotRoot(skillRoot, snapshotId)
    if (this.app.vault.getAbstractFileByPath(snapshotRoot)) throw new Error('历史版本编号冲突，请重试。')
    try {
      await this.ensureVaultFolder(snapshotRoot)
      for (const file of files) {
        const relativePath = safeStoredRelativePath(file.path)
        if (!relativePath) throw new Error(`无法保存不安全的历史路径：${file.path}`)
        const target = joinPath(snapshotRoot, 'snapshot', relativePath)
        await this.ensureVaultFolder(target.split('/').slice(0, -1).join('/'))
        await this.app.vault.createBinary(target, cloneBytes(file.bytes))
      }
      await this.app.vault.create(
        joinPath(snapshotRoot, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
      )
      const stored = await this.readSnapshot(skillRoot, snapshotId)
      for (const file of stored.files) {
        if (file.size !== file.bytes.byteLength || file.sha256 !== await sha256Hex(file.bytes)) {
          throw new Error(`历史快照写入校验失败：${file.path}`)
        }
      }
      const canonical = [...stored.files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => `${file.path}\t${file.size}\t${file.sha256}`)
        .join('\n')
      if (await sha256Hex(canonical) !== metadata.sourceSnapshotHash) {
        throw new Error('历史快照整包写入校验失败。')
      }
    } catch (error) {
      const partial = this.app.vault.getAbstractFileByPath(snapshotRoot)
      if (partial) await this.app.fileManager.trashFile(partial).catch(() => undefined)
      throw error
    }
  }

  async listSnapshots(skillRoot: string): Promise<SkillVersionSummary[]> {
    const versionsRoot = joinPath(skillRoot, SKILL_VERSION_HISTORY_FOLDER)
    const root = this.app.vault.getFolderByPath(versionsRoot)
    if (!(root instanceof TFolder)) return []
    const result: SkillVersionSummary[] = []
    for (const folder of root.children.filter((child): child is TFolder => child instanceof TFolder)) {
      const snapshotId = folder.name
      if (!isSafeSnapshotId(snapshotId)) continue
      try {
        const metadataFile = this.app.vault.getFileByPath(joinPath(folder.path, 'metadata.json'))
        if (!metadataFile) continue
        const raw = await this.app.vault.read(metadataFile)
        const metadata = parseMetadata(raw)
        if (metadata) result.push({ snapshotId, metadata })
      } catch {
        // 未完成或被手工破坏的历史不展示，也绝不自动删除。
      }
    }
    return result
  }

  async readSnapshot(skillRoot: string, snapshotId: string): Promise<StoredSkillSnapshot> {
    if (!isSafeSnapshotId(snapshotId)) throw new Error('历史版本编号无效。')
    const snapshotRoot = this.snapshotRoot(skillRoot, snapshotId)
    const metadataFile = this.app.vault.getFileByPath(joinPath(snapshotRoot, 'metadata.json'))
    if (!metadataFile) throw new Error('历史版本元数据不存在。')
    const raw = await this.app.vault.read(metadataFile)
    const metadata = parseMetadata(raw)
    if (!metadata) throw new Error('历史版本元数据无效。')
    const expectedPaths = new Set(metadata.files.map((file) => file.path))
    const storedRootPath = joinPath(snapshotRoot, 'snapshot')
    const storedRoot = this.app.vault.getFolderByPath(storedRootPath)
    if (!(storedRoot instanceof TFolder)) throw new Error('历史版本文件夹不存在。')
    const actualFiles = this.listVaultFiles(storedRoot)
    const relativeActual = actualFiles.map((file) => file.path.slice(storedRootPath.length + 1))
    if (
      actualFiles.length !== expectedPaths.size ||
      relativeActual.some((path) => !expectedPaths.has(path))
    ) {
      throw new Error('历史版本的实际文件与元数据清单不一致。')
    }
    const files: SkillCapturedFile[] = []
    for (const fingerprint of metadata.files) {
      const path = safeStoredRelativePath(fingerprint.path)
      if (!path) throw new Error('历史版本包含不安全路径。')
      const file = this.app.vault.getFileByPath(joinPath(storedRootPath, path))
      if (!file) throw new Error(`历史版本缺少文件：${path}`)
      const bytes = await this.app.vault.readBinary(file)
      files.push({ ...fingerprint, bytes: cloneBytes(bytes) })
    }
    return { snapshotId, metadata, files }
  }

  async removeSnapshot(skillRoot: string, snapshotId: string): Promise<void> {
    if (!isSafeSnapshotId(snapshotId)) throw new Error('历史版本编号无效。')
    const root = this.snapshotRoot(skillRoot, snapshotId)
    const folder = this.app.vault.getAbstractFileByPath(root)
    if (folder) await this.app.fileManager.trashFile(folder)
  }

  private snapshotRoot(skillRoot: string, snapshotId: string): string {
    return joinPath(skillRoot, SKILL_VERSION_HISTORY_FOLDER, snapshotId)
  }

  private async ensureVaultParent(fullPath: string): Promise<void> {
    const parts = fullPath.split('/').slice(0, -1)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const existing = this.app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFolder) continue
      if (existing) throw new Error(`${current} 不是文件夹。`)
      await this.app.vault.createFolder(current)
    }
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const parts = normalizePath(folderPath).split('/')
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const existing = this.app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFolder) continue
      if (existing) throw new Error(`${current} 不是文件夹。`)
      await this.app.vault.createFolder(current)
    }
  }

  private listVaultFiles(folder: TFolder): TFile[] {
    const files: TFile[] = []
    for (const child of folder.children) {
      if (child instanceof TFile) files.push(child)
      else if (child instanceof TFolder) files.push(...this.listVaultFiles(child))
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }
}

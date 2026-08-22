import { App, TFile, TFolder, normalizePath } from 'obsidian'
import { SKILL_VERSION_HISTORY_FOLDER } from './skill-update-core'
import type {
  SkillCapturedFile,
  SkillUpdateTransactionHost,
} from './skill-update-transaction'
import { skillTreeResourceLimitError } from './skill-update-transaction'

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'))
}

function cloneBytes(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0)
}

/**
 * 正式 Skill 文件全部通过 Vault API 写入，保持 Obsidian 文件事件与缓存一致。
 * 旧版 ai-linzi-versions 目录只排除于正式文件树，新版不创建、不读取、不删除它。
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
    const resourceError = skillTreeResourceLimitError(
      files.map((file) => ({ path: file.path.slice(root.path.length + 1), size: file.stat.size })),
    )
    if (resourceError) throw new Error(resourceError)
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

}

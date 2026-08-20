import { App, TFile, TFolder, normalizePath } from 'obsidian'
import type { CreateLocalSkillBlock } from './create-local-skill'

export interface CreatedLocalSkillBundle {
  root: string
  files: TFile[]
}

export async function createLocalSkillBundleAtomically(
  app: App,
  configuredRoot: string,
  block: CreateLocalSkillBlock,
): Promise<CreatedLocalSkillBundle> {
  const root = normalizePath(`${configuredRoot}/${block.name}`)
  if (app.vault.getAbstractFileByPath(root)) {
    throw new Error(`已存在 ${root}/，为避免覆盖请换一个 Skill 名称`)
  }
  const targets = block.files.map((file) => ({
    ...file,
    vaultPath: normalizePath(`${root}/${file.path}`),
  }))
  const conflict = targets.find((file) => app.vault.getAbstractFileByPath(file.vaultPath))
  if (conflict) throw new Error(`已存在 ${conflict.vaultPath}，为避免覆盖请换一个 Skill 名称`)

  const createdFolders: TFolder[] = []
  const createdFiles: TFile[] = []
  const ensureFolder = async (path: string) => {
    let current = ''
    for (const segment of path.split('/')) {
      current = current ? `${current}/${segment}` : segment
      const existing = app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFolder) continue
      if (existing) throw new Error(`父路径不是文件夹：${current}`)
      createdFolders.push(await app.vault.createFolder(current))
    }
  }

  try {
    for (const target of targets) {
      const parent = target.vaultPath.split('/').slice(0, -1).join('/')
      if (parent) await ensureFolder(parent)
    }
    for (const target of targets) {
      createdFiles.push(await app.vault.create(target.vaultPath, target.content))
    }
    return { root, files: createdFiles }
  } catch (error) {
    const rollbackProblems: string[] = []
    for (const file of [...createdFiles].reverse()) {
      try {
        const current = app.vault.getAbstractFileByPath(file.path)
        if (current instanceof TFile) await app.fileManager.trashFile(current)
      } catch {
        rollbackProblems.push(file.path)
      }
    }
    for (const folder of [...createdFolders].reverse()) {
      try {
        const current = app.vault.getAbstractFileByPath(folder.path)
        if (current instanceof TFolder && current.children.length === 0) {
          await app.fileManager.trashFile(current)
        }
      } catch {
        rollbackProblems.push(folder.path)
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      rollbackProblems.length > 0
        ? `${message}；回滚时仍有 ${rollbackProblems.length} 项未能清理，请检查：${rollbackProblems.slice(0, 3).join('、')}`
        : `${message}；本轮已自动回滚，没有留下半成品 Skill`,
    )
  }
}

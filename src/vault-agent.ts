import { App, TFile, TFolder, normalizePath } from 'obsidian'
import { isLocalSearchExtension } from './local-document-text'
import { LocalVaultSearch } from './vault-search'
import {
  isProtectedVaultPath,
  normalizeVaultRelativePath,
  type VaultAgentToolCall,
  type VaultAgentToolName,
  type VaultAgentToolResult,
  type VaultOrganizePlan,
  type VaultWriteSnapshot,
} from './vault-agent-core'
import type { ActiveLocalSkillContext } from './local-skills'
import { extendContiguousRead, localSkillLinkedPathCandidates } from './local-skill-core'
import { applyNotePatch } from './note-patch'

const TOOL_OUTPUT_MAX_CHARS = 20_000
const READ_NOTE_MAX_CHARS = 16_000
const LIST_FOLDER_MAX_ENTRIES = 160
const LIST_FOLDER_SCAN_MAX_ENTRIES = 20_000
const LIST_FOLDER_MAX_DEPTH = 12
const SKILL_TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'ps1', 'sh',
])

export interface VaultAgentExecution {
  results: VaultAgentToolResult[]
  sources: { sourceId: string; filename: string; path: string }[]
}

export interface VaultActionRecord {
  id: string
  createdAt: number
  planTitle: string
  moves: { from: string; to: string }[]
  createdFolders: string[]
  /** 兼容旧 data.json；v0.7.22 起只会记录一次确认的一篇 Markdown 笔记。 */
  trashedNotes?: string[]
  /** 只保存路径元数据；正文由 Obsidian 文件恢复负责，不进入 data.json。 */
  createdNotes?: string[]
  updatedNotes?: string[]
  undoneAt?: number
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function toolText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function outputJson(value: unknown): string {
  const raw = JSON.stringify(value)
  return raw.length <= TOOL_OUTPUT_MAX_CHARS
    ? raw
    : JSON.stringify({ truncated: true, preview: raw.slice(0, 18_000) })
}

function fileExtension(path: string): string {
  const basename = path.split('/').at(-1) ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot + 1).toLocaleLowerCase() : ''
}

export class LocalVaultAgent {
  constructor(
    private readonly app: App,
    private readonly search: LocalVaultSearch,
    private readonly localSkillsRoot: () => string,
  ) {}

  private protected(path: string): boolean {
    return isProtectedVaultPath(path, this.localSkillsRoot())
  }

  async executeReadCalls(calls: VaultAgentToolCall[]): Promise<VaultAgentExecution> {
    return this.executeCalls(calls)
  }

  captureWriteSnapshots(plan: VaultOrganizePlan): VaultWriteSnapshot[] {
    return plan.operations
      .filter((operation) =>
        operation.type === 'append_note' ||
        operation.type === 'replace_note' ||
        operation.type === 'update_note',
      )
      .map((operation) => {
        const file = this.app.vault.getAbstractFileByPath(operation.path)
        if (!(file instanceof TFile)) return null
        return { path: file.path, mtime: file.stat.mtime, size: file.stat.size }
      })
      .filter((snapshot): snapshot is VaultWriteSnapshot => Boolean(snapshot))
  }

  async executeCalls(
    calls: VaultAgentToolCall[],
    skillContext?: ActiveLocalSkillContext,
  ): Promise<VaultAgentExecution> {
    const results: VaultAgentToolResult[] = []
    const sources: VaultAgentExecution['sources'] = []
    for (const call of calls) {
      try {
        const value = await this.executeReadCall(call, sources, skillContext)
        results.push({ callId: call.id, name: call.name, ok: true, output: outputJson(value) })
      } catch (error) {
        results.push({
          callId: call.id,
          name: call.name,
          ok: false,
          output: toolText(error instanceof Error ? error.message : String(error), 500),
        })
      }
    }
    return {
      results,
      sources: [...new Map(sources.map((source) => [source.path, source])).values()],
    }
  }

  private async executeReadCall(
    call: VaultAgentToolCall,
    sources: VaultAgentExecution['sources'],
    skillContext?: ActiveLocalSkillContext,
  ): Promise<unknown> {
    if (call.name === 'vault_search') {
      const query = toolText(call.arguments.query, 240)
      if (!query) throw new Error('vault_search 缺少 query')
      const maxResults = clampInt(call.arguments.maxResults, 8, 1, 8)
      const response = await this.search.searchForAgent(query, {
        maxSources: maxResults,
        maxExcerptChars: 2_400,
        maxTotalChars: 12_000,
        excludedFolders: [this.localSkillsRoot()],
      })
      const safeResults = response.results.filter((result) => !this.protected(result.path))
      for (const result of safeResults) {
        sources.push({
          sourceId: call.id,
          filename: result.filename,
          path: result.path,
        })
      }
      return {
        query,
        fact: response.fact
          ? {
              filename: response.fact.filename,
              excerpt: response.fact.excerpt,
            }
          : undefined,
        matches: safeResults.map((result) => ({
          path: result.path,
          filename: result.filename,
          excerpt: result.excerpt,
        })),
      }
    }

    if (call.name === 'list_folder') {
      const rawPath = toolText(call.arguments.path, 240)
      const path = rawPath ? normalizeVaultRelativePath(rawPath) : ''
      if (rawPath && !path) throw new Error('文件夹路径不合法')
      if (path && this.protected(path)) throw new Error('该目录属于插件保护范围，不能读取')
      const depth = clampInt(call.arguments.depth, 1, 1, LIST_FOLDER_MAX_DEPTH)
      const offset = clampInt(
        call.arguments.offset,
        0,
        0,
        LIST_FOLDER_SCAN_MAX_ENTRIES,
      )
      const maxEntries = clampInt(
        call.arguments.maxEntries,
        80,
        1,
        LIST_FOLDER_MAX_ENTRIES,
      )
      const root = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot()
      if (!(root instanceof TFolder)) throw new Error(`没有找到文件夹：${path || '/'}`)
      const entries: Array<{
        path: string
        type: 'folder' | 'file'
        size?: number
        modifiedAt?: number
      }> = []
      let scanTruncated = false
      const walk = (folder: TFolder, level: number) => {
        if (entries.length >= LIST_FOLDER_SCAN_MAX_ENTRIES) {
          scanTruncated = true
          return
        }
        if (level > depth) return
        const children = [...folder.children].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
        for (const child of children) {
          if (entries.length >= LIST_FOLDER_SCAN_MAX_ENTRIES) {
            scanTruncated = true
            break
          }
          if (this.protected(child.path)) continue
          if (child instanceof TFolder) {
            entries.push({ path: child.path, type: 'folder' })
            walk(child, level + 1)
          } else if (child instanceof TFile && isLocalSearchExtension(child.extension)) {
            entries.push({
              path: child.path,
              type: 'file',
              size: child.stat.size,
              modifiedAt: child.stat.mtime,
            })
          }
        }
      }
      walk(root, 1)
      const page = entries.slice(offset, offset + maxEntries)
      const nextOffset = offset + page.length < entries.length ? offset + page.length : null
      const totalFiles = entries.filter((entry) => entry.type === 'file').length
      const totalFolders = entries.length - totalFiles
      return {
        path: path || '/',
        depth,
        totalEntries: entries.length,
        totalFiles,
        totalFolders,
        returnedEntries: page.length,
        offset,
        nextOffset,
        truncated: nextOffset !== null || scanTruncated,
        scanTruncated,
        entries: page,
      }
    }

    if (call.name === 'read_note') {
      const path = normalizeVaultRelativePath(call.arguments.path)
      if (!path) throw new Error('read_note 缺少合法 path')
      if (this.protected(path)) throw new Error('该文件属于插件保护范围，不能读取')
      const offset = clampInt(call.arguments.offset, 0, 0, 120_000)
      const maxChars = clampInt(call.arguments.maxChars, 12_000, 500, READ_NOTE_MAX_CHARS)
      const result = await this.search.readPath(path, { offset, maxChars })
      sources.push({ sourceId: call.id, filename: result.filename, path })
      return result
    }

    if (call.name === 'read_skill_file') {
      if (!skillContext) throw new Error('本轮没有正在执行的 Skill')
      const rawPath = toolText(call.arguments.path, 240)
      const path = resolveSkillPath(rawPath, skillContext)
      const offset = clampInt(call.arguments.offset, 0, 0, 1_000_000)
      const maxChars = clampInt(call.arguments.maxChars, 12_000, 500, READ_NOTE_MAX_CHARS)
      const file = this.app.vault.getAbstractFileByPath(path)
      if (!(file instanceof TFile)) throw new Error(`没有找到 Skill 文件：${path}`)
      if (!SKILL_TEXT_EXTENSIONS.has(file.extension.toLocaleLowerCase())) {
        throw new Error(`Skill 工具只能读取文字型文件：${path}`)
      }
      const text = await this.app.vault.cachedRead(file)
      const content = text.slice(offset, offset + maxChars)
      const nextOffset = offset + content.length < text.length ? offset + content.length : null
      const readThrough = extendContiguousRead(
        skillContext.readThroughByPath[path] ?? 0,
        offset,
        content.length,
      )
      skillContext.readThroughByPath[path] = readThrough
      if (readThrough >= text.length && !skillContext.fullyReadPaths.includes(path)) {
        skillContext.fullyReadPaths.push(path)
      }
      return {
        filename: file.name,
        content,
        offset,
        totalChars: text.length,
        nextOffset,
        truncated: nextOffset !== null,
      }
    }

    if (call.name === 'propose_skill_action') {
      throw new Error('本地动作必须经过对话确认流程，不能作为只读工具直接执行')
    }

    throw new Error(`不支持的 Vault 工具：${call.name satisfies never}`)
  }

  async applyPlan(
    plan: VaultOrganizePlan,
    writeSnapshots: VaultWriteSnapshot[] = [],
  ): Promise<VaultActionRecord> {
    const trashOps = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'trash_note' }> =>
        operation.type === 'trash_note',
    )
    const moveOps = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'move' }> =>
        operation.type === 'move',
    )
    const createOps = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'create_folder' }> =>
        operation.type === 'create_folder',
    )
    const noteWriteOps = plan.operations.filter(
      (operation): operation is Extract<
        (typeof plan.operations)[number],
        { type: 'create_note' | 'append_note' | 'replace_note' | 'update_note' }
      > =>
        operation.type === 'create_note' ||
        operation.type === 'append_note' ||
        operation.type === 'replace_note' ||
        operation.type === 'update_note',
    )
    let lockedWriteSnapshot: VaultWriteSnapshot | undefined
    const sources = new Set<string>()
    const destinations = new Set<string>()

    for (const operation of plan.operations) {
      const paths = operation.type === 'move' ? [operation.from, operation.to] : [operation.path]
      if (paths.some((path) => this.protected(path))) {
        throw new Error(`方案涉及保护目录，已拒绝：${paths.join(' → ')}`)
      }
    }

    if (trashOps.length > 0) {
      if (trashOps.length !== 1 || plan.operations.length !== 1) {
        throw new Error('为避免误删，每次确认只能把一篇 Markdown 笔记移入回收站')
      }
      const operation = trashOps[0]
      const file = this.app.vault.getAbstractFileByPath(operation.path)
      if (!(file instanceof TFile)) throw new Error(`没有找到可删除的笔记：${operation.path}`)
      if (file.extension.toLocaleLowerCase() !== 'md') {
        throw new Error('删除功能只允许把 Markdown 笔记移入回收站，不能删除附件或文件夹')
      }
      // Obsidian 的 system=true 会优先使用系统废纸篓/回收站；若系统不允许，
      // Obsidian 会退回自己的 .trash。这里绝不调用 vault.delete() 永久删除。
      await this.app.vault.trash(file, true)
      this.search.clear()
      return {
        id: `vault-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        planTitle: plan.title,
        moves: [],
        createdFolders: [],
        trashedNotes: [operation.path],
        createdNotes: [],
        updatedNotes: [],
      }
    }

    if (noteWriteOps.length > 0) {
      if (noteWriteOps.length !== 1 || plan.operations.length !== 1) {
        throw new Error('为避免跨文件误写，每次确认只能写入一篇 Markdown 笔记，不能混入其他操作')
      }
      const operation = noteWriteOps[0]
      if (fileExtension(operation.path) !== 'md') {
        throw new Error('跨文件写入只允许 Markdown 笔记，不能修改附件或其他文件类型')
      }
      const existing = this.app.vault.getAbstractFileByPath(operation.path)
      if (operation.type === 'create_note') {
        if (existing) throw new Error(`目标笔记已存在，绝不覆盖：${operation.path}`)
      } else {
        if (!(existing instanceof TFile)) throw new Error(`没有找到要写入的笔记：${operation.path}`)
        lockedWriteSnapshot = writeSnapshots.find((item) => item.path === operation.path)
        if (!lockedWriteSnapshot) throw new Error('缺少目标笔记的锁定版本，请让 AI 重新读取并生成方案')
        if (
          existing.stat.mtime !== lockedWriteSnapshot.mtime ||
          existing.stat.size !== lockedWriteSnapshot.size
        ) {
          throw new Error(`目标笔记在确认前已经变化，已停止写入：${operation.path}`)
        }
      }
    }

    for (const operation of moveOps) {
      if (sources.has(operation.from)) throw new Error(`重复移动同一路径：${operation.from}`)
      if (destinations.has(operation.to)) throw new Error(`多个文件指向同一位置：${operation.to}`)
      const source = this.app.vault.getAbstractFileByPath(operation.from)
      if (!source) throw new Error(`源文件不存在：${operation.from}`)
      if (this.app.vault.getAbstractFileByPath(operation.to)) {
        throw new Error(`目标已存在，绝不覆盖：${operation.to}`)
      }
      if (source instanceof TFile && fileExtension(operation.from) !== fileExtension(operation.to)) {
        throw new Error(`移动/重命名不能改变文件类型：${operation.from}`)
      }
      if (source instanceof TFolder && operation.to.startsWith(`${operation.from}/`)) {
        throw new Error(`不能把文件夹移动到自己内部：${operation.from}`)
      }
      sources.add(operation.from)
      destinations.add(operation.to)
    }

    const moveSources = [...sources]
    for (let index = 0; index < moveSources.length; index++) {
      for (let other = index + 1; other < moveSources.length; other++) {
        if (
          moveSources[index].startsWith(`${moveSources[other]}/`) ||
          moveSources[other].startsWith(`${moveSources[index]}/`)
        ) {
          throw new Error('同一方案不能同时移动父文件夹和其中的子文件，请让 AI 拆成两次')
        }
      }
    }

    const createdFolders: string[] = []
    const ensureFolder = async (path: string) => {
      const normalized = normalizePath(path)
      if (!normalized) return
      let current = ''
      for (const segment of normalized.split('/')) {
        current = current ? `${current}/${segment}` : segment
        const existing = this.app.vault.getAbstractFileByPath(current)
        if (existing instanceof TFolder) continue
        if (existing) throw new Error(`目标父路径不是文件夹：${current}`)
        await this.app.vault.createFolder(current)
        createdFolders.push(current)
      }
    }

    const completedMoves: { from: string; to: string }[] = []
    const createdNotes: string[] = []
    const updatedNotes: string[] = []
    try {
      for (const operation of createOps) await ensureFolder(operation.path)
      if (noteWriteOps.length === 1) {
        const operation = noteWriteOps[0]
        const parent = operation.path.split('/').slice(0, -1).join('/')
        if (parent) await ensureFolder(parent)
        if (operation.type === 'create_note') {
          await this.app.vault.create(normalizePath(operation.path), `${operation.content.trim()}\n`)
          createdNotes.push(operation.path)
        } else if (operation.type === 'append_note') {
          const file = this.app.vault.getAbstractFileByPath(operation.path)
          if (!(file instanceof TFile)) throw new Error(`执行前目标笔记已移动或删除：${operation.path}`)
          if (
            !lockedWriteSnapshot ||
            file.stat.mtime !== lockedWriteSnapshot.mtime ||
            file.stat.size !== lockedWriteSnapshot.size
          ) {
            throw new Error(`目标笔记在确认前已经变化，已停止写入：${operation.path}`)
          }
          await this.app.vault.process(file, (content) => {
            const addition = operation.content.trim()
            if (content.includes(addition)) return content
            return `${content.trimEnd()}\n\n${addition}\n`
          })
          updatedNotes.push(operation.path)
        } else if (operation.type === 'replace_note') {
          const file = this.app.vault.getAbstractFileByPath(operation.path)
          if (!(file instanceof TFile)) throw new Error(`执行前目标笔记已移动或删除：${operation.path}`)
          if (
            !lockedWriteSnapshot ||
            file.stat.mtime !== lockedWriteSnapshot.mtime ||
            file.stat.size !== lockedWriteSnapshot.size
          ) {
            throw new Error(`目标笔记在确认前已经变化，已停止写入：${operation.path}`)
          }
          await this.app.vault.process(file, (content) => {
            const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0] ?? ''
            return `${frontmatter}${operation.content.trim()}\n`
          })
          updatedNotes.push(operation.path)
        } else {
          const file = this.app.vault.getAbstractFileByPath(operation.path)
          if (!(file instanceof TFile)) throw new Error(`执行前目标笔记已移动或删除：${operation.path}`)
          if (
            !lockedWriteSnapshot ||
            file.stat.mtime !== lockedWriteSnapshot.mtime ||
            file.stat.size !== lockedWriteSnapshot.size
          ) {
            throw new Error(`目标笔记在确认前已经变化，已停止写入：${operation.path}`)
          }
          await this.app.vault.process(file, (content) =>
            applyNotePatch(content, {
              displayText: '',
              operations: operation.replacements,
            }).content,
          )
          updatedNotes.push(operation.path)
        }
      }
      for (const operation of moveOps) {
        const parent = operation.to.split('/').slice(0, -1).join('/')
        if (parent) await ensureFolder(parent)
        const source = this.app.vault.getAbstractFileByPath(operation.from)
        if (!source) throw new Error(`执行前源文件已移动或删除：${operation.from}`)
        await this.app.fileManager.renameFile(source, normalizePath(operation.to))
        completedMoves.push({ from: operation.from, to: operation.to })
      }
    } catch (error) {
      for (const move of [...completedMoves].reverse()) {
        try {
          const current = this.app.vault.getAbstractFileByPath(move.to)
          if (current && !this.app.vault.getAbstractFileByPath(move.from)) {
            await this.app.fileManager.renameFile(current, normalizePath(move.from))
          }
        } catch {
          // Best-effort rollback; caller still receives the original error.
        }
      }
      throw error
    }

    this.search.clear()
    return {
      id: `vault-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      planTitle: plan.title,
      moves: completedMoves,
      createdFolders: [...new Set(createdFolders)],
      trashedNotes: [],
      createdNotes,
      updatedNotes,
    }
  }

  async undo(record: VaultActionRecord): Promise<void> {
    if ((record.trashedNotes?.length ?? 0) > 0 && record.moves.length === 0) {
      throw new Error('回收站中的笔记请从系统废纸篓/回收站恢复，插件不会永久删除')
    }
    if (((record.createdNotes?.length ?? 0) > 0 || (record.updatedNotes?.length ?? 0) > 0) && record.moves.length === 0) {
      throw new Error('笔记写入请使用 Obsidian 撤销或“文件恢复”回滚，插件不会自动删除或覆盖恢复')
    }
    if (record.undoneAt) throw new Error('这次整理已经撤销过了')
    for (const move of [...record.moves].reverse()) {
      const current = this.app.vault.getAbstractFileByPath(move.to)
      if (!current) throw new Error(`无法撤销，当前位置已不存在：${move.to}`)
      if (this.app.vault.getAbstractFileByPath(move.from)) {
        throw new Error(`无法撤销，原位置已有同名文件：${move.from}`)
      }
    }
    for (const move of [...record.moves].reverse()) {
      const current = this.app.vault.getAbstractFileByPath(move.to)
      if (!current) throw new Error(`无法撤销：${move.to}`)
      const parent = move.from.split('/').slice(0, -1).join('/')
      if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
        let currentFolder = ''
        for (const segment of parent.split('/')) {
          currentFolder = currentFolder ? `${currentFolder}/${segment}` : segment
          if (!this.app.vault.getAbstractFileByPath(currentFolder)) {
            await this.app.vault.createFolder(currentFolder)
          }
        }
      }
      await this.app.fileManager.renameFile(current, normalizePath(move.from))
    }
    this.search.clear()
  }
}

function resolveSkillPath(
  rawPath: string,
  context: ActiveLocalSkillContext,
): string {
  if (!rawPath) throw new Error('Skill 工具缺少 path')
  const raw = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (context.linkedPaths.includes(raw)) return normalizePath(raw)
  const linkedPath = localSkillLinkedPathCandidates(raw, context.directory, context.root)
    .find((path) => context.linkedPaths.includes(path))
  if (linkedPath) return normalizePath(linkedPath)
  const base = raw === 'SKILL.md'
    ? context.entryPath
    : raw.startsWith(`${context.directory}/`)
      ? raw
    : `${context.directory}/${raw}`
  const segments: string[] = []
  for (const segment of base.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length <= context.directory.split('/').length) {
        throw new Error('Skill 文件不能离开当前 Skill 目录')
      }
      segments.pop()
      continue
    }
    if (segment.startsWith('.')) throw new Error('Skill 文件不能使用隐藏路径')
    segments.push(segment)
  }
  const path = segments.join('/')
  if (path !== context.directory && !path.startsWith(`${context.directory}/`)) {
    throw new Error('Skill 文件不能离开当前 Skill 目录')
  }
  return normalizePath(path)
}

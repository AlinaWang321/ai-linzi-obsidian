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
} from './vault-agent-core'

const TOOL_OUTPUT_MAX_CHARS = 20_000
const READ_NOTE_MAX_CHARS = 16_000
const LIST_FOLDER_MAX_ENTRIES = 160

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
    const results: VaultAgentToolResult[] = []
    const sources: VaultAgentExecution['sources'] = []
    for (const call of calls) {
      try {
        const value = await this.executeReadCall(call, sources)
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
      const depth = clampInt(call.arguments.depth, 1, 1, 3)
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
      const walk = (folder: TFolder, level: number) => {
        if (entries.length >= maxEntries || level > depth) return
        const children = [...folder.children].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
        for (const child of children) {
          if (entries.length >= maxEntries || this.protected(child.path)) continue
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
      return { path: path || '/', depth, truncated: entries.length >= maxEntries, entries }
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

    throw new Error(`不支持的 Vault 工具：${call.name satisfies never}`)
  }

  async applyPlan(plan: VaultOrganizePlan): Promise<VaultActionRecord> {
    const moveOps = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'move' }> =>
        operation.type === 'move',
    )
    const createOps = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'create_folder' }> =>
        operation.type === 'create_folder',
    )
    const sources = new Set<string>()
    const destinations = new Set<string>()

    for (const operation of plan.operations) {
      const paths = operation.type === 'move' ? [operation.from, operation.to] : [operation.path]
      if (paths.some((path) => this.protected(path))) {
        throw new Error(`方案涉及保护目录，已拒绝：${paths.join(' → ')}`)
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
    try {
      for (const operation of createOps) await ensureFolder(operation.path)
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
    }
  }

  async undo(record: VaultActionRecord): Promise<void> {
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

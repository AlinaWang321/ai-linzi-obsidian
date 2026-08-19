import { App, TFile, TFolder, normalizePath, parseYaml } from 'obsidian'
import { isLocalSearchExtension } from './local-document-text'
import { LocalVaultSearch } from './vault-search'
import {
  collectOrganizePlanProblems,
  isProtectedVaultPath,
  normalizeVaultRelativePath,
  shouldBlockPlanPath,
  type VaultAgentToolCall,
  type VaultAgentToolResult,
  type VaultOrganizePlan,
  type VaultWriteSnapshot,
  normalizeFolderKey,
  applyRecentListFilter,
  isRecentListRequest,
} from './vault-agent-core'
import type { ActiveLocalSkillContext } from './local-skills'
import { extendContiguousRead, localSkillLinkedPathCandidates } from './local-skill-core'
import {
  appendNoteContent,
  applyStructuredNoteUpdate,
  replaceNoteBody,
  splitFrontmatter,
} from './note-patch'
import { validateMarkdownAgainstTemplate } from './skill-template'
import {
  ARTIFACT_MAX_CONTENT_CHARS,
  resolveArtifactPath,
  type CreateArtifactOperation,
} from './artifact-renderer-core'

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
  /** 本机渲染的新文件只记录路径，二进制内容绝不进入 data.json。 */
  createdArtifacts?: string[]
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


/**
 * 按名字宽松匹配文件夹（0.7.59）。精确路径优先，其次逐层比对归一化后的名字。
 * loose=true 时额外接受「包含」关系，用于找不到时给出相近候选。
 */
function matchFoldersByName(root: TFolder, query: string, loose = false): TFolder[] {
  const wanted = normalizeFolderKey(query.split('/').at(-1) ?? query)
  if (!wanted) return []
  const hits: TFolder[] = []
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue
      const key = normalizeFolderKey(child.name)
      if (key === wanted || (loose && key.length > 0 && (key.includes(wanted) || wanted.includes(key)))) {
        hits.push(child)
      }
      walk(child)
    }
  }
  walk(root)
  return hits
}

export class LocalVaultAgent {
  constructor(
    private readonly app: App,
    private readonly search: LocalVaultSearch,
    private readonly localSkillsRoot: () => string,
    private readonly outputRoot: () => string,
  ) {}

  private protected(path: string): boolean {
    return isProtectedVaultPath(path, this.localSkillsRoot())
  }

  /** 整夹移入回收站前确认没有裹挟受保护文件（Skills 根目录、开发辅助文件等）。 */
  private assertFolderTrashable(folder: TFolder): void {
    const stack: TFolder[] = [folder]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      for (const child of current.children) {
        if (this.protected(child.path)) {
          throw new Error(
            `文件夹「${folder.path}」内包含受保护路径「${child.path}」，不能整夹移入回收站`,
          )
        }
        if (child instanceof TFolder) stack.push(child)
      }
    }
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

  private validateYamlFrontmatter(content: string): void {
    const { frontmatter } = splitFrontmatter(content)
    if (!frontmatter) return
    const yaml = frontmatter
      .replace(/^---\r?\n/, '')
      .replace(/\r?\n---(?:\r?\n|$)$/, '')
    let parsed: unknown
    try {
      parsed = parseYaml(yaml)
    } catch {
      throw new Error('待写入的 YAML 属性格式无效')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('待写入的 YAML 属性必须是键值结构')
    }
  }

  private async previewNoteWrite(
    operation: Extract<VaultOrganizePlan['operations'][number], {
      type: 'create_note' | 'append_note' | 'replace_note' | 'update_note'
    }>,
  ): Promise<string> {
    if (operation.type === 'create_note') {
      if (this.app.vault.getAbstractFileByPath(operation.path)) {
        throw new Error(`目标笔记已存在，不能覆盖：${operation.path}`)
      }
      this.validateYamlFrontmatter(operation.content)
      return `${operation.content.trim()}\n`
    }
    const file = this.app.vault.getAbstractFileByPath(operation.path)
    if (!(file instanceof TFile)) throw new Error(`目标笔记不存在：${operation.path}`)
    const content = await this.app.vault.cachedRead(file)
    const next = operation.type === 'append_note'
      ? appendNoteContent(content, operation.content)
      : operation.type === 'replace_note'
        ? replaceNoteBody(content, operation.content)
        : applyStructuredNoteUpdate(
            content,
            operation.replacements ?? [],
            operation.frontmatter,
          ).content
    this.validateYamlFrontmatter(next)
    return next
  }

  /**
   * 确认卡出现前先在本机做一次完整 dry-run。失败只返回给工具循环重做方案，
   * 用户不会再看到一个注定无法执行的按钮。
   */
  async preflightPlan(
    plan: VaultOrganizePlan,
    skillContext?: ActiveLocalSkillContext,
  ): Promise<void> {
    // 新建文件夹/移动/删除方案的全量路径校验（2026-08-17 客户反馈补上）：
    // 模型猜错路径时在这里一次列出全部问题打回重做，而不是等用户确认后才炸。
    const problems = collectOrganizePlanProblems(
      plan,
      (path) => {
        const item = this.app.vault.getAbstractFileByPath(normalizePath(path))
        return item instanceof TFolder ? 'folder' : item instanceof TFile ? 'file' : null
      },
      this.localSkillsRoot(),
    )
    if (problems.length > 0) throw new Error(problems.join('；'))
    // 整夹删除前确认没有裹挟受保护路径（Skills 根目录、开发辅助文件等）。
    for (const operation of plan.operations) {
      if (operation.type !== 'trash_note') continue
      const item = this.app.vault.getAbstractFileByPath(normalizePath(operation.path))
      if (item instanceof TFolder) this.assertFolderTrashable(item)
    }
    const artifactOperation = plan.operations.length === 1 && plan.operations[0].type === 'create_artifact'
      ? plan.operations[0]
      : undefined
    if (artifactOperation) {
      this.validateArtifactOperation(artifactOperation)
      return
    }
    const writeOperation = plan.operations.length === 1 &&
      (plan.operations[0].type === 'create_note' ||
        plan.operations[0].type === 'append_note' ||
        plan.operations[0].type === 'replace_note' ||
        plan.operations[0].type === 'update_note')
      ? plan.operations[0]
      : undefined
    if (!writeOperation) return
    const preview = await this.previewNoteWrite(writeOperation)
    if (!skillContext?.templatePath) return
    const templateFile = this.app.vault.getAbstractFileByPath(skillContext.templatePath)
    if (!(templateFile instanceof TFile)) {
      throw new Error(`Skill 模板已经移动或删除：${skillContext.templatePath}`)
    }
    const template = await this.app.vault.cachedRead(templateFile)
    validateMarkdownAgainstTemplate(preview, template)
  }

  private artifactPath(operation: CreateArtifactOperation): string {
    const resolved = normalizeVaultRelativePath(resolveArtifactPath(operation.path, this.outputRoot()))
    if (!resolved) throw new Error('成品文件路径不合法')
    return resolved
  }

  private validateArtifactOperation(operation: CreateArtifactOperation): string {
    const path = this.artifactPath(operation)
    if (this.protected(path)) throw new Error(`成品文件不能写入保护目录：${path}`)
    if (fileExtension(path) !== operation.format) {
      throw new Error(`文件扩展名必须与 ${operation.format.toUpperCase()} 格式一致`)
    }
    if (!operation.title.trim()) throw new Error('成品文件缺少标题')
    if (!operation.content.trim()) throw new Error('成品文件缺少正文')
    if (operation.content.length > ARTIFACT_MAX_CONTENT_CHARS) {
      throw new Error(`成品正文超过 ${ARTIFACT_MAX_CONTENT_CHARS.toLocaleString()} 字，请拆分后生成`)
    }
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error(`目标文件已存在，绝不覆盖：${path}`)
    }
    return path
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
      // 0.7.60 时间查询：sortBy="modified" / sinceDays=N。时间模式默认扫全库（12 层），
      // 否则「最近改了什么」还得模型自己逐层翻。
      const sortBy = toolText(call.arguments.sortBy, 16)
      const sinceDays = clampInt(call.arguments.sinceDays, 0, 0, 365)
      const recentRequested = isRecentListRequest({ sortBy, sinceDays })
      const depth = clampInt(
        call.arguments.depth,
        recentRequested ? LIST_FOLDER_MAX_DEPTH : 1,
        1,
        LIST_FOLDER_MAX_DEPTH,
      )
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
      let root = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot()
      // 2026-08-19：用户说「放到 output 文件夹」，真实目录叫「03 output」——旧实现要求
      // 路径逐字相同，对不上就直接报「没有找到文件夹」，AI 只能改去一个个 list_folder 猜，
      // 于是出现「反复说继续却不干活」。现在按名字模糊解析一次；仍找不到就把最接近的
      // 候选列给 AI，让它换准确路径重试，而不是空手而归。
      if (!(root instanceof TFolder) && path) {
        const matches = matchFoldersByName(this.app.vault.getRoot(), path)
        if (matches.length === 1) {
          root = matches[0]
        } else if (matches.length > 1) {
          throw new Error(
            `「${path}」匹配到多个文件夹，请用准确路径重试：${matches.map((f) => f.path).slice(0, 8).join('、')}`,
          )
        }
      }
      if (!(root instanceof TFolder)) {
        const near = path ? matchFoldersByName(this.app.vault.getRoot(), path, true) : []
        throw new Error(
          near.length > 0
            ? `没有找到文件夹「${path}」。相近的有：${near.map((f) => f.path).slice(0, 8).join('、')}`
            : `没有找到文件夹：${path || '/'}`,
        )
      }
      const entries: Array<{
        path: string
        type: 'folder' | 'file'
        size?: number
        modifiedAt?: number
        readable?: boolean
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
          } else if (child instanceof TFile) {
            // v0.7.42 起列出全部文件类型（图片/音视频/压缩包也算数）；
            // readable 告诉模型这个文件能不能用 read_note 读到正文。
            entries.push({
              path: child.path,
              type: 'file',
              size: child.stat.size,
              modifiedAt: child.stat.mtime,
              readable: isLocalSearchExtension(child.extension),
            })
          }
        }
      }
      walk(root, 1)
      const recent = applyRecentListFilter(entries, { sortBy, sinceDays, now: Date.now() })
      const finalEntries = recent.recentMode ? recent.entries : entries
      const page = finalEntries.slice(offset, offset + maxEntries)
      const nextOffset = offset + page.length < finalEntries.length ? offset + page.length : null
      const totalFiles = finalEntries.filter((entry) => entry.type === 'file').length
      const totalFolders = finalEntries.length - totalFiles
      return {
        path: path || '/',
        depth,
        ...(recent.recentMode ? { mode: 'recent', sortBy: 'modified', sinceDays: sinceDays || undefined } : {}),
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
    const artifactOps = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'create_artifact' }> =>
        operation.type === 'create_artifact',
    )
    let lockedWriteSnapshot: VaultWriteSnapshot | undefined
    const sources = new Set<string>()
    const destinations = new Set<string>()

    for (const operation of plan.operations) {
      const paths = operation.type === 'move'
        ? [operation.from, operation.to]
        : [operation.type === 'create_artifact' ? this.artifactPath(operation) : operation.path]
      const blocked = paths.filter((path) =>
        shouldBlockPlanPath(path, operation.type, this.localSkillsRoot()),
      )
      if (blocked.length > 0) {
        throw new Error(`方案涉及保护目录，已拒绝：${blocked.join(' → ')}`)
      }
    }

    if (trashOps.length > 0) {
      // v0.7.42 起支持批量、任意文件类型和文件夹；仍要求纯删除成卡，
      // 确认卡文案才能与真实行为一致（校验口径与 collectOrganizePlanProblems 同步）。
      if (trashOps.length !== plan.operations.length) {
        throw new Error('移入回收站的方案不能混入移动、新建等其他操作，请拆成两次确认')
      }
      const seen = new Set<string>()
      const targets: { path: string; isFolder: boolean }[] = []
      for (const operation of trashOps) {
        if (seen.has(operation.path)) throw new Error(`重复的删除目标：${operation.path}`)
        seen.add(operation.path)
        const item = this.app.vault.getAbstractFileByPath(operation.path)
        if (!(item instanceof TFile) && !(item instanceof TFolder)) {
          throw new Error(`没有找到要移入回收站的文件或文件夹：${operation.path}`)
        }
        if (item instanceof TFolder) this.assertFolderTrashable(item)
        targets.push({ path: operation.path, isFolder: item instanceof TFolder })
      }
      for (const target of targets) {
        for (const other of targets) {
          if (target !== other && target.path.startsWith(`${other.path}/`)) {
            throw new Error(`「${target.path}」已在待删除文件夹「${other.path}」内，请去掉重复项`)
          }
        }
      }
      const trashed: string[] = []
      try {
        for (const target of targets) {
          const current = this.app.vault.getAbstractFileByPath(target.path)
          if (!current) throw new Error(`执行前已被移动或删除：${target.path}`)
          // Obsidian 的 system=true 会优先使用系统废纸篓/回收站；若系统不允许，
          // Obsidian 会退回自己的 .trash。这里绝不调用 vault.delete() 永久删除。
          await this.app.vault.trash(current, true)
          trashed.push(target.path)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          trashed.length > 0
            ? `已移入回收站 ${trashed.length} 项（可从回收站恢复），随后停止：${message}`
            : message,
        )
      } finally {
        if (trashed.length > 0) this.search.clear()
      }
      return {
        id: `vault-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        planTitle: plan.title,
        moves: [],
        createdFolders: [],
        trashedNotes: trashed,
        createdNotes: [],
        updatedNotes: [],
        createdArtifacts: [],
      }
    }

    if (artifactOps.length > 0) {
      if (artifactOps.length !== 1 || plan.operations.length !== 1) {
        throw new Error('为避免误写，每次确认只能生成一个成品文件，不能混入其他操作')
      }
      this.validateArtifactOperation(artifactOps[0])
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
    const createdArtifacts: string[] = []
    try {
      for (const operation of createOps) await ensureFolder(operation.path)
      if (artifactOps.length === 1) {
        const operation = artifactOps[0]
        const path = this.validateArtifactOperation(operation)
        // DOCX/PDF/PPTX 渲染依赖体积较大，也可能访问只在完整浏览器窗口中
        // 提供的 API。仅在用户确认生成成品后加载，不能拖垮插件启动。
        const { renderArtifact } = await import('./artifact-renderer')
        // 先在内存中完整渲染；任何渲染错误都不会留下半成品文件。
        const rendered = await renderArtifact(operation)
        const parent = path.split('/').slice(0, -1).join('/')
        if (parent) await ensureFolder(parent)
        if (this.app.vault.getAbstractFileByPath(path)) {
          throw new Error(`目标文件在确认后已经出现，绝不覆盖：${path}`)
        }
        if (rendered.binary) {
          if (!(rendered.data instanceof ArrayBuffer)) throw new Error('二进制成品渲染结果无效')
          await this.app.vault.createBinary(normalizePath(path), rendered.data)
        } else {
          if (typeof rendered.data !== 'string') throw new Error('HTML 成品渲染结果无效')
          await this.app.vault.create(normalizePath(path), rendered.data)
        }
        createdArtifacts.push(path)
      }
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
            const next = appendNoteContent(content, operation.content)
            this.validateYamlFrontmatter(next)
            return next
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
            const next = replaceNoteBody(content, operation.content)
            this.validateYamlFrontmatter(next)
            return next
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
          await this.app.vault.process(file, (content) => {
            const next = applyStructuredNoteUpdate(
              content,
              operation.replacements ?? [],
              operation.frontmatter,
            ).content
            this.validateYamlFrontmatter(next)
            return next
          })
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
      createdArtifacts,
    }
  }

  async undo(record: VaultActionRecord): Promise<void> {
    if ((record.trashedNotes?.length ?? 0) > 0 && record.moves.length === 0) {
      throw new Error('回收站中的文件请从系统废纸篓/回收站恢复，插件不会永久删除')
    }
    if (((record.createdNotes?.length ?? 0) > 0 || (record.updatedNotes?.length ?? 0) > 0) && record.moves.length === 0) {
      throw new Error('笔记写入请使用 Obsidian 撤销或“文件恢复”回滚，插件不会自动删除或覆盖恢复')
    }
    if ((record.createdArtifacts?.length ?? 0) > 0 && record.moves.length === 0) {
      throw new Error('成品文件不会被插件自动删除；如需移除，请在 Obsidian 中移入回收站')
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

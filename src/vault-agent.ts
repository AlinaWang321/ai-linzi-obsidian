import { App, TFile, TFolder, normalizePath, parseYaml } from 'obsidian'
import { isLocalSearchExtension } from './local-document-text'
import { LocalVaultSearch } from './vault-search'
import { isPathInsideFolder } from './vault-search-core'
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
  resolveUserSpecifiedFolderPath,
  applyRecentListFilter,
  isRecentListRequest,
  resolveVaultPlanPaths,
  VAULT_NOTE_WRITE_MAX_FILES,
  vaultPathsOverlap,
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
  presentationContentProblem,
  resolveArtifactPath,
  type CreateArtifactOperation,
} from './artifact-renderer-core'
import {
  selectWeeklyBusinessRefresh,
  type WeeklyBusinessDashboardCache,
  type WeeklyBusinessFileFingerprint,
  type WeeklyBusinessScanState,
} from './weekly-business-cache'
import { buildVaultInventory } from './vault-inventory-core'

const TOOL_OUTPUT_MAX_CHARS = 20_000
const RECENT_DOCUMENT_OUTPUT_MAX_CHARS = 180_000
const RECENT_DOCUMENT_PAGE_MAX_CHARS = 70_000
const RECENT_DOCUMENT_FILE_MAX_CHARS = 80_000
const WEEKLY_DASHBOARD_BASELINE_MAX_CHARS = 60_000
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
  /**
   * read_recent_documents 的本机指纹不能只从序列化后的工具输出反解。
   * 正文页较大时 outputJson 会安全截断，snapshotId 也会一起被包进 preview，
   * 这会让周报已经生成、增量基线却没有保存。这里直接从原始返回值带出。
   */
  weeklyBusinessScan?: WeeklyBusinessScanState
}

export interface VaultActionRecord {
  id: string
  createdAt: number
  planTitle: string
  moves: { from: string; to: string }[]
  createdFolders: string[]
  /** 兼容旧 data.json；v0.7.67 起可记录一次确认内最多 12 篇 Markdown。 */
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

function outputJson(value: unknown, maxChars = TOOL_OUTPUT_MAX_CHARS): string {
  const raw = JSON.stringify(value)
  return raw.length <= maxChars
    ? raw
    : JSON.stringify({
        truncated: true,
        preview: raw.slice(0, Math.max(0, maxChars - 2_000)),
      })
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
  /**
   * 最近文档分页必须基于同一份路径快照。否则翻页期间 Obsidian 自动保存一篇笔记，
   * mtime 排序就会变化，offset 会静默跳过或重复文件。快照只驻本机内存，十分钟过期。
   */
  private readonly recentDocumentSnapshots = new Map<
    string,
    {
      createdAt: number
      sinceDays: number
      paths: string[]
      scan: WeeklyBusinessScanState
      mode: 'full' | 'incremental'
      unchangedFiles: number
      removedPaths: string[]
      baselineArtifactPath?: string
      baselineContent?: string
    }
  >()
  /**
   * 周报确定性预载与对话消息之间再留一层本机接缝保险。
   * 有些 Obsidian/WebView 运行路径会让大对象返回元数据没有跟随 Promise 结果保留下来；
   * 这里仍引用同一次 read_recent_documents 已完成快照，不在确认时重新扫描。
   */
  private latestWeeklyBusinessScanState?: WeeklyBusinessScanState

  constructor(
    private readonly app: App,
    private readonly search: LocalVaultSearch,
    private readonly localSkillsRoot: () => string,
    private readonly outputRoot: () => string = () => 'AI霖子输出',
    private readonly weeklyDashboardCache: () => WeeklyBusinessDashboardCache | null = () => null,
    private readonly rawRoot: () => string = () => '01_Raw',
    private readonly wikiRoot: () => string = () => '02_Wiki',
  ) {}

  private resolvePlanPaths(plan: VaultOrganizePlan): VaultOrganizePlan {
    return resolveVaultPlanPaths(plan, {
      outputRoot: this.outputRoot(),
      rawRoot: this.rawRoot(),
      wikiRoot: this.wikiRoot(),
    })
  }

  /** 只交出路径/mtime/size，供用户确认生成看板后建立下一次增量基线。 */
  weeklyBusinessScanForSnapshot(snapshotId: string): WeeklyBusinessScanState | undefined {
    const scan = this.recentDocumentSnapshots.get(snapshotId)?.scan
    return scan
      ? { ...scan, files: scan.files.map((file) => ({ ...file })) }
      : undefined
  }

  latestWeeklyBusinessScan(): WeeklyBusinessScanState | undefined {
    const scan = this.latestWeeklyBusinessScanState
    return scan
      ? { ...scan, files: scan.files.map((file) => ({ ...file })) }
      : undefined
  }

  private protected(path: string): boolean {
    return isProtectedVaultPath(path, this.localSkillsRoot())
  }

  private remainingSkillReadFiles(skillContext: ActiveLocalSkillContext | undefined): number {
    const maxFiles = skillContext?.runtimePolicy?.vaultRead.maxFiles
    if (!maxFiles) return Number.POSITIVE_INFINITY
    return Math.max(0, maxFiles - skillContext.vaultReadPaths.length)
  }

  private recordSkillVaultRead(
    path: string,
    skillContext: ActiveLocalSkillContext | undefined,
  ): void {
    if (!skillContext || skillContext.vaultReadPaths.includes(path)) return
    if (this.remainingSkillReadFiles(skillContext) <= 0) {
      throw new Error(
        `这套 Skill 本轮最多读取 ${skillContext.runtimePolicy?.vaultRead.maxFiles ?? 0} 份 Vault 正文，已达到上限。`,
      )
    }
    skillContext.vaultReadPaths.push(path)
  }

  private assertSkillReadPathAllowed(
    path: string,
    skillContext: ActiveLocalSkillContext | undefined,
  ): void {
    const policy = skillContext?.runtimePolicy?.vaultRead
    if (!policy) return
    if (policy.scope === 'current-note' || policy.scope === 'user-specified-files') {
      throw new Error('这套 Skill 只允许读取发送时锁定的指定材料，不能扩大到 Vault 工具')
    }
    if (
      policy.scope === 'user-specified-folder' &&
      !skillContext?.allowedReadFolders?.some((folder) => isPathInsideFolder(path, folder))
    ) {
      throw new Error(`这套 Skill 只允许读取已锁定文件夹：${skillContext?.allowedReadFolders?.join('、') || '尚未指定'}`)
    }
  }

  resolveUserSpecifiedFolder(question: string):
    | { kind: 'matched'; path: string }
    | { kind: 'ambiguous'; paths: string[] }
    | { kind: 'missing' } {
    return resolveUserSpecifiedFolderPath(
      question,
      this.app.vault.getAllFolders()
        .filter((folder) => folder.path && !this.protected(folder.path))
        .map((folder) => ({ path: folder.path, name: folder.name })),
    )
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
    plan = this.resolvePlanPaths(plan)
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
    plan = this.resolvePlanPaths(plan)
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
    const writeOperations = plan.operations.filter(
      (operation): operation is Extract<VaultOrganizePlan['operations'][number], {
        type: 'create_note' | 'append_note' | 'replace_note' | 'update_note'
      }> =>
        operation.type === 'create_note' ||
        operation.type === 'append_note' ||
        operation.type === 'replace_note' ||
        operation.type === 'update_note',
    )
    if (writeOperations.length === 0) return
    // 官方“咨询交付闭环”明确承诺优先复用用户的真实客户库。
    // 普通 create_note 可以按用户指定路径自动补父目录。官方咨询闭环更严格：
    // 现有客户库必须真实存在；只有方案同时明确创建“客户档案”父目录、且它的
    // 上一级真实存在时才放行。这样既支持新用户首次建库，也阻止模型凭空猜整条路径。
    if (skillContext?.entryPath?.endsWith('/consultation-client-workflow/SKILL.md')) {
      for (const operation of writeOperations) {
        if (operation.type !== 'create_note') continue
        const parentPath = operation.path.split('/').slice(0, -1).join('/')
        const parent = parentPath
          ? this.app.vault.getAbstractFileByPath(normalizePath(parentPath))
          : this.app.vault.getRoot()
        if (!(parent instanceof TFolder)) {
          const plannedParent = plan.operations.some(
            (candidate) =>
              candidate.type === 'create_folder' &&
              normalizePath(candidate.path) === normalizePath(parentPath),
          )
          const grandparentPath = parentPath.split('/').slice(0, -1).join('/')
          const grandparent = grandparentPath
            ? this.app.vault.getAbstractFileByPath(normalizePath(grandparentPath))
            : this.app.vault.getRoot()
          if (plannedParent && grandparent instanceof TFolder) continue
          throw new Error(
            `客户档案父目录不存在：${parentPath || '/'}。` +
            '必须用 list_folder 核对用户真实客户库；若确需新建，方案必须同时创建该目录且其上一级真实存在，不得自动创建猜测目录。',
          )
        }
      }
    }
    const previews = await Promise.all(writeOperations.map((operation) => this.previewNoteWrite(operation)))
    if (!skillContext?.templatePath) return
    const templateFile = this.app.vault.getAbstractFileByPath(skillContext.templatePath)
    if (!(templateFile instanceof TFile)) {
      throw new Error(`Skill 模板已经移动或删除：${skillContext.templatePath}`)
    }
    const template = await this.app.vault.cachedRead(templateFile)
    for (const preview of previews) validateMarkdownAgainstTemplate(preview, template)
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
    const presentationProblem = presentationContentProblem(operation)
    if (presentationProblem) throw new Error(presentationProblem)
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
    let weeklyBusinessScan: WeeklyBusinessScanState | undefined
    for (const call of calls) {
      try {
        const value = await this.executeReadCall(call, sources, skillContext)
        if (call.name === 'read_recent_documents' && value && typeof value === 'object') {
          const snapshotId = (value as Record<string, unknown>).snapshotId
          if (typeof snapshotId === 'string') {
            weeklyBusinessScan = this.weeklyBusinessScanForSnapshot(snapshotId)
          }
        }
        results.push({
          callId: call.id,
          name: call.name,
          ok: true,
          output: outputJson(
            value,
            call.name === 'read_recent_documents'
              ? RECENT_DOCUMENT_OUTPUT_MAX_CHARS
              : TOOL_OUTPUT_MAX_CHARS,
          ),
        })
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
      weeklyBusinessScan,
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
      const readPolicy = skillContext?.runtimePolicy?.vaultRead
      if (readPolicy?.scope === 'current-note' || readPolicy?.scope === 'user-specified-files') {
        throw new Error('这套 Skill 只允许读取发送时锁定的指定材料，不能搜索整个 Vault')
      }
      if (
        readPolicy?.scope === 'user-specified-folder' &&
        !skillContext?.allowedReadFolders?.length
      ) {
        throw new Error('这套 Skill 尚未锁定用户指定文件夹，不能开始检索')
      }
      const remaining = this.remainingSkillReadFiles(skillContext)
      if (remaining <= 0) throw new Error('这套 Skill 已达到本轮 Vault 正文读取上限')
      const maxResults = Math.min(clampInt(call.arguments.maxResults, 8, 1, 8), remaining)
      const preferredFolders = readPolicy?.scope === 'user-specified-folder' ||
        (readPolicy?.scope === 'whole-vault' && readPolicy.preferUserScope)
        ? skillContext?.allowedReadFolders
        : undefined
      let searchedScope: 'specified-folder' | 'whole-vault' | 'whole-vault-fallback' =
        preferredFolders?.length ? 'specified-folder' : 'whole-vault'
      let response = await this.search.searchForAgent(query, {
        maxSources: maxResults,
        maxExcerptChars: 2_400,
        maxTotalChars: 12_000,
        excludedFolders: [this.localSkillsRoot()],
        includedFolders: preferredFolders,
      })
      if (
        response.results.length === 0 &&
        !response.fact &&
        preferredFolders?.length &&
        readPolicy?.scope === 'whole-vault' &&
        readPolicy.fallbackToWholeVault
      ) {
        response = await this.search.searchForAgent(query, {
          maxSources: maxResults,
          maxExcerptChars: 2_400,
          maxTotalChars: 12_000,
          excludedFolders: [this.localSkillsRoot()],
        })
        searchedScope = 'whole-vault-fallback'
      }
      const safeResults = response.results.filter((result) => !this.protected(result.path))
      for (const result of safeResults) {
        this.recordSkillVaultRead(result.path, skillContext)
        sources.push({
          sourceId: call.id,
          filename: result.filename,
          path: result.path,
        })
      }
      return {
        query,
        searchedScope,
        index: response.indexStatus
          ? {
              ...response.indexStatus,
              complete: response.indexStatus.pending === 0,
              note: response.indexStatus.pending > 0
                ? '本机索引仍在增量建立；当前无命中时不能断言 Vault 中不存在，请结合文件夹/文件名缩小范围或稍后重试。'
                : '本机索引已覆盖当前可检索文件。',
            }
          : undefined,
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
      const readPolicy = skillContext?.runtimePolicy?.vaultRead
      if (!readPolicy?.metadataDiscovery) {
        this.assertSkillReadPathAllowed(root.path, skillContext)
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
        path: root.path || '/',
        depth,
        ...(recent.recentMode ? { mode: 'recent', sortBy: 'modified', sinceDays: sinceDays || undefined } : {}),
        totalEntries: finalEntries.length,
        scannedEntries: entries.length,
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

    if (call.name === 'vault_inventory') {
      const readPolicy = skillContext?.runtimePolicy?.vaultRead
      if (readPolicy?.scope === 'current-note' || readPolicy?.scope === 'user-specified-files') {
        throw new Error('这套 Skill 只允许读取发送时锁定的指定材料，不能查看全库目录概览')
      }
      const rawRoot = toolText(call.arguments.root, 240)
      let root = rawRoot ? (normalizeVaultRelativePath(rawRoot) ?? '') : ''
      if (rawRoot && !root) throw new Error('目录概览的 root 路径不合法')
      if (root && this.protected(root)) throw new Error('该目录属于插件保护范围，不能读取')
      if (readPolicy?.scope === 'user-specified-folder') {
        const allowed = skillContext?.allowedReadFolders ?? []
        if (allowed.length === 0) throw new Error('这套 Skill 尚未锁定用户指定文件夹')
        if (!root && allowed.length === 1) root = allowed[0]
        if (!root || !allowed.some((folder) => isPathInsideFolder(root, folder))) {
          throw new Error(`目录概览只能查看已锁定文件夹：${allowed.join('、')}`)
        }
      }
      if (root) {
        let item = this.app.vault.getAbstractFileByPath(root)
        if (!(item instanceof TFolder)) {
          const matches = matchFoldersByName(this.app.vault.getRoot(), root)
          if (matches.length === 1) {
            item = matches[0]
            root = item.path
          }
        }
        if (!(item instanceof TFolder)) throw new Error(`没有找到文件夹：${root}`)
      }
      const depth = clampInt(call.arguments.depth, 4, 1, 8)
      const maxFolders = clampInt(call.arguments.maxFolders, 120, 10, 240)
      const recentLimit = clampInt(call.arguments.recentLimit, 16, 1, 40)
      return buildVaultInventory(
        this.app.vault.getFiles()
          .filter((file) => !this.protected(file.path))
          .map((file) => ({
            path: file.path,
            extension: file.extension,
            size: file.stat.size,
            mtime: file.stat.mtime,
          })),
        this.app.vault.getAllFolders()
          .filter((folder) => folder.path && !this.protected(folder.path))
          .map((folder) => ({ path: folder.path })),
        { root, depth, maxFolders, recentLimit },
      )
    }

    if (call.name === 'read_recent_documents') {
      const readScope = skillContext?.runtimePolicy?.vaultRead.scope
      if (readScope && readScope !== 'whole-vault') {
        throw new Error('只有 whole-vault Skill 才能调用全 Vault 的 read_recent_documents')
      }
      const sinceDays = clampInt(call.arguments.sinceDays, 7, 1, 31)
      const offset = clampInt(call.arguments.offset, 0, 0, LIST_FOLDER_SCAN_MAX_ENTRIES)
      const firstCharOffset = clampInt(call.arguments.charOffset, 0, 0, 8_000_000)
      const requestedSnapshotId = toolText(call.arguments.snapshotId, 120)
      const maxChars = clampInt(
        call.arguments.maxChars,
        RECENT_DOCUMENT_PAGE_MAX_CHARS,
        20_000,
        RECENT_DOCUMENT_PAGE_MAX_CHARS,
      )
      const cutoff = Date.now() - sinceDays * 86_400_000
      const skillRoot = normalizePath(this.localSkillsRoot())
      const outputRoot = normalizePath(this.outputRoot())
      const now = Date.now()
      for (const [id, snapshot] of this.recentDocumentSnapshots) {
        if (now - snapshot.createdAt > 10 * 60 * 1000) this.recentDocumentSnapshots.delete(id)
      }
      let snapshotId = requestedSnapshotId
      let snapshot = snapshotId ? this.recentDocumentSnapshots.get(snapshotId) : undefined
      if (!snapshot || snapshot.sinceDays !== sinceDays) {
        const files: WeeklyBusinessFileFingerprint[] = this.app.vault
          .getFiles()
          .filter((file) =>
            file.stat.mtime >= cutoff &&
            !this.protected(file.path) &&
            file.path !== skillRoot &&
            !file.path.startsWith(`${skillRoot}/`) &&
            file.path !== outputRoot &&
            !file.path.startsWith(`${outputRoot}/`),
          )
          .sort(
            (left, right) =>
              right.stat.mtime - left.stat.mtime ||
              left.path.localeCompare(right.path, 'zh-CN'),
          )
          .map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size }))
        const cache = this.weeklyDashboardCache()
        const cacheArtifact = cache?.artifactPath
          ? this.app.vault.getAbstractFileByPath(cache.artifactPath)
          : null
        const normalizedOutputRoot = normalizePath(this.outputRoot())
        const baselineAvailable = Boolean(
          cache &&
          cacheArtifact instanceof TFile &&
          cacheArtifact.extension.toLocaleLowerCase() === 'html' &&
          (cacheArtifact.path === normalizedOutputRoot ||
            cacheArtifact.path.startsWith(`${normalizedOutputRoot}/`)),
        )
        let selection = selectWeeklyBusinessRefresh(files, cache, {
          baselineAvailable,
          sinceDays,
          now,
        })
        if (selection.removedPaths.join('\n').length > 60_000) {
          selection = selectWeeklyBusinessRefresh(files, null, {
            baselineAvailable: false,
            sinceDays,
            now,
          })
        }
        let baselineContent: string | undefined
        let baselineArtifactPath: string | undefined
        if (selection.mode === 'incremental' && cache && cacheArtifact instanceof TFile) {
          try {
            const baseline = await this.search.readPathForRecentBatch(cache.artifactPath, {
              offset: 0,
              maxChars: WEEKLY_DASHBOARD_BASELINE_MAX_CHARS,
            })
            // 增量刷新必须有一份完整旧看板作真相基线。旧看板异常或正文过长时，
            // 自动退回全量，不拿半份旧报告拼接出伪完整结果。
            if (baseline.text.trim() && baseline.nextOffset === null) {
              baselineContent = baseline.text
              baselineArtifactPath = cache.artifactPath
            } else {
              selection = selectWeeklyBusinessRefresh(files, null, {
                baselineAvailable: false,
                sinceDays,
                now,
              })
            }
          } catch {
            selection = selectWeeklyBusinessRefresh(files, null, {
              baselineAvailable: false,
              sinceDays,
              now,
            })
          }
        }
        snapshotId = `recent-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        snapshot = {
          createdAt: now,
          sinceDays,
          paths: selection.readFiles.map((file) => file.path),
          scan: { sinceDays, capturedAt: now, files },
          mode: selection.mode,
          unchangedFiles: selection.unchangedFiles,
          removedPaths: selection.removedPaths,
          baselineArtifactPath,
          baselineContent,
        }
        this.latestWeeklyBusinessScanState = {
          ...snapshot.scan,
          files: snapshot.scan.files.map((file) => ({ ...file })),
        }
        this.recentDocumentSnapshots.set(snapshotId, snapshot)
        while (this.recentDocumentSnapshots.size > 8) {
          const oldest = this.recentDocumentSnapshots.keys().next().value
          if (!oldest) break
          this.recentDocumentSnapshots.delete(oldest)
        }
      }
      const paths = snapshot.paths
      const includeBaseline =
        snapshot.mode === 'incremental' && offset === 0 && firstCharOffset === 0

      const documents: Array<{
        path: string
        modified: string
        chars: number
        offset: number
        content: string
        nextOffset: number | null
      }> = []
      const skipped: Array<{ path: string; reason: string }> = []
      let usedChars = includeBaseline ? (snapshot.baselineContent?.length ?? 0) + 500 : 0
      let index = offset
      let charOffset = firstCharOffset
      let nextCharOffset = 0
      for (; index < paths.length; index++) {
        const path = paths[index]
        const file = this.app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile)) {
          skipped.push({ path, reason: '分页期间文件已移动或删除' })
          continue
        }
        if (!isLocalSearchExtension(file.extension)) {
          skipped.push({ path: file.path, reason: '本机暂不支持提取此文件类型的正文' })
          continue
        }
        try {
          if (this.remainingSkillReadFiles(skillContext) <= 0) {
            skipped.push({
              path: file.path,
              reason: `已达到 Skill 本轮最多 ${skillContext?.runtimePolicy?.vaultRead.maxFiles ?? 0} 份正文的读取上限`,
            })
            break
          }
          const remaining = Math.max(1, maxChars - usedChars - file.path.length - 180)
          if (documents.length > 0 && remaining < 1_000) break
          const result = await this.search.readPathForRecentBatch(
            file.path,
            {
              offset: index === offset ? charOffset : 0,
              maxChars: Math.min(RECENT_DOCUMENT_FILE_MAX_CHARS, remaining),
            },
          )
          const estimated = result.text.length + file.path.length + 120
          if (documents.length > 0 && usedChars + estimated > maxChars) break
          documents.push({
            path: file.path,
            modified: new Date(file.stat.mtime).toISOString(),
            chars: result.totalChars,
            offset: result.offset,
            content: result.text,
            nextOffset: result.nextOffset,
          })
          this.recordSkillVaultRead(file.path, skillContext)
          if (result.nextOffset !== null) {
            nextCharOffset = result.nextOffset
            usedChars += estimated
            sources.push({ sourceId: call.id, filename: file.name, path: file.path })
            break
          }
          usedChars += estimated
          charOffset = 0
          sources.push({ sourceId: call.id, filename: file.name, path: file.path })
        } catch (error) {
          skipped.push({
            path: file.path,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return {
        mode: snapshot.mode === 'incremental'
          ? 'recent-documents-incremental'
          : 'recent-documents-full',
        refreshMode: snapshot.mode,
        sinceDays,
        snapshotId,
        dateBasis: 'file-mtime',
        scopeWarning: '按文件修改时间统计；同步、git pull 或批量脚本改写可能影响本周口径。',
        excludedRoots: [skillRoot, outputRoot],
        refreshInstruction: snapshot.mode === 'incremental'
          ? '以上一次完整看板为基线，只合并本次新增/修改正文，并移除已删除或已移出七天窗口的来源；必须提交一份完整更新后的看板，不能只输出增量摘要。'
          : '这是首次或缓存失效后的全量扫描；必须以本轮全部正文生成完整看板。',
        ...(includeBaseline && snapshot.baselineContent && snapshot.baselineArtifactPath
          ? {
              baselineDashboard: {
                path: snapshot.baselineArtifactPath,
                content: snapshot.baselineContent,
              },
            }
          : {}),
        totalFiles: snapshot.scan.files.length,
        changedFiles: snapshot.mode === 'incremental' ? paths.length : snapshot.scan.files.length,
        unchangedFiles: snapshot.unchangedFiles,
        ...(snapshot.mode === 'incremental' && offset === 0 && firstCharOffset === 0
          ? { removedFiles: snapshot.removedPaths }
          : {}),
        returnedFiles: documents.length,
        offset,
        nextOffset: index < paths.length ? index : null,
        nextCharOffset: index < paths.length ? nextCharOffset : null,
        complete: index >= paths.length,
        documents,
        skipped,
      }
    }

    if (call.name === 'read_note') {
      const path = normalizeVaultRelativePath(call.arguments.path)
      if (!path) throw new Error('read_note 缺少合法 path')
      if (this.protected(path)) throw new Error('该文件属于插件保护范围，不能读取')
      this.assertSkillReadPathAllowed(path, skillContext)
      // 批量逐字稿/PDF 可能远超 12 万字；offset 只决定从本机哪里继续读，
      // 单次上传仍受 READ_NOTE_MAX_CHARS 限制，不会把整份长文一次提交给模型。
      const offset = clampInt(call.arguments.offset, 0, 0, 8_000_000)
      const maxChars = clampInt(call.arguments.maxChars, 12_000, 500, READ_NOTE_MAX_CHARS)
      const result = await this.search.readPath(path, { offset, maxChars })
      this.recordSkillVaultRead(path, skillContext)
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

    throw new Error('不支持的 Vault 工具')
  }

  async applyPlan(
    plan: VaultOrganizePlan,
    writeSnapshots: VaultWriteSnapshot[] = [],
  ): Promise<VaultActionRecord> {
    plan = this.resolvePlanPaths(plan)
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
          // FileManager 会遵从用户选择的系统废纸篓 / Obsidian 回收站设置。
          await this.app.fileManager.trashFile(current)
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
      if (noteWriteOps.length > VAULT_NOTE_WRITE_MAX_FILES) {
        throw new Error(`一次变更集最多写入 ${VAULT_NOTE_WRITE_MAX_FILES} 篇 Markdown，请分批处理`)
      }
      const seenWritePaths = new Set<string>()
      for (const operation of noteWriteOps) {
        if (fileExtension(operation.path) !== 'md') {
          throw new Error('跨文件写入只允许 Markdown 笔记，不能修改附件或其他文件类型')
        }
        if (seenWritePaths.has(operation.path)) {
          throw new Error(`同一变更集不能重复写入同一笔记：${operation.path}`)
        }
        seenWritePaths.add(operation.path)
        const existing = this.app.vault.getAbstractFileByPath(operation.path)
        if (operation.type === 'create_note') {
          if (existing) throw new Error(`目标笔记已存在，绝不覆盖：${operation.path}`)
        } else {
          if (!(existing instanceof TFile)) throw new Error(`没有找到要写入的笔记：${operation.path}`)
          const locked = writeSnapshots.find((item) => item.path === operation.path)
          if (!locked) throw new Error(`缺少目标笔记的锁定版本：${operation.path}`)
          if (existing.stat.mtime !== locked.mtime || existing.stat.size !== locked.size) {
            throw new Error(`目标笔记在确认前已经变化，已停止写入：${operation.path}`)
          }
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
      if (
        noteWriteOps.some(
          (write) => vaultPathsOverlap(write.path, operation.from) || vaultPathsOverlap(write.path, operation.to),
        )
      ) {
        throw new Error(`同一变更集不能同时写入笔记并移动它所在的路径：${operation.from} → ${operation.to}`)
      }
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
    const originalWriteContent = new Map<string, string>()
    const preparedWriteContent = new Map<string, string>()
    for (const operation of noteWriteOps) {
      if (operation.type !== 'create_note') {
        const file = this.app.vault.getAbstractFileByPath(operation.path)
        if (!(file instanceof TFile)) throw new Error(`没有找到要写入的笔记：${operation.path}`)
        originalWriteContent.set(operation.path, await this.app.vault.cachedRead(file))
      }
      preparedWriteContent.set(operation.path, await this.previewNoteWrite(operation))
    }
    try {
      for (const operation of createOps) await ensureFolder(operation.path)
      if (artifactOps.length === 1) {
        const operation = artifactOps[0]
        const path = this.validateArtifactOperation(operation)
        // DOCX/PDF/PPTX 渲染依赖体积较大，也可能访问只在完整浏览器窗口中
        // 提供的 API。仅在用户确认生成成品后加载，不能拖垮插件启动。
        const { renderArtifact } = await import('./artifact-renderer')
        // 先在内存中完整渲染；任何渲染错误都不会留下半成品文件。
        const rendered = await renderArtifact(operation, {
          vaultName: this.app.vault.getName?.() ?? '',
        })
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
      for (const operation of noteWriteOps) {
        const parent = operation.path.split('/').slice(0, -1).join('/')
        if (parent) await ensureFolder(parent)
        const next = preparedWriteContent.get(operation.path)
        if (next === undefined) throw new Error(`缺少待写入内容：${operation.path}`)
        if (operation.type === 'create_note') {
          await this.app.vault.create(normalizePath(operation.path), next)
          createdNotes.push(operation.path)
        } else {
          const file = this.app.vault.getAbstractFileByPath(operation.path)
          if (!(file instanceof TFile)) throw new Error(`执行前目标笔记已移动或删除：${operation.path}`)
          const locked = writeSnapshots.find((item) => item.path === operation.path)
          if (!locked || file.stat.mtime !== locked.mtime || file.stat.size !== locked.size) {
            throw new Error(`目标笔记在确认前已经变化，已停止写入：${operation.path}`)
          }
          await this.app.vault.process(file, () => next)
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
      const rollbackProblems: string[] = []
      for (const move of [...completedMoves].reverse()) {
        try {
          const current = this.app.vault.getAbstractFileByPath(move.to)
          if (current && !this.app.vault.getAbstractFileByPath(move.from)) {
            await this.app.fileManager.renameFile(current, normalizePath(move.from))
          }
        } catch {
          rollbackProblems.push(`${move.to} → ${move.from}`)
        }
      }
      for (const path of [...updatedNotes].reverse()) {
        try {
          const file = this.app.vault.getAbstractFileByPath(path)
          const original = originalWriteContent.get(path)
          const expected = preparedWriteContent.get(path)
          if (!(file instanceof TFile) || original === undefined || expected === undefined) {
            throw new Error('missing rollback source')
          }
          // 如果用户在本轮执行期间又编辑了笔记，宁可报告需要人工检查，
          // 也不能用回滚内容覆盖用户的新修改。
          if ((await this.app.vault.cachedRead(file)) !== expected) {
            throw new Error('rollback target changed by user')
          }
          await this.app.vault.process(file, () => original)
        } catch {
          rollbackProblems.push(path)
        }
      }
      for (const path of [...createdNotes].reverse()) {
        try {
          const file = this.app.vault.getAbstractFileByPath(path)
          const expected = preparedWriteContent.get(path)
          if (file instanceof TFile) {
            if (expected === undefined || (await this.app.vault.cachedRead(file)) !== expected) {
              throw new Error('rollback target changed by user')
            }
            await this.app.fileManager.trashFile(file)
          }
        } catch {
          rollbackProblems.push(path)
        }
      }
      for (const path of [...createdFolders].reverse()) {
        try {
          const folder = this.app.vault.getAbstractFileByPath(path)
          if (folder instanceof TFolder && folder.children.length === 0) {
            await this.app.fileManager.trashFile(folder)
          }
        } catch {
          rollbackProblems.push(path)
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        rollbackProblems.length > 0
          ? `${message}；自动回滚仍有 ${rollbackProblems.length} 项失败，请检查：${rollbackProblems.slice(0, 3).join('、')}`
          : `${message}；本轮变更已自动回滚`,
      )
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

import { App, TFile } from 'obsidian'
import {
  buildVaultLocalFact,
  isConsultationCountQuestion,
  isConsultationSummaryPath,
  isPathInsideFolder,
  isVaultSearchPathExcluded,
  searchVaultDocuments,
  shouldSearchVault,
  type VaultSearchDocument,
  type VaultLocalFact,
  type VaultSearchOptions,
  type VaultSearchResult,
} from './vault-search-core'
import {
  buildVaultIndexBloom,
  isVaultIndexRecordFresh,
  rankVaultContentIndexCandidates,
  rankVaultMetadataCandidates,
  summarizeVaultIndex,
  VAULT_INDEX_SCHEMA_VERSION,
  type VaultIndexFileMetadata,
  type VaultIndexRecord,
  type VaultIndexStatus,
} from './vault-index-core'
import {
  MemoryVaultIndexStore,
  openVaultIndexStore,
  type VaultIndexStore,
} from './vault-index-store'
import {
  decodePlainText,
  extractDocxText,
  extractHtmlText,
  extractPdfText,
  extractPptxText,
  extractXlsxText,
  isLocalSearchExtension,
  LOCAL_SEARCH_FILE_LIMITS,
} from './local-document-text'

const MAX_INDEX_CHARS_PER_NOTE = 120_000

interface CachedVaultDocument extends VaultSearchDocument {
  mtime: number
  size: number
  indexState: VaultIndexRecord['state']
}

export interface LocalVaultSearchResponse {
  results: VaultSearchResult[]
  indexStatus?: VaultIndexStatus
  fact?: {
    sourceId: string
    filename: string
    excerpt: string
  }
}

function responseFromLocalFact(
  fact: VaultLocalFact,
  maxSourcesValue: number | undefined,
): LocalVaultSearchResponse {
  const maxSources = Math.max(0, Math.min((maxSourcesValue ?? 6) - 1, 5))
  const results = fact.matchedDocuments.slice(0, maxSources).map((doc, index) => ({
    sourceId: `V${index + 2}`,
    path: doc.path,
    filename: doc.filename,
    excerpt:
      doc.text.trim().slice(0, 240) ||
      '本地文件名与路径符合咨询记录全量统计条件。',
    score: 1_000,
  }))
  return {
    results,
    fact: {
      sourceId: 'V1',
      filename: 'Vault 本地统计',
      excerpt: fact.text,
    },
  }
}

type VaultIndexStoreFactory = (namespace: string) => Promise<VaultIndexStore>

const TEXT_INDEX_EXTENSIONS = new Set(['md', 'txt', 'html', 'htm'])
const SEARCH_CANDIDATE_LIMIT = 72
const FOREGROUND_INDEX_LIMIT = 48

function metadataFromFile(file: TFile): VaultIndexFileMetadata {
  return {
    path: file.path,
    filename: file.name,
    extension: file.extension.toLocaleLowerCase(),
    mtime: file.stat.mtime,
    size: file.stat.size,
  }
}

function stableNamespace(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `vault-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`
}

/**
 * Vault 检索分成两层：Obsidian 自带的路径/mtime 元数据用于立即定位，本机
 * IndexedDB 只保存正文 Bloom 索引，不保存原文。命中后再从 Vault 读取少量候选，
 * 因而不会把整库正文写进 data.json，也不会把索引或目录上传到服务器。
 */
export class LocalVaultSearch {
  private cache = new Map<string, CachedVaultDocument>()
  private indexRecords = new Map<string, VaultIndexRecord>()
  private indexStore: VaultIndexStore = new MemoryVaultIndexStore()
  private indexInitialization?: Promise<void>
  private indexQueue: string[] = []
  private queuedPaths = new Set<string>()
  private backgroundTimer: number | undefined
  private backgroundRunning = false
  private indexActivated = false
  private disposed = false

  constructor(
    private readonly app: App,
    private readonly permanentlyExcludedFolders: () => string[] = () => [],
    private readonly storeFactory: VaultIndexStoreFactory = openVaultIndexStore,
  ) {}

  clear(): void {
    this.cache.clear()
    this.scheduleReconcile()
  }

  async initialize(): Promise<void> {
    if (this.indexInitialization) return this.indexInitialization
    this.indexInitialization = (async () => {
      const vault = this.app.vault as typeof this.app.vault & { getName?: () => string }
      const adapter = vault.adapter as
        | { getBasePath?: () => string; getName?: () => string }
        | undefined
      const identity =
        adapter?.getBasePath?.() ??
        adapter?.getName?.() ??
        vault.getName?.() ??
        'obsidian-vault'
      let records: VaultIndexRecord[] = []
      try {
        this.indexStore = await this.storeFactory(stableNamespace(identity))
        records = await this.indexStore.list()
      } catch {
        this.indexStore.close()
        this.indexStore = new MemoryVaultIndexStore()
      }
      this.indexRecords = new Map(records.map((record) => [record.path, record]))
      // 新用户只加载元数据，不读 Vault 正文。只有真正使用过文件检索的 Vault
      // 才会在重启后继续自动增量维护已有本地索引。
      this.indexActivated = records.length > 0
      await this.reconcileIndex(this.indexActivated)
    })()
    return this.indexInitialization
  }

  dispose(): void {
    this.disposed = true
    if (this.backgroundTimer !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(this.backgroundTimer)
    }
    this.backgroundTimer = undefined
    this.indexStore.close()
    this.cache.clear()
    this.indexQueue = []
    this.queuedPaths.clear()
  }

  indexStatus(): VaultIndexStatus {
    const files = this.eligibleFiles().map(metadataFromFile)
    return summarizeVaultIndex(files, this.indexRecords, this.backgroundRunning, this.indexActivated)
  }

  async handleCreate(file: TFile): Promise<void> {
    await this.initialize()
    if (!this.isEligibleFile(file)) return
    if (this.indexActivated) this.enqueue(file.path, true)
  }

  async handleModify(file: TFile): Promise<void> {
    await this.initialize()
    this.cache.delete(file.path)
    if (!this.isEligibleFile(file)) {
      await this.removeIndexPath(file.path)
      return
    }
    await this.removeIndexPath(file.path)
    if (this.indexActivated) this.enqueue(file.path, true)
  }

  async handleDelete(path: string): Promise<void> {
    await this.initialize()
    this.cache.delete(path)
    const affected = [...this.indexRecords.keys()].filter(
      (candidate) => candidate === path || candidate.startsWith(`${path}/`),
    )
    await Promise.all(affected.map((candidate) => this.removeIndexPath(candidate)))
  }

  async handleRename(file: TFile, oldPath: string): Promise<void> {
    await this.handleDelete(oldPath)
    if (this.indexActivated && this.isEligibleFile(file)) this.enqueue(file.path, true)
  }

  private isEligibleFile(file: TFile, extraExcludedFolders: string[] = []): boolean {
    const excludedFolders = [
      ...this.permanentlyExcludedFolders(),
      ...extraExcludedFolders,
    ].map((folder) => folder.trim()).filter(Boolean)
    return Boolean(
      isLocalSearchExtension(file.extension) &&
      !isVaultSearchPathExcluded(file.path) &&
      !excludedFolders.some((folder) => isPathInsideFolder(file.path, folder)),
    )
  }

  private eligibleFiles(extraExcludedFolders: string[] = []): TFile[] {
    return this.app.vault.getFiles().filter((file) => this.isEligibleFile(file, extraExcludedFolders))
  }

  private async removeIndexPath(path: string): Promise<void> {
    this.indexRecords.delete(path)
    this.queuedPaths.delete(path)
    this.indexQueue = this.indexQueue.filter((candidate) => candidate !== path)
    try {
      await this.indexStore.delete(path)
    } catch {
      // 持久化层失败不影响本轮本机搜索；下次启动会按 mtime 重新校准。
    }
  }

  private enqueue(path: string, urgent = false): void {
    if (this.disposed || this.queuedPaths.has(path)) return
    this.queuedPaths.add(path)
    if (urgent) this.indexQueue.unshift(path)
    else this.indexQueue.push(path)
    this.scheduleBackground(urgent ? 80 : 350)
  }

  private scheduleBackground(delayMs = 350): void {
    if (this.disposed || this.backgroundTimer !== undefined || typeof window === 'undefined') return
    this.backgroundTimer = window.setTimeout(() => {
      this.backgroundTimer = undefined
      void this.runBackgroundBatch()
    }, delayMs)
  }

  private scheduleReconcile(): void {
    if (this.disposed) return
    void this.initialize().then(() => this.reconcileIndex(this.indexActivated)).catch(() => undefined)
  }

  private async reconcileIndex(enqueueMissing: boolean): Promise<void> {
    if (this.disposed) return
    const files = this.eligibleFiles()
    const live = new Map(files.map((file) => [file.path, metadataFromFile(file)]))
    const stalePaths = [...this.indexRecords.keys()].filter((path) => {
      const file = live.get(path)
      return !file || !isVaultIndexRecordFresh(this.indexRecords.get(path), file)
    })
    for (const path of stalePaths) await this.removeIndexPath(path)
    const pending = files
      .filter((file) => !isVaultIndexRecordFresh(this.indexRecords.get(file.path), metadataFromFile(file)))
      .sort((left, right) => {
        const leftText = TEXT_INDEX_EXTENSIONS.has(left.extension.toLocaleLowerCase()) ? 0 : 1
        const rightText = TEXT_INDEX_EXTENSIONS.has(right.extension.toLocaleLowerCase()) ? 0 : 1
        return leftText - rightText || right.stat.mtime - left.stat.mtime || left.path.localeCompare(right.path)
      })
    if (enqueueMissing) {
      for (const file of pending) this.enqueue(file.path)
    }
  }

  private async activateIndex(): Promise<void> {
    await this.initialize()
    if (this.indexActivated) return
    this.indexActivated = true
    await this.reconcileIndex(true)
  }

  private async runBackgroundBatch(): Promise<void> {
    if (this.disposed || this.backgroundRunning || this.indexQueue.length === 0) return
    this.backgroundRunning = true
    try {
      const firstPath = this.indexQueue[0]
      const first = this.app.vault.getAbstractFileByPath(firstPath)
      const textBatch = first instanceof TFile && TEXT_INDEX_EXTENSIONS.has(first.extension.toLocaleLowerCase())
      const limit = textBatch ? 6 : 1
      for (let index = 0; index < limit && this.indexQueue.length > 0; index++) {
        const path = this.indexQueue.shift()
        if (!path) break
        this.queuedPaths.delete(path)
        const file = this.app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile) || !this.isEligibleFile(file)) {
          await this.removeIndexPath(path)
          continue
        }
        await this.indexFile(file, false)
      }
    } finally {
      this.backgroundRunning = false
      if (this.indexQueue.length > 0) {
        const next = this.app.vault.getAbstractFileByPath(this.indexQueue[0])
        const delay = next instanceof TFile && TEXT_INDEX_EXTENSIONS.has(next.extension.toLocaleLowerCase())
          ? 350
          : 1_200
        this.scheduleBackground(delay)
      }
    }
  }

  private async indexFile(file: TFile, retainDocument: boolean): Promise<VaultIndexRecord> {
    const metadata = metadataFromFile(file)
    const fresh = this.indexRecords.get(file.path)
    if (isVaultIndexRecordFresh(fresh, metadata) && fresh) return fresh
    const document = await this.readDocument(file)
    const cached = this.cache.get(file.path)
    const record: VaultIndexRecord = {
      ...metadata,
      schemaVersion: VAULT_INDEX_SCHEMA_VERSION,
      indexedAt: Date.now(),
      state: cached?.indexState ?? (document?.text.trim() ? 'ready' : 'empty'),
      bloom: buildVaultIndexBloom(document?.text ?? ''),
    }
    this.indexRecords.set(file.path, record)
    try {
      await this.indexStore.put(record)
    } catch {
      // 配额不足时退化为本进程索引；文件读取与结果仍保持本地。
    }
    if (!retainDocument) this.cache.delete(file.path)
    return record
  }

  async search(
    query: string,
    options: VaultSearchOptions = {},
  ): Promise<LocalVaultSearchResponse> {
    return this.searchInternal(query, options, false)
  }

  /** Agent 显式调用搜索时不走“寒暄/超短输入”短路；其余范围与缓存边界完全相同。 */
  async searchForAgent(
    query: string,
    options: VaultSearchOptions = {},
  ): Promise<LocalVaultSearchResponse> {
    return this.searchInternal(query, options, true)
  }

  private async searchInternal(
    query: string,
    options: VaultSearchOptions,
    explicit: boolean,
  ): Promise<LocalVaultSearchResponse> {
    // 寒暄不触发索引。第一次真正的文件检索才在本机激活索引；
    // 之后由 Vault 文件事件低速增量维护，普通对话不会触发整库正文扫描。
    if (!explicit && !shouldSearchVault(query)) return { results: [] }
    await this.activateIndex()
    const excludedFolders = (options.excludedFolders ?? []).filter(Boolean)
    const includedFolders = (options.includedFolders ?? []).filter(Boolean)
    const files = this.eligibleFiles(excludedFolders).filter(
      (file) =>
        includedFolders.length === 0 ||
        includedFolders.some((folder) => isPathInsideFolder(file.path, folder)),
    )
    const livePaths = new Set(files.map((file) => file.path))
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) this.cache.delete(path)
    }
    const metadata = files.map(metadataFromFile)
    const status = () => summarizeVaultIndex(
      metadata,
      this.indexRecords,
      this.backgroundRunning,
      this.indexActivated,
    )
    // 咨询场次是确定性统计：先只读可能的汇总真相源；没有可解析汇总时，
    // 仅按全部文件的路径/文件名去重。大 Vault 不必为一个数字解析所有 PDF/DOCX 正文。
    if (isConsultationCountQuestion(query, options.nowMs)) {
      const summaryFiles = files.filter((file) =>
        isConsultationSummaryPath(`${file.path} ${file.name}`),
      )
      const summaryDocuments = (
        await Promise.all(summaryFiles.map((file) => this.readDocument(file)))
      ).filter((doc): doc is VaultSearchDocument => Boolean(doc))
      const summaryFact = buildVaultLocalFact(query, summaryDocuments, [], options.nowMs)
      if (summaryFact?.text.startsWith('Vault 本地权威汇总')) {
        return { ...responseFromLocalFact(summaryFact, options.maxSources), indexStatus: status() }
      }
      const metadataDocuments = files.map((file) => ({
        path: file.path,
        filename: file.name,
        text: '',
        mtime: file.stat.mtime,
      }))
      const inventoryFact = buildVaultLocalFact(query, metadataDocuments, [], options.nowMs)
      if (inventoryFact) {
        return { ...responseFromLocalFact(inventoryFact, options.maxSources), indexStatus: status() }
      }
    }

    // 先用路径/文件名与持久化 Bloom 索引缩小候选；只有候选原文会被读取。
    // 这一步对模糊文件名、日期和文件夹范围立即可用，不必等待全文索引完成。
    const ranked = new Map<string, number>()
    const mergeCandidates = (candidates: ReturnType<typeof rankVaultMetadataCandidates>) => {
      for (const candidate of candidates) {
        ranked.set(candidate.path, Math.max(ranked.get(candidate.path) ?? 0, candidate.score))
      }
    }
    mergeCandidates(rankVaultMetadataCandidates(query, metadata, options, 48))
    mergeCandidates(
      rankVaultContentIndexCandidates(query, metadata, this.indexRecords, options, 64),
    )

    // 新 Vault 第一次搜索时，不因后台索引尚未走完就直接说“没有”。前台最多补建
    // 一小批文字文件；剩余文件继续后台增量建立，工具结果会如实带出 pending 数。
    if (ranked.size === 0) {
      const foreground = files
        .filter((file) => !isVaultIndexRecordFresh(this.indexRecords.get(file.path), metadataFromFile(file)))
        .sort((left, right) => {
          const leftText = TEXT_INDEX_EXTENSIONS.has(left.extension.toLocaleLowerCase()) ? 0 : 1
          const rightText = TEXT_INDEX_EXTENSIONS.has(right.extension.toLocaleLowerCase()) ? 0 : 1
          return leftText - rightText || right.stat.mtime - left.stat.mtime
        })
        .slice(0, FOREGROUND_INDEX_LIMIT)
      for (const file of foreground) await this.indexFile(file, false)
      mergeCandidates(
        rankVaultContentIndexCandidates(query, metadata, this.indexRecords, options, 64),
      )
    }

    const byPath = new Map(files.map((file) => [file.path, file]))
    const candidateFiles = [...ranked.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
      .slice(0, SEARCH_CANDIDATE_LIMIT)
      .map(([path]) => byPath.get(path))
      .filter((file): file is TFile => Boolean(file))
    const documents: (VaultSearchDocument | null)[] = []
    const textFiles = candidateFiles.filter((file) =>
      TEXT_INDEX_EXTENSIONS.has(file.extension.toLocaleLowerCase()),
    )
    const binaryFiles = candidateFiles.filter((file) =>
      !TEXT_INDEX_EXTENSIONS.has(file.extension.toLocaleLowerCase()),
    )
    for (let offset = 0; offset < textFiles.length; offset += 12) {
      const batch = textFiles.slice(offset, offset + 12)
      const read = await Promise.all(batch.map((file) => this.readDocument(file)))
      documents.push(...read)
      await Promise.all(batch.map((file) => this.indexFile(file, true)))
    }
    for (let offset = 0; offset < binaryFiles.length; offset += 2) {
      const batch = binaryFiles.slice(offset, offset + 2)
      const read = await Promise.all(batch.map((file) => this.readDocument(file)))
      documents.push(...read)
      await Promise.all(batch.map((file) => this.indexFile(file, true)))
    }
    const availableDocuments = documents.filter(
      (doc): doc is VaultSearchDocument => Boolean(doc),
    )
    const fact = buildVaultLocalFact(query, availableDocuments, [], options.nowMs)
    if (fact) {
      return { ...responseFromLocalFact(fact, options.maxSources), indexStatus: status() }
    }
    return {
      results: searchVaultDocuments(query, availableDocuments, { ...options, explicit }),
      indexStatus: status(),
    }
  }

  /** 按精确相对路径读取一段本地文档；只返回本次工具调用需要的窗口。 */
  async readPath(
    path: string,
    options: { offset?: number; maxChars?: number } = {},
  ): Promise<{
    path: string
    filename: string
    text: string
    offset: number
    nextOffset: number | null
    totalChars: number
  }> {
    await this.activateIndex()
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile) || !isLocalSearchExtension(file.extension)) {
      throw new Error(`没有找到可读取的 MD/TXT/PDF/DOCX/HTML/PPTX/XLSX 文件：${path}`)
    }
    const document = await this.readDocument(file)
    if (!document) throw new Error(`文件暂时无法读取：${path}`)
    await this.indexFile(file, true)
    const offset = Math.max(0, Math.min(Math.trunc(options.offset ?? 0), document.text.length))
    const maxChars = Math.max(1, Math.min(Math.trunc(options.maxChars ?? 12_000), 16_000))
    const text = document.text.slice(offset, offset + maxChars)
    const nextOffset = offset + text.length < document.text.length ? offset + text.length : null
    return {
      path,
      filename: file.name,
      text,
      offset,
      nextOffset,
      totalChars: document.text.length,
    }
  }

  /**
   * 官方经营周报 Skill 的分页批读窗口。与 readPath 的 16,000 字交互窗口分开，
   * 避免普通对话静默扩大；单篇仍受本地索引 120,000 字硬上限保护。
   */
  async readPathForRecentBatch(
    path: string,
    options: { offset?: number; maxChars?: number } = {},
  ): Promise<{
    path: string
    filename: string
    text: string
    offset: number
    totalChars: number
    nextOffset: number | null
  }> {
    await this.activateIndex()
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile) || !isLocalSearchExtension(file.extension)) {
      throw new Error(`没有找到可读取的 MD/TXT/PDF/DOCX/HTML/PPTX/XLSX 文件：${path}`)
    }
    const document = await this.readDocument(file)
    if (!document) throw new Error(`文件暂时无法读取：${path}`)
    await this.indexFile(file, true)
    const offset = Math.max(0, Math.min(Math.trunc(options.offset ?? 0), document.text.length))
    const limit = Math.max(1, Math.min(Math.trunc(options.maxChars ?? 80_000), 80_000))
    const text = document.text.slice(offset, offset + limit)
    return {
      path,
      filename: file.name,
      text,
      offset,
      totalChars: document.text.length,
      nextOffset: offset + text.length < document.text.length ? offset + text.length : null,
    }
  }

  private async readDocument(file: TFile): Promise<VaultSearchDocument | null> {
    const cached = this.cache.get(file.path)
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached
    }
    try {
      const extension = file.extension.toLocaleLowerCase()
      const maxFileBytes = LOCAL_SEARCH_FILE_LIMITS[extension] ?? 0
      let text = ''
      let indexState: CachedVaultDocument['indexState'] = 'empty'
      if (maxFileBytes > 0 && file.stat.size <= maxFileBytes) {
        if (extension === 'md') {
          text = (await this.app.vault.cachedRead(file)).slice(0, MAX_INDEX_CHARS_PER_NOTE)
        } else {
          const data = new Uint8Array(await this.app.vault.readBinary(file))
          if (extension === 'txt') {
            text = decodePlainText(data, MAX_INDEX_CHARS_PER_NOTE)
          } else if (extension === 'pdf') {
            text = await extractPdfText(data, MAX_INDEX_CHARS_PER_NOTE)
          } else if (extension === 'docx') {
            text = extractDocxText(data, MAX_INDEX_CHARS_PER_NOTE)
          } else if (extension === 'html' || extension === 'htm') {
            text = extractHtmlText(data, MAX_INDEX_CHARS_PER_NOTE)
          } else if (extension === 'pptx') {
            text = extractPptxText(data, MAX_INDEX_CHARS_PER_NOTE)
          } else if (extension === 'xlsx') {
            text = extractXlsxText(data, MAX_INDEX_CHARS_PER_NOTE)
          }
        }
        if (text.trim()) indexState = 'ready'
      } else {
        indexState = 'skipped'
      }
      const next: CachedVaultDocument = {
        path: file.path,
        filename: file.name,
        text,
        mtime: file.stat.mtime,
        size: file.stat.size,
        indexState,
      }
      this.cache.set(file.path, next)
      return next
    } catch {
      // 加密、损坏或暂不兼容的文件记录为失败；文件内容/时间变化后会自动重试。
      const empty: CachedVaultDocument = {
        path: file.path,
        filename: file.name,
        text: '',
        mtime: file.stat.mtime,
        size: file.stat.size,
        indexState: 'failed',
      }
      this.cache.set(file.path, empty)
      return empty
    }
  }
}

import { App, TFile } from 'obsidian'
import {
  buildVaultLocalFact,
  isPathInsideFolder,
  isVaultSearchPathExcluded,
  searchVaultDocuments,
  shouldSearchVault,
  type VaultSearchDocument,
  type VaultSearchOptions,
  type VaultSearchResult,
} from './vault-search-core'
import {
  decodePlainText,
  extractDocxText,
  extractPdfText,
  isLocalSearchExtension,
  LOCAL_SEARCH_FILE_LIMITS,
} from './local-document-text'

const MAX_INDEX_CHARS_PER_NOTE = 120_000

interface CachedVaultDocument extends VaultSearchDocument {
  mtime: number
  size: number
}

export interface LocalVaultSearchResponse {
  results: VaultSearchResult[]
  fact?: {
    sourceId: string
    filename: string
    excerpt: string
  }
}

/**
 * 只存在于当前 Obsidian 进程内的 Vault 文本缓存。
 *
 * 不写入插件 data.json，不上传云端；每次查询只把最终命中的少量片段交给主对话。
 */
export class LocalVaultSearch {
  private cache = new Map<string, CachedVaultDocument>()

  constructor(private readonly app: App) {}

  clear(): void {
    this.cache.clear()
  }

  async search(
    query: string,
    options: VaultSearchOptions = {},
  ): Promise<LocalVaultSearchResponse> {
    // 短路:寒暄/超短输入不该触发全 Vault 扫描(大库的 PDF/DOCX 解析成本高,
    // 新用户第一句「你好」尤其不能卡)。统计类问题词长足够,不会被误伤;
    // searchVaultDocuments 内部同一判断保留作为纯函数的自我保护。
    if (!shouldSearchVault(query)) return { results: [] }
    const excludedFolders = (options.excludedFolders ?? []).filter(Boolean)
    const files = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          isLocalSearchExtension(file.extension) &&
          !isVaultSearchPathExcluded(file.path) &&
          !excludedFolders.some((folder) => isPathInsideFolder(file.path, folder)),
      )
    const livePaths = new Set(files.map((file) => file.path))
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) this.cache.delete(path)
    }
    // 大型 Vault 可能有数千篇笔记。文本文件批量读取，PDF/DOCX 只开两个并发，
    // 避免大量二进制解析同时抢占 Obsidian 的 CPU 和内存。
    const documents: (VaultSearchDocument | null)[] = []
    const textFiles = files.filter((file) => file.extension === 'md' || file.extension === 'txt')
    const binaryFiles = files.filter((file) => file.extension === 'pdf' || file.extension === 'docx')
    for (let offset = 0; offset < textFiles.length; offset += 24) {
      const batch = textFiles.slice(offset, offset + 24)
      documents.push(...(await Promise.all(batch.map((file) => this.readDocument(file)))))
    }
    for (let offset = 0; offset < binaryFiles.length; offset += 2) {
      const batch = binaryFiles.slice(offset, offset + 2)
      documents.push(...(await Promise.all(batch.map((file) => this.readDocument(file)))))
    }
    const availableDocuments = documents.filter(
      (doc): doc is VaultSearchDocument => Boolean(doc),
    )
    // 聚合统计必须覆盖整个 Vault，不能因为当前笔记已另行附带就漏算这一场。
    // 普通片段搜索仍由 searchVaultDocuments 使用 excludedPaths 去重。
    const fact = buildVaultLocalFact(query, availableDocuments)
    if (fact) {
      const maxSources = Math.max(0, Math.min((options.maxSources ?? 6) - 1, 5))
      const results = fact.matchedDocuments.slice(0, maxSources).map((doc, index) => ({
        sourceId: `V${index + 2}`,
        path: doc.path,
        filename: doc.filename,
        excerpt:
          doc.text.trim().slice(0, 240) ||
          '本地文件名与路径符合年月和咨询逐字稿统计条件。',
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
    return { results: searchVaultDocuments(query, availableDocuments, options) }
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
          }
        }
      }
      const next: CachedVaultDocument = {
        path: file.path,
        filename: file.name,
        text,
        mtime: file.stat.mtime,
        size: file.stat.size,
      }
      this.cache.set(file.path, next)
      return next
    } catch {
      // 加密、损坏、扫描版或暂不兼容的文件缓存为空；文件内容/时间变化后会自动重试。
      const empty: CachedVaultDocument = {
        path: file.path,
        filename: file.name,
        text: '',
        mtime: file.stat.mtime,
        size: file.stat.size,
      }
      this.cache.set(file.path, empty)
      return empty
    }
  }
}

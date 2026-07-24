import { App, TFile } from 'obsidian'
import {
  isVaultSearchPathExcluded,
  searchVaultDocuments,
  type VaultSearchDocument,
  type VaultSearchOptions,
  type VaultSearchResult,
} from './vault-search-core'

const MAX_INDEX_CHARS_PER_NOTE = 120_000

interface CachedVaultDocument extends VaultSearchDocument {
  mtime: number
  size: number
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
  ): Promise<VaultSearchResult[]> {
    const excludedPathSet = new Set(options.excludedPaths ?? [])
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          !excludedPathSet.has(file.path) &&
          !isVaultSearchPathExcluded(file.path, options.excludedFolders),
      )
    const livePaths = new Set(files.map((file) => file.path))
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) this.cache.delete(path)
    }
    // 大型 Vault 可能有数千篇笔记。分批读取，避免一次创建数千个文件 Promise
    // 抢占 Obsidian 的 I/O；命中过的正文仍会留在本轮进程内存缓存中供后续复用。
    const documents: (VaultSearchDocument | null)[] = []
    for (let offset = 0; offset < files.length; offset += 24) {
      const batch = files.slice(offset, offset + 24)
      documents.push(...(await Promise.all(batch.map((file) => this.readDocument(file)))))
    }
    return searchVaultDocuments(
      query,
      documents.filter((doc): doc is VaultSearchDocument => Boolean(doc)),
      options,
    )
  }

  private async readDocument(file: TFile): Promise<VaultSearchDocument | null> {
    const cached = this.cache.get(file.path)
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached
    }
    try {
      const text = (await this.app.vault.cachedRead(file)).slice(0, MAX_INDEX_CHARS_PER_NOTE)
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
      return null
    }
  }
}

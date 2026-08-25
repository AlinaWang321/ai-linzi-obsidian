import type { App } from 'obsidian'
import {
  WEEKLY_BUSINESS_INDEX_VERSION,
  type WeeklyBusinessSummaryRecord,
  type WeeklyBusinessSummarySegment,
} from './weekly-business-index-core'

const DATABASE_NAME = 'ai-linzi-weekly-business-index'
const DATABASE_VERSION = 1
const STORE_NAME = 'summaries'
const VAULT_INDEX_NAME = 'vault'

interface StoredWeeklyBusinessSummaryRecord extends WeeklyBusinessSummaryRecord {
  key: string
  vault: string
}

export interface WeeklyBusinessIndexStore {
  kind: 'indexeddb' | 'memory'
  list(): Promise<WeeklyBusinessSummaryRecord[]>
  put(record: WeeklyBusinessSummaryRecord): Promise<void>
  delete(path: string): Promise<void>
  close(): void
}

function cloneSegment(segment: WeeklyBusinessSummarySegment): WeeklyBusinessSummarySegment {
  return { ...segment }
}

function cloneRecord(record: WeeklyBusinessSummaryRecord): WeeklyBusinessSummaryRecord {
  return { ...record, segments: record.segments.map(cloneSegment) }
}

function validRecord(value: unknown): value is WeeklyBusinessSummaryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<WeeklyBusinessSummaryRecord>
  return record.version === WEEKLY_BUSINESS_INDEX_VERSION &&
    typeof record.path === 'string' && Boolean(record.path) &&
    typeof record.mtime === 'number' && Number.isFinite(record.mtime) && record.mtime >= 0 &&
    typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0 &&
    typeof record.totalChars === 'number' && Number.isFinite(record.totalChars) && record.totalChars >= 0 &&
    (record.status === 'ready' || record.status === 'skipped') &&
    Array.isArray(record.segments) && record.segments.every((segment) =>
      segment && typeof segment === 'object' &&
      Number.isInteger(segment.index) && segment.index >= 0 &&
      Number.isInteger(segment.offset) && segment.offset >= 0 &&
      (segment.nextOffset === null || (Number.isInteger(segment.nextOffset) && segment.nextOffset >= 0)) &&
      typeof segment.summary === 'string' && Boolean(segment.summary.trim()),
    ) &&
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
}

export class MemoryWeeklyBusinessIndexStore implements WeeklyBusinessIndexStore {
  readonly kind = 'memory' as const
  private readonly records = new Map<string, WeeklyBusinessSummaryRecord>()

  async list(): Promise<WeeklyBusinessSummaryRecord[]> {
    return [...this.records.values()].map(cloneRecord)
  }

  async put(record: WeeklyBusinessSummaryRecord): Promise<void> {
    this.records.set(record.path, cloneRecord(record))
  }

  async delete(path: string): Promise<void> {
    this.records.delete(path)
  }

  close(): void {}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已取消'))
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      if (store && !store.indexNames.contains(VAULT_INDEX_NAME)) {
        store.createIndex(VAULT_INDEX_NAME, 'vault', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开经营看板本机索引'))
    request.onblocked = () => reject(new Error('经营看板本机索引升级被其他窗口阻塞'))
  })
}

class IndexedDbWeeklyBusinessIndexStore implements WeeklyBusinessIndexStore {
  readonly kind = 'indexeddb' as const

  constructor(
    private readonly db: IDBDatabase,
    private readonly namespace: string,
  ) {}

  private key(path: string): string {
    return `${this.namespace}\n${path}`
  }

  async list(): Promise<WeeklyBusinessSummaryRecord[]> {
    const transaction = this.db.transaction(STORE_NAME, 'readonly')
    const done = transactionDone(transaction)
    const values = await requestResult(
      transaction.objectStore(STORE_NAME).index(VAULT_INDEX_NAME).getAll(this.namespace),
    ) as StoredWeeklyBusinessSummaryRecord[]
    await done
    return values.filter(validRecord).map(({ key: _key, vault: _vault, ...record }) => cloneRecord(record))
  }

  async put(record: WeeklyBusinessSummaryRecord): Promise<void> {
    const transaction = this.db.transaction(STORE_NAME, 'readwrite')
    const stored: StoredWeeklyBusinessSummaryRecord = {
      ...cloneRecord(record),
      key: this.key(record.path),
      vault: this.namespace,
    }
    transaction.objectStore(STORE_NAME).put(stored)
    await transactionDone(transaction)
  }

  async delete(path: string): Promise<void> {
    const transaction = this.db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(this.key(path))
    await transactionDone(transaction)
  }

  close(): void {
    this.db.close()
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

export async function openWeeklyBusinessIndexStore(
  app: App,
  factory: IDBFactory | undefined =
    typeof window === 'undefined' ? undefined : window.activeWindow.indexedDB,
): Promise<WeeklyBusinessIndexStore> {
  if (!factory) return new MemoryWeeklyBusinessIndexStore()
  const vault = app.vault as typeof app.vault & { getName?: () => string }
  const adapter = vault.adapter as { getBasePath?: () => string; getName?: () => string } | undefined
  const identity = adapter?.getBasePath?.() ?? adapter?.getName?.() ?? vault.getName?.() ?? 'obsidian-vault'
  try {
    return new IndexedDbWeeklyBusinessIndexStore(
      await openDatabase(factory),
      stableNamespace(identity),
    )
  } catch {
    // 隐私模式、存储配额或数据库损坏不能让经营看板完全不可用；内存兜底仍可跑完本轮。
    return new MemoryWeeklyBusinessIndexStore()
  }
}

export class WeeklyBusinessIndex {
  private store: WeeklyBusinessIndexStore = new MemoryWeeklyBusinessIndexStore()
  private initialization?: Promise<void>

  constructor(private readonly app: App) {}

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const next = await openWeeklyBusinessIndexStore(this.app)
        this.store.close()
        this.store = next
      })()
    }
    await this.initialization
  }

  async list(): Promise<WeeklyBusinessSummaryRecord[]> {
    await this.initialize()
    return this.store.list()
  }

  async put(record: WeeklyBusinessSummaryRecord): Promise<void> {
    await this.initialize()
    await this.store.put(record)
  }

  async delete(path: string): Promise<void> {
    await this.initialize()
    await this.store.delete(path)
  }

  kind(): WeeklyBusinessIndexStore['kind'] {
    return this.store.kind
  }

  dispose(): void {
    this.store.close()
  }
}

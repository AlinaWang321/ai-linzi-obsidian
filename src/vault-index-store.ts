import type { VaultIndexRecord } from './vault-index-core'

const DATABASE_NAME = 'ai-linzi-vault-search-index'
const DATABASE_VERSION = 1
const STORE_NAME = 'documents'
const VAULT_INDEX_NAME = 'vault'

interface StoredVaultIndexRecord extends VaultIndexRecord {
  key: string
  vault: string
}

export interface VaultIndexStore {
  kind: 'indexeddb' | 'memory'
  list(): Promise<VaultIndexRecord[]>
  put(record: VaultIndexRecord): Promise<void>
  delete(path: string): Promise<void>
  clear(): Promise<void>
  close(): void
}

function cloneRecord(record: VaultIndexRecord): VaultIndexRecord {
  return { ...record, bloom: record.bloom.slice(0) }
}

export class MemoryVaultIndexStore implements VaultIndexStore {
  readonly kind = 'memory' as const
  private readonly records = new Map<string, VaultIndexRecord>()

  async list(): Promise<VaultIndexRecord[]> {
    return [...this.records.values()].map(cloneRecord)
  }

  async put(record: VaultIndexRecord): Promise<void> {
    this.records.set(record.path, cloneRecord(record))
  }

  async delete(path: string): Promise<void> {
    this.records.delete(path)
  }

  async clear(): Promise<void> {
    this.records.clear()
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
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB 升级被其他窗口阻塞'))
  })
}

class IndexedDbVaultIndexStore implements VaultIndexStore {
  readonly kind = 'indexeddb' as const

  constructor(
    private readonly db: IDBDatabase,
    private readonly namespace: string,
  ) {}

  private key(path: string): string {
    return `${this.namespace}\n${path}`
  }

  async list(): Promise<VaultIndexRecord[]> {
    const transaction = this.db.transaction(STORE_NAME, 'readonly')
    const done = transactionDone(transaction)
    const values = await requestResult(
      transaction.objectStore(STORE_NAME).index(VAULT_INDEX_NAME).getAll(this.namespace),
    ) as StoredVaultIndexRecord[]
    await done
    return values.map(({ key: _key, vault: _vault, ...record }) => cloneRecord(record))
  }

  async put(record: VaultIndexRecord): Promise<void> {
    const transaction = this.db.transaction(STORE_NAME, 'readwrite')
    const stored: StoredVaultIndexRecord = {
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

  async clear(): Promise<void> {
    const transaction = this.db.transaction(STORE_NAME, 'readwrite')
    const done = transactionDone(transaction)
    const index = transaction.objectStore(STORE_NAME).index(VAULT_INDEX_NAME)
    await new Promise<void>((resolve, reject) => {
      const request = index.openKeyCursor(IDBKeyRange.only(this.namespace))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        transaction.objectStore(STORE_NAME).delete(cursor.primaryKey)
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error('无法清理本地索引'))
    })
    await done
  }

  close(): void {
    this.db.close()
  }
}

export async function openVaultIndexStore(
  namespace: string,
  factory: IDBFactory | undefined =
    typeof window === 'undefined' ? undefined : window.activeWindow.indexedDB,
): Promise<VaultIndexStore> {
  if (!factory || !namespace) return new MemoryVaultIndexStore()
  try {
    return new IndexedDbVaultIndexStore(await openDatabase(factory), namespace)
  } catch {
    // 隐私模式、存储配额或数据库损坏都不能让 Vault 搜索不可用。
    return new MemoryVaultIndexStore()
  }
}

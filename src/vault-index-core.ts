import {
  buildVaultSearchTerms,
  isPathInsideFolder,
  isVaultSearchPathExcluded,
  type VaultSearchOptions,
} from './vault-search-core'

export const VAULT_INDEX_SCHEMA_VERSION = 1
export const VAULT_INDEX_BLOOM_BYTES = 4_096
const VAULT_INDEX_HASH_COUNT = 5
const MAX_INDEX_TERMS_PER_DOCUMENT = 6_000

export interface VaultIndexFileMetadata {
  path: string
  filename: string
  extension: string
  mtime: number
  size: number
}

export interface VaultIndexRecord extends VaultIndexFileMetadata {
  schemaVersion: typeof VAULT_INDEX_SCHEMA_VERSION
  indexedAt: number
  state: 'ready' | 'empty' | 'skipped' | 'failed'
  bloom: ArrayBuffer
}

export interface VaultIndexStatus {
  active: boolean
  total: number
  ready: number
  empty: number
  skipped: number
  failed: number
  pending: number
  running: boolean
}

export interface RankedVaultIndexCandidate {
  path: string
  score: number
  reason: 'metadata' | 'content-index'
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
}

function hashOne(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function hashTwo(value: string): number {
  let hash = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x85ebca6b)
    hash ^= hash >>> 13
  }
  return (hash | 1) >>> 0
}

function bloomPositions(term: string): number[] {
  const bitCount = VAULT_INDEX_BLOOM_BYTES * 8
  const first = hashOne(term)
  const second = hashTwo(term)
  const positions: number[] = []
  for (let index = 0; index < VAULT_INDEX_HASH_COUNT; index++) {
    const mixed = (first + Math.imul(index + 1, second) + Math.imul(index, index + 17)) >>> 0
    positions.push(mixed % bitCount)
  }
  return positions
}

function addBloomTerm(bytes: Uint8Array, term: string): void {
  for (const position of bloomPositions(term)) {
    bytes[position >>> 3] |= 1 << (position & 7)
  }
}

function bloomHasTerm(bytes: Uint8Array, term: string): boolean {
  return bloomPositions(term).every(
    (position) => Boolean(bytes[position >>> 3] & (1 << (position & 7))),
  )
}

const GENERIC_INDEX_TERMS = new Set([
  '的', '了', '和', '与', '或', '在', '是', '有', '把', '给', '从', '到', '这个', '那个',
  '帮我', '请问', '一下', '处理', '读取', '搜索', '查找', '文件', '文档', '笔记', 'skill',
])

function addRunTerms(target: Set<string>, rawRun: string): void {
  const run = normalizeText(rawRun).replace(/\s+/gu, '')
  if (!run || GENERIC_INDEX_TERMS.has(run)) return
  if (/^[\p{Script=Han}]+$/u.test(run)) {
    if (run.length === 1) {
      target.add(run)
      return
    }
    if (run.length <= 12) target.add(run)
    for (let index = 0; index < run.length - 1; index++) {
      const bigram = run.slice(index, index + 2)
      if (!GENERIC_INDEX_TERMS.has(bigram)) target.add(bigram)
    }
    return
  }
  if (run.length >= 2 && run.length <= 80) target.add(run)
}

function collectIndexTerms(value: string, limit: number): string[] {
  const normalized = normalizeText(value)
  const terms = new Set<string>()
  const pattern = /[\p{Script=Han}]+[a-z0-9._-]+|[a-z0-9._-]+[\p{Script=Han}]+|[a-z0-9][a-z0-9._-]*|[\p{Script=Han}]+/gu
  for (const token of normalized.match(pattern) ?? []) {
    addRunTerms(terms, token)
    const runs = token.match(/[a-z0-9][a-z0-9._-]*|[\p{Script=Han}]+/gu) ?? []
    if (runs.length > 1) {
      for (const run of runs) addRunTerms(terms, run)
    }
    if (terms.size >= limit) break
  }
  return [...terms].slice(0, limit)
}

export function buildVaultIndexBloom(text: string): ArrayBuffer {
  const bytes = new Uint8Array(VAULT_INDEX_BLOOM_BYTES)
  for (const term of collectIndexTerms(text, MAX_INDEX_TERMS_PER_DOCUMENT)) {
    addBloomTerm(bytes, term)
  }
  return bytes.buffer
}

export function vaultIndexContentScore(record: VaultIndexRecord, query: string): number {
  if (record.state !== 'ready' || record.bloom.byteLength !== VAULT_INDEX_BLOOM_BYTES) return 0
  const bytes = new Uint8Array(record.bloom)
  const terms = collectIndexTerms(query, 32).filter((term) => !GENERIC_INDEX_TERMS.has(term))
  if (terms.length === 0) return 0
  const matches = terms.filter((term) => bloomHasTerm(bytes, term)).length
  const minimum = terms.length === 1 ? 1 : Math.max(2, Math.ceil(Math.min(terms.length, 8) * 0.45))
  if (matches < minimum) return 0
  return matches * 10 + (matches / terms.length) * 20
}

export function isVaultIndexRecordFresh(
  record: VaultIndexRecord | undefined,
  file: VaultIndexFileMetadata,
): boolean {
  return Boolean(
    record &&
      record.schemaVersion === VAULT_INDEX_SCHEMA_VERSION &&
      record.path === file.path &&
      record.mtime === file.mtime &&
      record.size === file.size,
  )
}

function fuzzySubsequence(value: string, wanted: string): boolean {
  if (wanted.length < 4) return false
  let offset = 0
  for (const character of value) {
    if (character === wanted[offset]) offset += 1
    if (offset >= wanted.length) return true
  }
  return false
}

function fileAllowed(file: VaultIndexFileMetadata, options: VaultSearchOptions): boolean {
  if (isVaultSearchPathExcluded(file.path)) return false
  const path = normalizePath(file.path)
  const excludedPaths = new Set((options.excludedPaths ?? []).map(normalizePath))
  if (excludedPaths.has(path)) return false
  const excludedFolders = (options.excludedFolders ?? []).map(normalizePath).filter(Boolean)
  if (excludedFolders.some((folder) => isPathInsideFolder(path, folder))) return false
  const includedFolders = (options.includedFolders ?? []).map(normalizePath).filter(Boolean)
  return includedFolders.length === 0 || includedFolders.some((folder) => isPathInsideFolder(path, folder))
}

export function rankVaultMetadataCandidates(
  query: string,
  files: VaultIndexFileMetadata[],
  options: VaultSearchOptions = {},
  maxCandidates = 48,
): RankedVaultIndexCandidate[] {
  const normalizedQuery = normalizeText(query)
  const compactQuery = normalizedQuery.replace(/[^\p{L}\p{N}]+/gu, '')
  const terms = buildVaultSearchTerms(query)
  const nowMs = options.nowMs ?? Date.now()
  const asksLatest = /今天|今日|刚刚|刚才|最新|最近|新加|新增|刚存|刚放/u.test(normalizedQuery)
  const ranked: RankedVaultIndexCandidate[] = []
  for (const file of files) {
    if (!fileAllowed(file, options)) continue
    const normalizedPath = normalizeText(file.path)
    const title = normalizeText(file.filename.replace(/\.[^.]+$/u, ''))
    const compactPath = normalizedPath.replace(/[^\p{L}\p{N}]+/gu, '')
    const compactTitle = title.replace(/[^\p{L}\p{N}]+/gu, '')
    let score = 0
    if (compactQuery.length >= 3) {
      if (compactTitle.includes(compactQuery)) score += 180
      else if (compactPath.includes(compactQuery)) score += 110
    }
    for (const term of terms) {
      if (!term || GENERIC_INDEX_TERMS.has(term)) continue
      if (title.includes(term)) score += 38
      else if (normalizedPath.includes(term)) score += 19
      else if (fuzzySubsequence(compactTitle, term.replace(/[^\p{L}\p{N}]+/gu, ''))) score += 8
    }
    if (asksLatest) {
      const age = nowMs - file.mtime
      if (age >= 0 && age <= 24 * 60 * 60 * 1_000) score += 28
      else if (age >= 0 && age <= 7 * 24 * 60 * 60 * 1_000) score += 12
    }
    if (score > 0) ranked.push({ path: file.path, score, reason: 'metadata' })
  }
  return ranked
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'zh-CN'))
    .slice(0, Math.max(1, maxCandidates))
}

export function rankVaultContentIndexCandidates(
  query: string,
  files: VaultIndexFileMetadata[],
  records: Map<string, VaultIndexRecord>,
  options: VaultSearchOptions = {},
  maxCandidates = 64,
): RankedVaultIndexCandidate[] {
  const ranked: RankedVaultIndexCandidate[] = []
  for (const file of files) {
    if (!fileAllowed(file, options)) continue
    const record = records.get(file.path)
    if (!isVaultIndexRecordFresh(record, file) || !record) continue
    const score = vaultIndexContentScore(record, query)
    if (score > 0) ranked.push({ path: file.path, score, reason: 'content-index' })
  }
  return ranked
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'zh-CN'))
    .slice(0, Math.max(1, maxCandidates))
}

export function summarizeVaultIndex(
  files: VaultIndexFileMetadata[],
  records: Map<string, VaultIndexRecord>,
  running: boolean,
  active = true,
): VaultIndexStatus {
  const status: VaultIndexStatus = {
    active,
    total: files.length,
    ready: 0,
    empty: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    running,
  }
  for (const file of files) {
    const record = records.get(file.path)
    if (!isVaultIndexRecordFresh(record, file) || !record) {
      status.pending += 1
      continue
    }
    status[record.state] += 1
  }
  return status
}

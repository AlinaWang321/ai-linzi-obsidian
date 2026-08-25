import type { WeeklyBusinessFileFingerprint } from './weekly-business-cache'

export const WEEKLY_BUSINESS_INDEX_VERSION = 1
export const WEEKLY_BUSINESS_MAP_SEGMENT_CHARS = 24_000
export const WEEKLY_BUSINESS_MAP_BATCH_CHARS = 58_000
export const WEEKLY_BUSINESS_REDUCE_BATCH_CHARS = 58_000

export interface WeeklyBusinessSummarySegment {
  index: number
  offset: number
  nextOffset: number | null
  summary: string
}

export interface WeeklyBusinessSummaryRecord extends WeeklyBusinessFileFingerprint {
  version: 1
  totalChars: number
  status: 'ready' | 'skipped'
  segments: WeeklyBusinessSummarySegment[]
  skippedReason?: string
  updatedAt: number
}

export interface WeeklyBusinessIndexSelection {
  reusable: WeeklyBusinessSummaryRecord[]
  pending: WeeklyBusinessFileFingerprint[]
  removedPaths: string[]
}

export function selectWeeklyBusinessIndexWork(
  files: WeeklyBusinessFileFingerprint[],
  records: WeeklyBusinessSummaryRecord[],
): WeeklyBusinessIndexSelection {
  const current = new Map(files.map((file) => [file.path, file]))
  const stored = new Map(records.map((record) => [record.path, record]))
  const reusable: WeeklyBusinessSummaryRecord[] = []
  const pending: WeeklyBusinessFileFingerprint[] = []
  for (const file of files) {
    const record = stored.get(file.path)
    if (
      record &&
      record.mtime === file.mtime &&
      record.size === file.size &&
      isWeeklyBusinessRecordComplete(record)
    ) reusable.push(record)
    else pending.push(file)
  }
  return {
    reusable,
    pending,
    removedPaths: records
      .filter((record) => !current.has(record.path))
      .map((record) => record.path)
      .sort((left, right) => left.localeCompare(right, 'zh-CN')),
  }
}

export function weeklyBusinessTaskId(files: WeeklyBusinessFileFingerprint[]): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  const source = [...files]
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    .map((file) => `${file.path}\u0000${file.mtime}\u0000${file.size}`)
    .join('\u0001')
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `weekly-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`
}

export function nextWeeklyBusinessOffset(record: WeeklyBusinessSummaryRecord | undefined): number {
  if (!record || record.status === 'skipped' || record.segments.length === 0) return 0
  const last = [...record.segments].sort((left, right) => left.index - right.index).at(-1)
  return last?.nextOffset ?? record.totalChars
}

export function isWeeklyBusinessRecordComplete(record: WeeklyBusinessSummaryRecord): boolean {
  if (record.status === 'skipped') return true
  if (record.segments.length === 0) return false
  return record.segments.some((segment) => segment.nextOffset === null)
}

export function weeklyBusinessSummaryItems(records: WeeklyBusinessSummaryRecord[]): Array<{
  sourceId: string
  path: string
  summary: string
}> {
  return records
    .filter((record) => record.status === 'ready' && isWeeklyBusinessRecordComplete(record))
    .flatMap((record) => [...record.segments]
      .sort((left, right) => left.index - right.index)
      .map((segment) => ({
        sourceId: `${record.path}#${segment.index}`,
        path: record.path,
        summary: segment.summary,
      })))
}

export function groupWeeklyBusinessSummaries<T extends { path: string; summary: string }>(
  items: T[],
  maxChars = WEEKLY_BUSINESS_REDUCE_BATCH_CHARS,
  maxItems = 80,
): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let chars = 0
  for (const item of items) {
    const size = item.path.length + item.summary.length + 80
    if (current.length > 0 && (chars + size > maxChars || current.length >= maxItems)) {
      groups.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += size
  }
  if (current.length > 0) groups.push(current)
  return groups
}

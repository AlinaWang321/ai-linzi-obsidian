export interface WeeklyBusinessFileFingerprint {
  path: string
  mtime: number
  size: number
}

export interface WeeklyBusinessScanState {
  sinceDays: number
  capturedAt: number
  files: WeeklyBusinessFileFingerprint[]
}

export interface WeeklyBusinessDashboardCache extends WeeklyBusinessScanState {
  version: 1
  artifactPath: string
  updatedAt: number
}

export interface WeeklyBusinessRefreshSelection {
  mode: 'full' | 'incremental'
  readFiles: WeeklyBusinessFileFingerprint[]
  unchangedFiles: number
  removedPaths: string[]
}

export const WEEKLY_BUSINESS_CACHE_MAX_FILES = 20_000
export const WEEKLY_BUSINESS_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function storedFingerprint(value: unknown): WeeklyBusinessFileFingerprint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path.trim()) return null
  if (!finiteNonNegative(raw.mtime) || !finiteNonNegative(raw.size)) return null
  return { path: raw.path.trim(), mtime: raw.mtime, size: raw.size }
}

export function storedWeeklyBusinessDashboardCache(
  value: unknown,
): WeeklyBusinessDashboardCache | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || typeof raw.artifactPath !== 'string' || !raw.artifactPath.trim()) return null
  if (!finiteNonNegative(raw.updatedAt) || !finiteNonNegative(raw.capturedAt)) return null
  if (!Number.isInteger(raw.sinceDays) || Number(raw.sinceDays) < 1 || Number(raw.sinceDays) > 31) return null
  if (!Array.isArray(raw.files) || raw.files.length > WEEKLY_BUSINESS_CACHE_MAX_FILES) return null
  const files = raw.files.map(storedFingerprint)
  if (files.some((file) => !file)) return null
  return {
    version: 1,
    artifactPath: raw.artifactPath.trim(),
    updatedAt: raw.updatedAt,
    capturedAt: raw.capturedAt,
    sinceDays: Number(raw.sinceDays),
    files: files as WeeklyBusinessFileFingerprint[],
  }
}

export function storedWeeklyBusinessScanState(value: unknown): WeeklyBusinessScanState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!finiteNonNegative(raw.capturedAt)) return null
  if (!Number.isInteger(raw.sinceDays) || Number(raw.sinceDays) < 1 || Number(raw.sinceDays) > 31) return null
  if (!Array.isArray(raw.files) || raw.files.length > WEEKLY_BUSINESS_CACHE_MAX_FILES) return null
  const files = raw.files.map(storedFingerprint)
  if (files.some((file) => !file)) return null
  return {
    capturedAt: raw.capturedAt,
    sinceDays: Number(raw.sinceDays),
    files: files as WeeklyBusinessFileFingerprint[],
  }
}

export function selectWeeklyBusinessRefresh(
  currentFiles: WeeklyBusinessFileFingerprint[],
  cache: WeeklyBusinessDashboardCache | null,
  options: { baselineAvailable: boolean; now?: number; sinceDays: number },
): WeeklyBusinessRefreshSelection {
  const now = options.now ?? Date.now()
  const canIncrement = Boolean(
    cache &&
      options.baselineAvailable &&
      cache.sinceDays === options.sinceDays &&
      now - cache.updatedAt <= WEEKLY_BUSINESS_CACHE_MAX_AGE_MS,
  )
  if (!canIncrement || !cache) {
    return { mode: 'full', readFiles: [...currentFiles], unchangedFiles: 0, removedPaths: [] }
  }

  const previous = new Map(cache.files.map((file) => [file.path, file]))
  const currentPaths = new Set(currentFiles.map((file) => file.path))
  const readFiles = currentFiles.filter((file) => {
    const old = previous.get(file.path)
    return !old || old.mtime !== file.mtime || old.size !== file.size
  })
  return {
    mode: 'incremental',
    readFiles,
    unchangedFiles: currentFiles.length - readFiles.length,
    removedPaths: cache.files
      .filter((file) => !currentPaths.has(file.path))
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right, 'zh-CN')),
  }
}

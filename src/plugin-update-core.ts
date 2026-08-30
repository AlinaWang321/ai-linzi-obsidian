export const PLUGIN_UPDATE_NOTICE_TEXT = 'AI霖子插件有新的更新了，请及时更新重启'

export const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function comparePluginVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!/^\d+\.\d+\.\d+$/.test(value.trim())) return []
    return value.split('.').map((part) => Number.parseInt(part, 10))
  }
  const a = parse(left)
  const b = parse(right)
  if (a.length === 0 || b.length === 0) return 0
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function isPluginUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(currentVersion.trim())) return false
  if (!/^\d+\.\d+\.\d+$/.test(latestVersion.trim())) return false
  return comparePluginVersions(currentVersion, latestVersion) < 0
}

export function isPluginBundleVersionMismatch(
  manifestVersion: string,
  bundledVersion: string,
): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(manifestVersion.trim())) return true
  if (!/^\d+\.\d+\.\d+$/.test(bundledVersion.trim())) return true
  return manifestVersion !== bundledVersion
}

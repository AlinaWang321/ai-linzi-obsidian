export interface VaultInventoryFile {
  path: string
  extension: string
  size: number
  mtime: number
}

export interface VaultInventoryFolder {
  path: string
}

export interface VaultInventoryOptions {
  root?: string
  depth?: number
  maxFolders?: number
  recentLimit?: number
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value as number)))
    : fallback
}

function inside(path: string, root: string): boolean {
  return !root || path === root || path.startsWith(`${root}/`)
}

function relativeDepth(path: string, root: string): number {
  const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  return relative.split('/').filter(Boolean).length
}

export function buildVaultInventory(
  allFiles: VaultInventoryFile[],
  allFolders: VaultInventoryFolder[],
  options: VaultInventoryOptions = {},
): Record<string, unknown> {
  const root = options.root?.trim().replace(/^\/+|\/+$/g, '') ?? ''
  const depth = clamp(options.depth, 4, 1, 8)
  const maxFolders = clamp(options.maxFolders, 120, 10, 240)
  const recentLimit = clamp(options.recentLimit, 16, 1, 40)
  const files = allFiles.filter((file) => inside(file.path, root))
  const folders = allFolders.filter((folder) => inside(folder.path, root))
  const extensionCounts = new Map<string, number>()
  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.size
    const extension = file.extension.toLocaleLowerCase() || '(none)'
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1)
  }
  const directCounts = new Map<string, number>()
  const descendantCounts = new Map<string, number>()
  for (const file of files) {
    const segments = file.path.split('/')
    const parent = segments.slice(0, -1).join('/')
    directCounts.set(parent, (directCounts.get(parent) ?? 0) + 1)
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join('/')
      descendantCounts.set(ancestor, (descendantCounts.get(ancestor) ?? 0) + 1)
    }
  }
  const folderRows = folders
    .filter((folder) => relativeDepth(folder.path, root) <= depth)
    .map((folder) => ({
      path: folder.path,
      directFiles: directCounts.get(folder.path) ?? 0,
      totalFiles: descendantCounts.get(folder.path) ?? 0,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
  const recentFiles = [...files]
    .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path, 'zh-CN'))
    .slice(0, recentLimit)
    .map((file) => ({ path: file.path, modifiedAt: file.mtime, size: file.size }))
  return {
    mode: 'vault-inventory',
    root: root || '/',
    metadataOnly: true,
    privacyNote: '只包含路径、类型、大小、修改时间和统计，不包含任何文件正文。',
    totalFiles: files.length,
    totalFolders: folders.length,
    totalBytes,
    extensions: [...extensionCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 30)
      .map(([extension, count]) => ({ extension, count })),
    folderDepth: depth,
    returnedFolders: Math.min(folderRows.length, maxFolders),
    foldersTruncated: folderRows.length > maxFolders,
    folders: folderRows.slice(0, maxFolders),
    recentFiles,
  }
}

import { normalizeVaultRelativePath, type VaultOrganizePlan } from './vault-agent-core'

export const DYNAMIC_DASHBOARD_CODE_BLOCK = 'ai-linzi-dashboard'
export const DYNAMIC_DASHBOARD_VERSION = 1
export const DYNAMIC_DASHBOARD_MAX_SECTIONS = 8
export const DYNAMIC_DASHBOARD_MAX_ROWS = 100

export type DynamicDashboardSection =
  | {
      type: 'overview'
      title: string
      roots: string[]
    }
  | {
      type: 'folder_overview'
      title: string
      roots: string[]
      depth: number
      limit: number
    }
  | {
      type: 'recent_files'
      title: string
      roots: string[]
      sinceDays: number
      limit: number
    }
  | {
      type: 'file_list'
      title: string
      roots: string[]
      extensions: string[]
      pathIncludes: string[]
      limit: number
    }
  | {
      type: 'quick_links'
      title: string
      paths: string[]
    }

export interface DynamicDashboardSpec {
  version: 1
  title: string
  subtitle: string
  sections: DynamicDashboardSection[]
}

export interface DynamicDashboardFileEntry {
  path: string
  extension: string
  size: number
  mtime: number
}

export interface DynamicDashboardFolderEntry {
  path: string
}

export interface DynamicDashboardSectionResult {
  type: DynamicDashboardSection['type']
  title: string
  metrics?: { label: string; value: string }[]
  rows?: { path: string; detail: string }[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, fallback: string, max = 120): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function safePaths(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => normalizeVaultRelativePath(item))
      .filter((item): item is string => Boolean(item)),
  )].slice(0, max)
}

function safeExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().replace(/^\./, '').toLocaleLowerCase())
      .filter((item) => /^[a-z0-9]{1,12}$/.test(item)),
  )].slice(0, 12)
}

function safeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().normalize('NFKC').toLocaleLowerCase().slice(0, 80))
      .filter(Boolean),
  )].slice(0, 12)
}

function defaultSectionTitle(type: DynamicDashboardSection['type']): string {
  if (type === 'overview') return '全库概览'
  if (type === 'folder_overview') return '目录结构'
  if (type === 'recent_files') return '最近更新'
  if (type === 'file_list') return '重点文件'
  return '快捷入口'
}

function parseSection(value: unknown): DynamicDashboardSection | null {
  const item = record(value)
  if (!item) return null
  const type = typeof item.type === 'string' ? item.type : ''
  if (
    type !== 'overview' &&
    type !== 'folder_overview' &&
    type !== 'recent_files' &&
    type !== 'file_list' &&
    type !== 'quick_links'
  ) return null
  const title = text(item.title, defaultSectionTitle(type), 80)
  if (type === 'quick_links') {
    const paths = safePaths(item.paths, 20)
    return paths.length > 0 ? { type, title, paths } : null
  }
  const roots = safePaths(item.roots, 8)
  if (type === 'overview') return { type, title, roots }
  if (type === 'folder_overview') {
    return {
      type,
      title,
      roots,
      depth: int(item.depth, 2, 1, 6),
      limit: int(item.limit, 24, 1, 60),
    }
  }
  if (type === 'recent_files') {
    return {
      type,
      title,
      roots,
      sinceDays: int(item.sinceDays, 14, 1, 365),
      limit: int(item.limit, 20, 1, DYNAMIC_DASHBOARD_MAX_ROWS),
    }
  }
  return {
    type,
    title,
    roots,
    extensions: safeExtensions(item.extensions),
    pathIncludes: safeTerms(item.pathIncludes),
    limit: int(item.limit, 30, 1, DYNAMIC_DASHBOARD_MAX_ROWS),
  }
}

export function parseDynamicDashboardSpec(value: unknown): DynamicDashboardSpec | null {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  const source = record(parsed)
  if (!source) return null
  const sections = (Array.isArray(source.sections) ? source.sections : [])
    .map(parseSection)
    .filter((section): section is DynamicDashboardSection => Boolean(section))
    .slice(0, DYNAMIC_DASHBOARD_MAX_SECTIONS)
  if (sections.length === 0) return null
  return {
    version: DYNAMIC_DASHBOARD_VERSION,
    title: text(source.title, '我的动态工作台', 100),
    subtitle: text(source.subtitle, '内容随 Vault 自动刷新', 180),
    sections,
  }
}

export function serializeDynamicDashboardNote(spec: DynamicDashboardSpec): string {
  return [
    `# ${spec.title}`,
    '',
    spec.subtitle,
    '',
    '> 这是 AI霖子动态工作台。你可以直接修改下方 JSON；打开笔记时数据会在本机按当前 Vault 自动刷新。',
    '',
    `\`\`\`${DYNAMIC_DASHBOARD_CODE_BLOCK}`,
    JSON.stringify(spec, null, 2),
    '```',
  ].join('\n')
}

export function dynamicDashboardPlanFromToolArguments(
  value: unknown,
): VaultOrganizePlan | null {
  const input = record(value)
  if (!input) return null
  const path = normalizeVaultRelativePath(input.path)
  if (!path || !path.toLocaleLowerCase().endsWith('.md')) return null
  const spec = parseDynamicDashboardSpec(input.spec)
  if (!spec) return null
  return {
    title: text(input.planTitle, `创建动态工作台：${spec.title}`, 100),
    summary: text(
      input.summary,
      '确认后只新建一篇可编辑的 Markdown 工作台；数据在本机实时读取，不会上传整库正文。',
      240,
    ),
    operations: [{
      type: 'create_note',
      path,
      content: serializeDynamicDashboardNote(spec),
      reason: '建立可编辑、自动刷新的本地工作台',
    }],
    notes: [
      '只读取文件路径、类型、大小和修改时间等本机元数据。',
      '不会覆盖同名文件；确认后插件才会创建。',
    ],
  }
}

function insideRoots(path: string, roots: string[]): boolean {
  return roots.length === 0 || roots.some((root) => path === root || path.startsWith(`${root}/`))
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function fileDetail(file: DynamicDashboardFileEntry): string {
  const size = file.size >= 1_048_576
    ? `${(file.size / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(file.size / 1024))} KB`
  return `${new Date(file.mtime).toLocaleString()} · ${size}`
}

export function buildDynamicDashboardResults(
  spec: DynamicDashboardSpec,
  files: DynamicDashboardFileEntry[],
  folders: DynamicDashboardFolderEntry[],
  now = Date.now(),
): DynamicDashboardSectionResult[] {
  return spec.sections.map((section) => {
    if (section.type === 'quick_links') {
      return {
        type: section.type,
        title: section.title,
        rows: section.paths.map((path) => ({ path, detail: '打开' })),
      }
    }
    const scopedFiles = files.filter((file) => insideRoots(file.path, section.roots))
    const scopedFolders = folders.filter((folder) => insideRoots(folder.path, section.roots))
    if (section.type === 'overview') {
      const totalBytes = scopedFiles.reduce((sum, file) => sum + file.size, 0)
      const latest = scopedFiles.reduce((max, file) => Math.max(max, file.mtime), 0)
      return {
        type: section.type,
        title: section.title,
        metrics: [
          { label: '文件', value: scopedFiles.length.toLocaleString() },
          { label: '文件夹', value: scopedFolders.length.toLocaleString() },
          { label: '体积', value: totalBytes >= 1_073_741_824 ? `${(totalBytes / 1_073_741_824).toFixed(1)} GB` : `${(totalBytes / 1_048_576).toFixed(1)} MB` },
          { label: '最近更新', value: latest ? new Date(latest).toLocaleDateString() : '暂无' },
        ],
      }
    }
    if (section.type === 'folder_overview') {
      const rows = scopedFolders
        .filter((folder) => {
          const relative = section.roots.length > 0
            ? section.roots.reduce((best, root) => folder.path.startsWith(`${root}/`) && root.length > best.length ? root : best, '')
            : ''
          const remainder = relative ? folder.path.slice(relative.length + 1) : folder.path
          return remainder.split('/').filter(Boolean).length <= section.depth
        })
        .map((folder) => ({
          path: folder.path,
          detail: `${scopedFiles.filter((file) => file.path.startsWith(`${folder.path}/`)).length} 个文件`,
        }))
        .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
        .slice(0, section.limit)
      return { type: section.type, title: section.title, rows }
    }
    if (section.type === 'recent_files') {
      const cutoff = now - section.sinceDays * 86_400_000
      const rows = scopedFiles
        .filter((file) => file.mtime >= cutoff)
        .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path, 'zh-CN'))
        .slice(0, section.limit)
        .map((file) => ({ path: file.path, detail: fileDetail(file) }))
      return { type: section.type, title: section.title, rows }
    }
    const rows = scopedFiles
      .filter((file) => section.extensions.length === 0 || section.extensions.includes(file.extension.toLocaleLowerCase()))
      .filter((file) => {
        if (section.pathIncludes.length === 0) return true
        const haystack = file.path.normalize('NFKC').toLocaleLowerCase()
        return section.pathIncludes.some((term) => haystack.includes(term))
      })
      .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path, 'zh-CN'))
      .slice(0, section.limit)
      .map((file) => ({ path: file.path, detail: `${fileName(file.path)} · ${fileDetail(file)}` }))
    return { type: section.type, title: section.title, rows }
  })
}

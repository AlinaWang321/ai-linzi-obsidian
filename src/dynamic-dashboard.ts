import { App, MarkdownRenderChild, setIcon } from 'obsidian'
import {
  buildDynamicDashboardResults,
  parseDynamicDashboardSpec,
  type DynamicDashboardFileEntry,
  type DynamicDashboardFolderEntry,
  type DynamicDashboardSpec,
} from './dynamic-dashboard-core'

export interface DynamicDashboardHost {
  isProtectedPath(path: string): boolean
  openPath(path: string): Promise<void>
}

function visibleVaultEntries(
  app: App,
  host: DynamicDashboardHost,
): { files: DynamicDashboardFileEntry[]; folders: DynamicDashboardFolderEntry[] } {
  const files = app.vault.getFiles()
    .filter((file) => !host.isProtectedPath(file.path))
    .map((file) => ({
      path: file.path,
      extension: file.extension.toLocaleLowerCase(),
      size: file.stat.size,
      mtime: file.stat.mtime,
    }))
  const folders = app.vault.getAllFolders()
    .filter((folder) => folder.path && !host.isProtectedPath(folder.path))
    .map((folder) => ({ path: folder.path }))
  return { files, folders }
}

function renderEmpty(el: HTMLElement, message: string): void {
  el.createDiv({ cls: 'ai-linzi-dynamic-dashboard-empty', text: message })
}

function renderDashboard(
  app: App,
  host: DynamicDashboardHost,
  el: HTMLElement,
  spec: DynamicDashboardSpec,
): void {
  el.empty()
  el.addClass('ai-linzi-dynamic-dashboard')
  const header = el.createDiv({ cls: 'ai-linzi-dynamic-dashboard-header' })
  const titleGroup = header.createDiv({ cls: 'ai-linzi-dynamic-dashboard-title-group' })
  titleGroup.createEl('h2', { text: spec.title })
  titleGroup.createEl('p', { text: spec.subtitle })
  const status = header.createDiv({ cls: 'ai-linzi-dynamic-dashboard-status' })
  setIcon(status.createSpan({ cls: 'ai-linzi-dynamic-dashboard-status-icon' }), 'refresh-cw')
  status.createSpan({ text: `本机实时 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` })

  const { files, folders } = visibleVaultEntries(app, host)
  const results = buildDynamicDashboardResults(spec, files, folders)
  const grid = el.createDiv({ cls: 'ai-linzi-dynamic-dashboard-grid' })
  for (const section of results) {
    const card = grid.createDiv({ cls: 'ai-linzi-dynamic-dashboard-card' })
    card.createEl('h3', { text: section.title })
    if (section.metrics) {
      const metrics = card.createDiv({ cls: 'ai-linzi-dynamic-dashboard-metrics' })
      for (const metric of section.metrics) {
        const item = metrics.createDiv({ cls: 'ai-linzi-dynamic-dashboard-metric' })
        item.createDiv({ cls: 'ai-linzi-dynamic-dashboard-metric-value', text: metric.value })
        item.createDiv({ cls: 'ai-linzi-dynamic-dashboard-metric-label', text: metric.label })
      }
      continue
    }
    const visibleRows = section.rows?.filter((row) => !host.isProtectedPath(row.path)) ?? []
    if (visibleRows.length === 0) {
      renderEmpty(card, '当前范围还没有匹配内容')
      continue
    }
    const list = card.createDiv({ cls: 'ai-linzi-dynamic-dashboard-list' })
    for (const row of visibleRows) {
      const button = list.createEl('button', {
        cls: 'ai-linzi-dynamic-dashboard-row',
        attr: { type: 'button', 'aria-label': `打开 ${row.path}` },
      })
      const copy = button.createDiv({ cls: 'ai-linzi-dynamic-dashboard-row-copy' })
      copy.createDiv({ cls: 'ai-linzi-dynamic-dashboard-row-path', text: row.path })
      copy.createDiv({ cls: 'ai-linzi-dynamic-dashboard-row-detail', text: row.detail })
      setIcon(button.createSpan({ cls: 'ai-linzi-dynamic-dashboard-row-icon' }), 'chevron-right')
      button.addEventListener('click', () => void host.openPath(row.path))
    }
  }
}

export class DynamicDashboardComponent extends MarkdownRenderChild {
  private refreshTimer: number | null = null

  constructor(
    private readonly app: App,
    private readonly host: DynamicDashboardHost,
    private readonly el: HTMLElement,
    private readonly spec: DynamicDashboardSpec,
  ) {
    super(el)
  }

  onload(): void {
    const refresh = () => this.scheduleRefresh()
    this.registerEvent(this.app.vault.on('create', refresh))
    this.registerEvent(this.app.vault.on('modify', refresh))
    this.registerEvent(this.app.vault.on('delete', refresh))
    this.registerEvent(this.app.vault.on('rename', refresh))
    renderDashboard(this.app, this.host, this.el, this.spec)
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = null
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      renderDashboard(this.app, this.host, this.el, this.spec)
    }, 250)
  }
}

export function renderDynamicDashboardBlock(
  app: App,
  host: DynamicDashboardHost,
  source: string,
  el: HTMLElement,
): DynamicDashboardComponent | null {
  const spec = parseDynamicDashboardSpec(source)
  if (!spec) {
    el.empty()
    el.addClass('ai-linzi-dynamic-dashboard')
    renderEmpty(el, '工作台规格无法读取。请检查 JSON，或让 AI霖子帮你修复这篇工作台。')
    return null
  }
  return new DynamicDashboardComponent(app, host, el, spec)
}

import { ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf, normalizePath, setIcon } from 'obsidian'
import type AiLinziPlugin from './main'
import { runArticleIllustration, runTopicRadar, runWechatWriter } from './actions'
import { copyWechatFormatted, sendToWechatDraft } from './publish'
import {
  boardLane,
  deriveContentRecord,
  isDashboardContentPath,
  isDateInRange,
  parseLocalDate,
  startOfWeek,
  type BoardLane,
  type ContentRecord,
  type WechatStatus,
} from './content-state'

export const VIEW_TYPE_CONTENT_DASHBOARD = 'ai-linzi-content-dashboard'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

function isoToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shortDate(value: string): string {
  return value ? value.slice(5).replace('-', '/') : '未记录'
}

function hasLocalImage(plugin: AiLinziPlugin, file: TFile): boolean {
  const cache = plugin.app.metadataCache.getFileCache(file)
  return Boolean(
    cache?.embeds?.some((embed) => {
      const target = plugin.app.metadataCache.getFirstLinkpathDest(embed.link, file.path)
      return target instanceof TFile && IMAGE_EXTENSIONS.has(target.extension.toLowerCase())
    }),
  )
}

function scanContent(plugin: AiLinziPlugin): ContentRecord[] {
  const outputRoot = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
  return plugin.app.vault
    .getMarkdownFiles()
    .filter((file) => isDashboardContentPath(file.path, outputRoot))
    .map((file) => {
      const cache = plugin.app.metadataCache.getFileCache(file)
      return deriveContentRecord({
        path: file.path,
        basename: file.basename,
        frontmatter: cache?.frontmatter ?? null,
        createdAt: file.stat.ctime,
        modifiedAt: file.stat.mtime,
        hasLocalImages: hasLocalImage(plugin, file),
      })
    })
    .filter((record): record is ContentRecord => Boolean(record))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
}

class UpdateWechatStatusModal extends Modal {
  private submitted = false
  private resolve!: (value: { status: WechatStatus; date: string; url: string } | null) => void
  readonly result: Promise<{ status: WechatStatus; date: string; url: string } | null>

  constructor(
    app: AiLinziPlugin['app'],
    private record: ContentRecord,
    private initialStatus?: WechatStatus,
  ) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  onOpen() {
    this.titleEl.setText('修改公众号状态')
    let status = this.initialStatus ?? this.record.wechatStatus
    if (status === '未开始') status = '已生成草稿'
    let date =
      status === '已正式发布'
        ? this.record.wechatPublishedDate || isoToday()
        : status === '已发送公众号草稿箱'
          ? this.record.wechatDraftDate || isoToday()
          : isoToday()
    let url = this.record.wechatUrl
    this.contentEl.createEl('p', {
      text: '从插件发送草稿箱后会自动更新。手动上传、正式发布或状态有误时，可以在这里修正。',
      cls: 'setting-item-description',
    })
    new Setting(this.contentEl)
      .setName('当前状态')
      .addDropdown((input) =>
        input
          .addOption('已生成草稿', '已生成草稿')
          .addOption('已发送公众号草稿箱', '已发送公众号草稿箱')
          .addOption('已正式发布', '已正式发布')
          .setValue(status)
          .onChange((value) => {
            status = value as WechatStatus
          }),
      )
    new Setting(this.contentEl)
      .setName('状态日期')
      .setDesc('发送草稿箱或正式发布时使用，用于统计和日历')
      .addText((input) => input.setPlaceholder('YYYY-MM-DD').setValue(date).onChange((value) => (date = value.trim())))
    new Setting(this.contentEl)
      .setName('公众号文章链接（选填）')
      .setDesc('填写后可从看板直接打开已发布文章')
      .addText((input) => {
        input.setPlaceholder('https://mp.weixin.qq.com/s/...').setValue(url).onChange((value) => (url = value.trim()))
        input.inputEl.style.width = '100%'
      })
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('保存状态')
          .setCta()
          .onClick(() => {
            if (status !== '已生成草稿' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseLocalDate(date))) {
              new Notice('状态日期请填写为 YYYY-MM-DD')
              return
            }
            if (status === '已正式发布' && url && !/^https?:\/\//i.test(url)) {
              new Notice('公众号链接需要以 http:// 或 https:// 开头')
              return
            }
            this.submitted = true
            this.resolve({ status, date, url })
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

const LANES: { id: BoardLane; number: number; label: string }[] = [
  { id: 'topic', number: 1, label: '选题' },
  { id: 'write', number: 2, label: '写公众号' },
  { id: 'format', number: 3, label: '配图排版' },
  { id: 'draftbox', number: 4, label: '公众号草稿箱' },
  { id: 'published', number: 5, label: '公众号已发布' },
]

export class ContentDashboardView extends ItemView {
  private mode: 'board' | 'calendar' = 'board'
  private month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  private refreshTimer: number | null = null

  constructor(leaf: WorkspaceLeaf, private plugin: AiLinziPlugin) {
    super(leaf)
  }

  getViewType() {
    return VIEW_TYPE_CONTENT_DASHBOARD
  }

  getDisplayText() {
    return '内容发布看板'
  }

  getIcon() {
    return 'layout-dashboard'
  }

  async onOpen() {
    const schedule = () => this.scheduleRefresh()
    this.registerEvent(this.app.vault.on('create', schedule))
    this.registerEvent(this.app.vault.on('modify', schedule))
    this.registerEvent(this.app.vault.on('delete', schedule))
    this.registerEvent(this.app.metadataCache.on('changed', schedule))
    this.render()
  }

  async onClose() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      this.render()
    }, 350)
  }

  private render() {
    const records = scanContent(this.plugin)
    const root = this.contentEl
    root.empty()
    root.addClass('ai-linzi-dashboard-root')

    const header = root.createDiv({ cls: 'ai-linzi-dashboard-header' })
    const heading = header.createDiv()
    heading.createEl('h2', { text: '内容发布看板' })
    heading.createEl('p', {
      text: `内容来源：${normalizePath(this.plugin.settings.outputFolder || 'AI霖子输出')}（可在插件设置中修改）`,
    })
    const headerActions = header.createDiv({ cls: 'ai-linzi-dashboard-header-actions' })
    const refresh = headerActions.createEl('button', { text: '刷新' })
    refresh.onclick = () => this.render()
    const newTopic = headerActions.createEl('button', { text: '生成选题', cls: 'mod-cta' })
    newTopic.onclick = () => void runTopicRadar(this.plugin).then(() => this.render())

    this.renderStats(root, records)

    const tabs = root.createDiv({ cls: 'ai-linzi-dashboard-tabs' })
    const boardTab = tabs.createEl('button', { text: '看板' })
    const calendarTab = tabs.createEl('button', { text: '日历' })
    boardTab.toggleClass('is-active', this.mode === 'board')
    calendarTab.toggleClass('is-active', this.mode === 'calendar')
    boardTab.onclick = () => {
      this.mode = 'board'
      this.render()
    }
    calendarTab.onclick = () => {
      this.mode = 'calendar'
      this.render()
    }

    if (this.mode === 'board') this.renderBoard(root, records)
    else this.renderCalendar(root, records)
  }

  private renderStats(root: HTMLElement, records: ContentRecord[]) {
    const now = new Date()
    const weekStart = startOfWeek(now)
    const nextWeek = new Date(weekStart)
    nextWeek.setDate(nextWeek.getDate() + 7)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const stats = [
      {
        label: '本周选题',
        value: records.filter((r) => r.kind === '选题' && isDateInRange(r.createdDate, weekStart, nextWeek)).length,
      },
      {
        label: '本月选题',
        value: records.filter((r) => r.kind === '选题' && isDateInRange(r.createdDate, monthStart, nextMonth)).length,
      },
      {
        label: '本周草稿',
        value: records.filter((r) => r.kind === '公众号文章' && isDateInRange(r.draftDate, weekStart, nextWeek)).length,
      },
      {
        label: '本月草稿',
        value: records.filter((r) => r.kind === '公众号文章' && isDateInRange(r.draftDate, monthStart, nextMonth)).length,
      },
      {
        label: '本月公众号发布',
        value: records.filter((r) => isDateInRange(r.wechatPublishedDate, monthStart, nextMonth)).length,
      },
      { label: '累计公众号发布', value: records.filter((r) => r.wechatStatus === '已正式发布').length },
    ]
    const row = root.createDiv({ cls: 'ai-linzi-dashboard-stats' })
    for (const stat of stats) {
      const item = row.createDiv({ cls: 'ai-linzi-dashboard-stat' })
      item.createDiv({ text: stat.label, cls: 'ai-linzi-dashboard-stat-label' })
      const value = item.createDiv({ cls: 'ai-linzi-dashboard-stat-value' })
      value.createSpan({ text: String(stat.value) })
      value.createSpan({ text: ' 篇' })
    }
  }

  private renderBoard(root: HTMLElement, records: ContentRecord[]) {
    const board = root.createDiv({ cls: 'ai-linzi-dashboard-board' })
    for (const lane of LANES) {
      const laneRecords = records.filter((record) => boardLane(record) === lane.id)
      const column = board.createDiv({ cls: `ai-linzi-dashboard-column is-${lane.id}` })
      const header = column.createDiv({ cls: 'ai-linzi-dashboard-column-header' })
      header.createSpan({ text: `${lane.number}  ${lane.label}` })
      header.createSpan({ text: String(laneRecords.length), cls: 'ai-linzi-dashboard-count' })
      const list = column.createDiv({ cls: 'ai-linzi-dashboard-list' })
      if (laneRecords.length === 0) {
        list.createDiv({ text: '暂无内容', cls: 'ai-linzi-dashboard-empty' })
        continue
      }
      for (const record of laneRecords) this.renderCard(list, record, lane.id)
    }
  }

  private renderCard(list: HTMLElement, record: ContentRecord, lane: BoardLane) {
    const card = list.createDiv({ cls: 'ai-linzi-dashboard-card' })
    card.setAttribute('tabindex', '0')
    card.setAttribute('role', 'button')
    card.onclick = () => void this.openRecord(record)
    card.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') void this.openRecord(record)
    }
    card.createDiv({ text: record.title, cls: 'ai-linzi-dashboard-card-title' })
    const date =
      lane === 'published'
        ? record.wechatPublishedDate
        : lane === 'draftbox'
          ? record.wechatDraftDate
          : record.draftDate || record.createdDate
    card.createDiv({
      text: `${lane === 'published' ? '发布' : lane === 'draftbox' ? '发送' : '创建'}：${shortDate(date)} · ${record.sourceSkill}`,
      cls: 'ai-linzi-dashboard-card-meta',
    })
    const actions = card.createDiv({ cls: 'ai-linzi-dashboard-card-actions' })
    if (lane === 'topic') {
      this.actionButton(actions, '开始写作', record, () => runWechatWriter(this.plugin))
    } else if (lane === 'write') {
      this.actionButton(actions, '生成配图', record, () => runArticleIllustration(this.plugin))
    } else if (lane === 'format') {
      this.actionButton(actions, '复制排版', record, () => copyWechatFormatted(this.plugin))
      this.actionButton(actions, '发到草稿箱', record, () => sendToWechatDraft(this.plugin), true)
    } else if (lane === 'draftbox') {
      const button = actions.createEl('button', { text: '标记已发布' })
      button.onclick = (event) => {
        event.stopPropagation()
        void this.updateWechatStatus(record, button, '已正式发布')
      }
    } else if (lane === 'published' && record.wechatUrl) {
      const button = actions.createEl('button', { text: '打开公众号' })
      button.onclick = (event) => {
        event.stopPropagation()
        window.open(record.wechatUrl)
      }
    }
    if (record.kind === '公众号文章') {
      const statusButton = actions.createEl('button', { text: '修改状态' })
      statusButton.onclick = (event) => {
        event.stopPropagation()
        void this.updateWechatStatus(record, statusButton)
      }
    }
  }

  private actionButton(
    actions: HTMLElement,
    label: string,
    record: ContentRecord,
    action: () => Promise<void>,
    primary = false,
  ) {
    const button = actions.createEl('button', { text: label, cls: primary ? 'is-primary' : undefined })
    button.onclick = (event) => {
      event.stopPropagation()
      void this.runRecordAction(record, action, button)
    }
  }

  private async runRecordAction(record: ContentRecord, action: () => Promise<void>, button: HTMLButtonElement) {
    button.disabled = true
    try {
      if (!(await this.openRecord(record))) return
      await action()
      this.render()
    } finally {
      button.disabled = false
    }
  }

  private async openRecord(record: ContentRecord): Promise<TFile | null> {
    const file = this.app.vault.getAbstractFileByPath(record.filePath)
    if (!(file instanceof TFile)) {
      new Notice('这篇内容的笔记已经不存在')
      return null
    }
    this.plugin.lastActiveFile = file
    await this.app.workspace.getLeaf('tab').openFile(file)
    return file
  }

  private async updateWechatStatus(
    record: ContentRecord,
    button: HTMLButtonElement,
    initialStatus?: WechatStatus,
  ) {
    const result = await new UpdateWechatStatusModal(this.app, record, initialStatus).result
    if (!result) return
    const file = this.app.vault.getAbstractFileByPath(record.filePath)
    if (!(file instanceof TFile)) {
      new Notice('这篇内容的笔记已经不存在')
      return
    }
    button.disabled = true
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm['状态'] = result.status
        fm['内容类型'] = '公众号文章'
        fm['内容阶段'] = '已生成草稿'
        fm['公众号状态'] = result.status
        fm['视频状态'] = fm['视频状态'] || '未开始'
        fm['小红书状态'] = fm['小红书状态'] || '未开始'
        if (result.status === '已生成草稿') {
          delete fm['公众号草稿ID']
          delete fm['公众号草稿箱时间']
          delete fm['草稿箱时间']
          delete fm['公众号发布日期']
          delete fm['发布日期']
          delete fm['公众号链接']
          delete fm['发布链接']
        } else if (result.status === '已发送公众号草稿箱') {
          fm['公众号草稿箱时间'] = result.date
          fm['草稿箱时间'] = result.date
          delete fm['公众号发布日期']
          delete fm['发布日期']
          delete fm['公众号链接']
          delete fm['发布链接']
        } else {
          fm['公众号发布日期'] = result.date
          fm['发布日期'] = result.date
          if (result.url) {
            fm['公众号链接'] = result.url
            fm['发布链接'] = result.url
          } else {
            delete fm['公众号链接']
            delete fm['发布链接']
          }
        }
      })
      new Notice(`✅ 公众号状态已更新为「${result.status}」`)
      this.render()
    } finally {
      button.disabled = false
    }
  }

  private renderCalendar(root: HTMLElement, records: ContentRecord[]) {
    const wrapper = root.createDiv({ cls: 'ai-linzi-dashboard-calendar' })
    const header = wrapper.createDiv({ cls: 'ai-linzi-dashboard-calendar-header' })
    const previous = header.createEl('button', { attr: { 'aria-label': '上个月' } })
    setIcon(previous, 'chevron-left')
    previous.onclick = () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() - 1, 1)
      this.render()
    }
    header.createEl('strong', { text: `${this.month.getFullYear()} 年 ${this.month.getMonth() + 1} 月` })
    const next = header.createEl('button', { attr: { 'aria-label': '下个月' } })
    setIcon(next, 'chevron-right')
    next.onclick = () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 1)
      this.render()
    }

    const legend = wrapper.createDiv({ cls: 'ai-linzi-dashboard-calendar-legend' })
    legend.createSpan({ text: '● 草稿', cls: 'is-draft' })
    legend.createSpan({ text: '● 已发送草稿箱', cls: 'is-draftbox' })
    legend.createSpan({ text: '● 公众号已发布', cls: 'is-published' })

    const grid = wrapper.createDiv({ cls: 'ai-linzi-dashboard-calendar-grid' })
    for (const weekday of ['一', '二', '三', '四', '五', '六', '日']) {
      grid.createDiv({ text: `周${weekday}`, cls: 'ai-linzi-dashboard-calendar-weekday' })
    }
    const year = this.month.getFullYear()
    const month = this.month.getMonth()
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7
    const days = new Date(year, month + 1, 0).getDate()
    const cells = Math.ceil((firstWeekday + days) / 7) * 7
    const events = new Map<string, ContentRecord[]>()
    for (const record of records) {
      const date =
        record.wechatStatus === '已正式发布'
          ? record.wechatPublishedDate
          : record.wechatStatus === '已发送公众号草稿箱'
            ? record.wechatDraftDate
            : record.draftDate || record.createdDate
      if (!date) continue
      const list = events.get(date) ?? []
      list.push(record)
      events.set(date, list)
    }
    for (let index = 0; index < cells; index++) {
      const day = index - firstWeekday + 1
      const cell = grid.createDiv({ cls: 'ai-linzi-dashboard-calendar-day' })
      if (day < 1 || day > days) {
        cell.addClass('is-empty')
        continue
      }
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      cell.createDiv({ text: String(day), cls: 'ai-linzi-dashboard-calendar-number' })
      const dayEvents = events.get(date) ?? []
      for (const record of dayEvents.slice(0, 3)) {
        const statusClass =
          record.wechatStatus === '已正式发布'
            ? 'is-published'
            : record.wechatStatus === '已发送公众号草稿箱'
              ? 'is-draftbox'
              : 'is-draft'
        const event = cell.createEl('button', {
          text: record.title,
          cls: `ai-linzi-dashboard-calendar-event ${statusClass}`,
          attr: { title: record.title },
        })
        event.onclick = () => void this.openRecord(record)
      }
      if (dayEvents.length > 3) cell.createDiv({ text: `+${dayEvents.length - 3}`, cls: 'ai-linzi-dashboard-more' })
    }
  }
}

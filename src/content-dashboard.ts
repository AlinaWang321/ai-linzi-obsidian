import { ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf, normalizePath } from 'obsidian'
import type AiLinziPlugin from './main'
import { chooseComputerAiImageReferences, runDistribute, runTopicRadar, runWechatWriter } from './actions'
import {
  aggregateContentRecords,
  consecutivePublishDays,
  deriveContentRecord,
  isDashboardContentPath,
  isDateInRange,
  parseLocalDate,
  pipelineLane,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  type ContentRecord,
  type DistributionStage,
  type PipelineLane,
  type PlatformId,
  type PlatformState,
} from './content-state'

export const VIEW_TYPE_CONTENT_DASHBOARD = 'ai-linzi-content-dashboard'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const PLATFORM_ICONS: Record<PlatformId, string> = { wechat: '公', xiaohongshu: '红', shipinhao: '视', douyin: '抖' }

type DashboardMode = 'matrix' | 'pipeline' | 'data'

interface PlatformMetrics {
  id: PlatformId
  label: string
  handle: string
  followers: number
  monthGrowth: number
  averageViews: number
  monthlyPublished: number
  lastUpdated: string
  history: number[]
}

interface DashboardData {
  accounts: Record<string, unknown>
  updatedAt: string
}

interface RecognizedAccountMetrics {
  handle?: unknown
  followers?: unknown
  monthGrowth?: unknown
  averageViews?: unknown
  history?: unknown
}

function isoToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shortDate(value: string): string {
  return value ? value.slice(5).replace('-', '/') : '未记录'
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const normalized = value.replace(/[,，\s]/g, '')
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function numberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(numberValue).filter((item) => item >= 0).slice(-12)
  if (typeof value === 'string') return value.split(/[，,]/).map(numberValue).filter((item) => item >= 0).slice(-12)
  return []
}

function formatNumber(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`
  return value.toLocaleString('zh-CN')
}

function recognizedAccountMetrics(raw: string, current: PlatformMetrics): PlatformMetrics {
  const match = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/)
  if (!match) throw new Error('没有识别到可确认的数据，请换一张更清晰的平台后台截图')
  let parsed: RecognizedAccountMetrics
  try {
    parsed = JSON.parse(match[0]) as RecognizedAccountMetrics
  } catch {
    throw new Error('截图数据识别结果不完整，请重试或手动记录')
  }
  return {
    ...current,
    handle: text(parsed.handle) || current.handle,
    followers: numberValue(parsed.followers),
    monthGrowth: numberValue(parsed.monthGrowth),
    averageViews: numberValue(parsed.averageViews),
    history: numberList(parsed.history),
    lastUpdated: isoToday(),
  }
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
  const records = plugin.app.vault
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
  return aggregateContentRecords(records)
}

function pipelineDate(record: ContentRecord): string {
  const published = PLATFORM_IDS.map((id) => record.platforms[id].publishedDate).filter(Boolean).sort().at(-1)
  return published || record.draftDate || record.createdDate
}

function stageLabel(platform: PlatformState): string {
  if (platform.stage === 'published') return `✅ ${shortDate(platform.publishedDate)}`
  if (platform.stage === 'ready') return '⏳ 待发布'
  if (platform.stage === 'planned') return '＋ 计划'
  if (platform.stage === 'not-applicable') return '–'
  return '＋ 计划'
}

function stageClass(stage: DistributionStage): string {
  if (stage === 'published') return 'is-published'
  if (stage === 'ready') return 'is-ready'
  if (stage === 'planned') return 'is-planned'
  if (stage === 'not-applicable') return 'is-not-applicable'
  return 'is-unplanned'
}

function stageToStoredStatus(platform: PlatformId, stage: DistributionStage): string {
  if (stage === 'not-applicable') return '不适用'
  if (stage === 'unplanned') return '未开始'
  if (stage === 'planned') return '计划中'
  if (platform === 'wechat') return stage === 'published' ? '已正式发布' : '已生成草稿'
  if (platform === 'xiaohongshu') return stage === 'published' ? '小红书已发布' : '已生成小红书图文'
  if (platform === 'shipinhao') return stage === 'published' ? '视频已发布' : '已生成视频'
  return stage === 'published' ? '抖音已发布' : '已生成抖音内容'
}

function statusField(platform: PlatformId): string {
  return platform === 'wechat' ? '公众号状态' : platform === 'xiaohongshu' ? '小红书状态' : platform === 'shipinhao' ? '视频号状态' : '抖音状态'
}

function generatedDateField(platform: PlatformId): string {
  return platform === 'wechat' ? '草稿日期' : `${PLATFORM_LABELS[platform]}生成时间`
}

function publishedDateField(platform: PlatformId): string {
  return `${PLATFORM_LABELS[platform]}发布日期`
}

function urlField(platform: PlatformId): string {
  return `${PLATFORM_LABELS[platform]}链接`
}

class PlatformStatusModal extends Modal {
  private submitted = false
  private resolve!: (value: { stage: DistributionStage; date: string; url: string } | null) => void
  readonly result: Promise<{ stage: DistributionStage; date: string; url: string } | null>

  constructor(
    app: AiLinziPlugin['app'],
    private platform: PlatformId,
    private current: PlatformState,
  ) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  onOpen() {
    this.titleEl.setText(`修改${PLATFORM_LABELS[this.platform]}状态`)
    let stage: DistributionStage = this.current.stage === 'not-applicable' ? 'not-applicable' : this.current.stage
    let date = this.current.publishedDate || this.current.generatedDate || isoToday()
    let url = this.current.url
    this.contentEl.createEl('p', {
      text: '这里只记录本地进度，不会替你自动发布到平台。标记已发布时可填写日期和链接。',
      cls: 'setting-item-description',
    })
    new Setting(this.contentEl).setName('分发状态').addDropdown((input) =>
      input
        .addOption('unplanned', '未计划')
        .addOption('planned', '计划分发')
        .addOption('ready', '待发布（内容已完成）')
        .addOption('published', '已发布')
        .addOption('not-applicable', '不适用')
        .setValue(stage)
        .onChange((value) => (stage = value as DistributionStage)),
    )
    new Setting(this.contentEl)
      .setName('状态日期')
      .setDesc('待发布或已发布时使用')
      .addText((input) => input.setPlaceholder('YYYY-MM-DD').setValue(date).onChange((value) => (date = value.trim())))
    new Setting(this.contentEl)
      .setName('发布链接（选填）')
      .addText((input) => {
        input.setPlaceholder('https://...').setValue(url).onChange((value) => (url = value.trim()))
        input.inputEl.addClass('ai-linzi-full-width')
      })
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('保存状态')
          .setCta()
          .onClick(() => {
            if ((stage === 'ready' || stage === 'published') && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseLocalDate(date))) {
              new Notice('状态日期请填写为 YYYY-MM-DD')
              return
            }
            if (url && !/^https?:\/\//i.test(url)) {
              new Notice('发布链接需要以 http:// 或 https:// 开头')
              return
            }
            this.submitted = true
            this.resolve({ stage, date, url })
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

class AccountMetricsModal extends Modal {
  private submitted = false
  private resolve!: (value: PlatformMetrics | null) => void
  readonly result: Promise<PlatformMetrics | null>

  constructor(
    app: AiLinziPlugin['app'],
    private metrics: PlatformMetrics,
    private entryMode: 'manual' | 'screenshot' = 'manual',
  ) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  onOpen() {
    this.titleEl.setText(`记录${this.metrics.label}数据`)
    let handle = this.metrics.handle
    let followers = String(this.metrics.followers || '')
    let monthGrowth = String(this.metrics.monthGrowth || '')
    let averageViews = String(this.metrics.averageViews || '')
    let history = this.metrics.history.join(', ')
    this.contentEl.createEl('p', {
      text: this.entryMode === 'screenshot'
        ? 'AI霖子已根据你主动选择的截图预填数据。请仔细核对，只有点击“保存数据”后才会写入本地 Vault。'
        : '把平台后台里的数字手动录入这里。数据只保存在本地 Vault。',
      cls: 'setting-item-description',
    })
    const addText = (name: string, value: string, change: (value: string) => void, placeholder = '') => {
      new Setting(this.contentEl).setName(name).addText((input) => input.setPlaceholder(placeholder).setValue(value).onChange((next) => change(next.trim())))
    }
    addText('账号名称', handle, (value) => (handle = value), '例如：Alina霖子')
    addText('当前粉丝', followers, (value) => (followers = value), '8432')
    addText('本月净增', monthGrowth, (value) => (monthGrowth = value), '126')
    addText(this.metrics.id === 'wechat' || this.metrics.id === 'xiaohongshu' ? '平均阅读' : '平均播放', averageViews, (value) => (averageViews = value), '1850')
    addText('近 12 个月粉丝', history, (value) => (history = value), '逗号分隔，最多 12 个数字')
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('保存数据')
          .setCta()
          .onClick(() => {
            this.submitted = true
            this.resolve({
              ...this.metrics,
              handle,
              followers: numberValue(followers),
              monthGrowth: numberValue(monthGrowth),
              averageViews: numberValue(averageViews),
              lastUpdated: isoToday(),
              history: numberList(history),
            })
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

class ContentMetricsModal extends Modal {
  private submitted = false
  private resolve!: (value: { views: number; engagement: number; followersGained: number } | null) => void
  readonly result: Promise<{ views: number; engagement: number; followersGained: number } | null>

  constructor(
    app: AiLinziPlugin['app'],
    private platform: PlatformId,
    current: { views: number; engagement: number; followersGained: number },
  ) {
    super(app)
    this.current = current
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  private current: { views: number; engagement: number; followersGained: number }

  onOpen() {
    this.titleEl.setText(`记录${PLATFORM_LABELS[this.platform]}单篇数据`)
    let views = String(this.current.views || '')
    let engagement = String(this.current.engagement || '')
    let followersGained = String(this.current.followersGained || '')
    const viewLabel = this.platform === 'wechat' || this.platform === 'xiaohongshu' ? '阅读' : '播放'
    new Setting(this.contentEl).setName(`${viewLabel}量`).addText((input) => input.setValue(views).onChange((value) => (views = value.trim())))
    new Setting(this.contentEl).setName('互动（赞藏/点赞等）').addText((input) => input.setValue(engagement).onChange((value) => (engagement = value.trim())))
    new Setting(this.contentEl).setName('涨粉').addText((input) => input.setValue(followersGained).onChange((value) => (followersGained = value.trim())))
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('保存数据')
          .setCta()
          .onClick(() => {
            this.submitted = true
            this.resolve({ views: numberValue(views), engagement: numberValue(engagement), followersGained: numberValue(followersGained) })
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

const PIPELINE_LANES: { id: PipelineLane; label: string; color: string }[] = [
  { id: 'topic', label: '选题库', color: '#8a7e74' },
  { id: 'draft', label: '草稿', color: '#5c7bb0' },
  { id: 'production', label: '制作中', color: '#2e5a8f' },
  { id: 'distribution', label: '分发中', color: '#d4a50c' },
  { id: 'done', label: '已发完', color: '#3db389' },
]

export class ContentDashboardView extends ItemView {
  private mode: DashboardMode = 'matrix'
  private refreshTimer: number | null = null
  private dashboardData: DashboardData = { accounts: {}, updatedAt: '' }

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
    await this.loadDashboardData()
    this.render()
  }

  async onClose() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
  }

  private dataPath(): string {
    return normalizePath(`${this.plugin.settings.outputFolder || 'AI霖子输出'}/内容看板/平台数据.md`)
  }

  private async loadDashboardData() {
    const file = this.app.vault.getAbstractFileByPath(this.dataPath())
    if (!(file instanceof TFile)) return
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}
    this.dashboardData = {
      accounts: typeof fm['平台账号'] === 'object' && fm['平台账号'] ? (fm['平台账号'] as Record<string, unknown>) : {},
      updatedAt: text(fm['更新时间']),
    }
  }

  private async saveAccountMetrics(metrics: PlatformMetrics) {
    const path = this.dataPath()
    const parent = path.split('/').slice(0, -1).join('/')
    if (!this.app.vault.getAbstractFileByPath(parent)) await this.app.vault.createFolder(parent)
    const existing = this.app.vault.getAbstractFileByPath(path)
    const file = existing instanceof TFile
      ? existing
      : await this.app.vault.create(
        path,
        `---\n内容类型: 内容看板数据\n平台账号: {}\n更新时间: ${isoToday()}\n---\n\n# 内容看板平台数据\n\n本文件由 AI霖子内容看板维护。账号指标只保存在本地 Vault。\n`,
      )
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const accounts = typeof fm['平台账号'] === 'object' && fm['平台账号'] ? (fm['平台账号'] as Record<string, unknown>) : {}
      accounts[metrics.id] = {
        账号: metrics.handle,
        粉丝: metrics.followers,
        本月净增: metrics.monthGrowth,
        平均阅读播放: metrics.averageViews,
        近12个月粉丝: metrics.history,
        最后更新: metrics.lastUpdated,
      }
      fm['平台账号'] = accounts
      fm['更新时间'] = isoToday()
    })
    await this.loadDashboardData()
    this.render()
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      void this.loadDashboardData().then(() => this.render())
    }, 350)
  }

  private render() {
    const records = scanContent(this.plugin)
    const root = this.contentEl
    root.empty()
    root.addClass('ai-linzi-dashboard-root')

    const header = root.createDiv({ cls: 'ai-linzi-dashboard-header' })
    const title = header.createDiv({ cls: 'ai-linzi-dashboard-heading' })
    title.createDiv({ text: '✍️ 内容发布看板', cls: 'ai-linzi-dashboard-title' })
    title.createSpan({ text: '全平台版', cls: 'ai-linzi-dashboard-version' })
    title.createEl('p', { text: `数据来源：${normalizePath(this.plugin.settings.outputFolder || 'AI霖子输出')} · 全部保存在本地` })
    const actions = header.createDiv({ cls: 'ai-linzi-dashboard-header-actions' })
    const refresh = actions.createEl('button', { text: '刷新' })
    refresh.onclick = () => void this.loadDashboardData().then(() => this.render())
    const newTopic = actions.createEl('button', { text: '✨ 生成选题', cls: 'mod-cta' })
    newTopic.onclick = () => void runTopicRadar(this.plugin).then(() => this.render())

    const tabs = root.createDiv({ cls: 'ai-linzi-dashboard-tabs' })
    for (const [id, label] of [
      ['matrix', '发布矩阵'],
      ['pipeline', '创作管线'],
      ['data', '数据分析'],
    ] as const) {
      const tab = tabs.createEl('button', { text: label })
      tab.toggleClass('is-active', this.mode === id)
      tab.onclick = () => {
        this.mode = id
        this.render()
      }
    }

    if (this.mode === 'matrix') this.renderMatrix(root, records)
    else if (this.mode === 'pipeline') this.renderPipeline(root, records)
    else this.renderData(root, records)

    const footer = root.createDiv({ cls: 'ai-linzi-dashboard-footer' })
    footer.createSpan({ text: '发布状态与数据全部存在笔记 frontmatter（本地）' })
    footer.createSpan({ text: '截图只在你主动选择后发给 AI霖子识别；识别结果须确认才保存' })
  }

  private renderMatrix(root: HTMLElement, records: ContentRecord[]) {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const monthPublishes = records.flatMap((record) => PLATFORM_IDS.map((id) => record.platforms[id].publishedDate)).filter((date) => isDateInRange(date, monthStart, nextMonth)).length
    const distributed = records.filter((record) => PLATFORM_IDS.some((id) => record.platforms[id].stage !== 'unplanned' && record.platforms[id].stage !== 'not-applicable'))
    const average = distributed.length === 0 ? 0 : distributed.reduce((sum, record) => sum + PLATFORM_IDS.filter((id) => record.platforms[id].stage === 'ready' || record.platforms[id].stage === 'published').length, 0) / distributed.length
    const waiting = records.filter((record) => {
      const states = PLATFORM_IDS.map((id) => record.platforms[id].stage)
      return states.includes('published') && (states.includes('ready') || states.includes('planned'))
    }).length
    this.renderStats(root, [
      { value: String(monthPublishes), label: '本月发布次数（全平台）', note: '每个平台各算 1 次' },
      { value: average.toFixed(average % 1 ? 1 : 0), label: '平均分发平台数 / 篇', note: '一鱼多吃指数', tone: 'jade' },
      { value: String(waiting), label: '待分发', note: '已发过 1 个平台的增量', tone: 'gold' },
      { value: `${consecutivePublishDays(records)} 天`, label: '连续发布', note: '跨平台任一发布都算' },
    ])

    const card = root.createDiv({ cls: 'ai-linzi-dashboard-panel ai-linzi-dashboard-matrix-panel' })
    this.sectionHeading(card, '发布矩阵', '每篇内容 × 每个平台的分发状态 · 点格子改状态')
    if (records.length === 0) {
      this.empty(card, '还没有内容资产。先生成一个选题或公众号草稿，矩阵会自动出现。')
      return
    }
    const scroll = card.createDiv({ cls: 'ai-linzi-dashboard-table-scroll' })
    const table = scroll.createEl('table', { cls: 'ai-linzi-dashboard-matrix' })
    const head = table.createEl('thead').createEl('tr')
    head.createEl('th', { text: '内容' })
    for (const id of PLATFORM_IDS) {
      const th = head.createEl('th')
      this.platformIcon(th, id)
      th.createSpan({ text: PLATFORM_LABELS[id] })
    }
    const body = table.createEl('tbody')
    for (const record of records) {
      const row = body.createEl('tr')
      const content = row.createEl('td')
      const title = content.createEl('button', { text: record.title, cls: 'ai-linzi-dashboard-matrix-title' })
      title.onclick = () => void this.openRecord(record)
      content.createDiv({ text: `创建 ${shortDate(record.createdDate)} · 来源：${record.sourceSkill}`, cls: 'ai-linzi-dashboard-matrix-meta' })
      for (const id of PLATFORM_IDS) {
        const cell = row.createEl('td')
        const platform = record.platforms[id]
        const chip = cell.createEl('button', {
          text: stageLabel(platform),
          cls: `ai-linzi-dashboard-status-chip ${stageClass(platform.stage)}`,
          attr: { title: `修改${PLATFORM_LABELS[id]}状态` },
        })
        chip.onclick = () => void this.updatePlatformStatus(record, id, chip)
        if (platform.stage === 'published') {
          const metrics = cell.createEl('button', {
            text: platform.views || platform.engagement || platform.followersGained ? '数据 ✓' : '＋ 数据',
            cls: 'ai-linzi-dashboard-metrics-link',
            attr: { title: `记录${PLATFORM_LABELS[id]}单篇表现` },
          })
          metrics.onclick = () => void this.editContentMetrics(record, id, metrics)
        }
      }
    }
    const legend = card.createDiv({ cls: 'ai-linzi-dashboard-legend' })
    for (const label of ['✅ 已发布（记录日期，可填链接）', '⏳ 待发布（改写完成）', '＋ 计划（准备分发）', '– 不适用']) legend.createSpan({ text: label })

    const hint = root.createDiv({ cls: 'ai-linzi-dashboard-hint' })
    hint.createEl('strong', { text: '💡 「待分发」是最容易捡的增量：' })
    hint.createSpan({ text: `${waiting} 篇内容已在至少一个平台发布，但计划里仍有平台没发。` })
  }

  private renderStats(root: HTMLElement, stats: { value: string; label: string; note: string; tone?: string }[]) {
    const wrapper = root.createDiv({ cls: 'ai-linzi-dashboard-stats' })
    for (const stat of stats) {
      const card = wrapper.createDiv({ cls: 'ai-linzi-dashboard-stat' })
      card.createDiv({ text: stat.value, cls: `ai-linzi-dashboard-stat-number${stat.tone ? ` is-${stat.tone}` : ''}` })
      card.createDiv({ text: stat.label, cls: 'ai-linzi-dashboard-stat-label' })
      card.createDiv({ text: stat.note, cls: 'ai-linzi-dashboard-stat-note' })
    }
  }

  private renderPipeline(root: HTMLElement, records: ContentRecord[]) {
    const heading = root.createDiv({ cls: 'ai-linzi-dashboard-section-heading is-open' })
    heading.createEl('h3', { text: '创作管线' })
    heading.createSpan({ text: '从选题到全平台发完 · 卡片下方是各平台分发状态' })
    const board = root.createDiv({ cls: 'ai-linzi-dashboard-pipeline' })
    for (const lane of PIPELINE_LANES) {
      const laneRecords = records.filter((record) => pipelineLane(record) === lane.id)
      const column = board.createDiv({ cls: `ai-linzi-dashboard-pipeline-lane is-${lane.id}` })
      const header = column.createDiv({ cls: 'ai-linzi-dashboard-pipeline-head' })
      const dot = header.createSpan({ cls: 'ai-linzi-dashboard-pipeline-dot' })
      dot.style.backgroundColor = lane.color
      header.createSpan({ text: lane.label })
      header.createSpan({ text: String(laneRecords.length), cls: 'ai-linzi-dashboard-pipeline-count' })
      if (lane.id === 'topic') {
        const add = header.createEl('button', { text: '＋ 选题', cls: 'ai-linzi-dashboard-pipeline-add' })
        add.onclick = () => void runTopicRadar(this.plugin).then(() => this.render())
      }
      const list = column.createDiv({ cls: 'ai-linzi-dashboard-pipeline-list' })
      if (laneRecords.length === 0) this.empty(list, '暂无内容')
      for (const record of laneRecords) this.renderPipelineCard(list, record, lane.id)
    }
    const legend = root.createDiv({ cls: 'ai-linzi-dashboard-legend' })
    legend.createSpan({ text: '平台角标：亮色＝已发布 · 虚线框＝待发布 · 灰色＝未计划' })
    legend.createSpan({ text: '「分发中」＝至少发了 1 个平台，但计划里还有没发的' })
  }

  private renderPipelineCard(parent: HTMLElement, record: ContentRecord, lane: PipelineLane) {
    const card = parent.createDiv({ cls: 'ai-linzi-dashboard-pipeline-card' })
    card.setAttribute('tabindex', '0')
    card.setAttribute('role', 'button')
    card.onclick = () => void this.openRecord(record)
    card.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') void this.openRecord(record)
    }
    card.createDiv({ text: record.title, cls: 'ai-linzi-dashboard-pipeline-title' })
    card.createDiv({ text: `${shortDate(pipelineDate(record))} · ${record.sourceSkill}`, cls: 'ai-linzi-dashboard-pipeline-meta' })
    const platforms = card.createDiv({ cls: 'ai-linzi-dashboard-pipeline-platforms' })
    for (const id of PLATFORM_IDS) {
      const platform = record.platforms[id]
      const button = platforms.createEl('button', {
        text: PLATFORM_ICONS[id],
        cls: `ai-linzi-dashboard-platform-dot is-${id} ${stageClass(platform.stage)}`,
        attr: { title: `${PLATFORM_LABELS[id]}：${stageLabel(platform)}` },
      })
      button.onclick = (event) => {
        event.stopPropagation()
        void this.updatePlatformStatus(record, id, button)
      }
    }
    const actions = card.createDiv({ cls: 'ai-linzi-dashboard-pipeline-actions' })
    if (lane === 'topic') {
      const write = actions.createEl('button', { text: '开始写作' })
      write.onclick = (event) => {
        event.stopPropagation()
        void this.runRecordAction(record, () => runWechatWriter(this.plugin), write)
      }
    } else if (record.kind === '公众号文章' && record.platforms.xiaohongshu.stage === 'unplanned') {
      const distribute = actions.createEl('button', { text: '生成分发包' })
      distribute.onclick = (event) => {
        event.stopPropagation()
        void this.runRecordAction(record, () => runDistribute(this.plugin), distribute)
      }
    }
  }

  private renderData(root: HTMLElement, records: ContentRecord[]) {
    const hint = root.createDiv({ cls: 'ai-linzi-dashboard-hint' })
    hint.createEl('strong', { text: '📷 数据怎么进来：' })
    hint.createSpan({ text: '各平台不对个人号开放完整数据 API。你可主动选择后台截图交给 AI霖子识别，核对后再保存；保存的指标只存在本地 Vault。' })
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const metrics = PLATFORM_IDS.map((id) => this.platformMetrics(id, records, monthStart, nextMonth))
    const grid = root.createDiv({ cls: 'ai-linzi-dashboard-account-grid' })
    for (const item of metrics) this.renderAccount(grid, item)
    this.renderFollowersChart(root, metrics)
    this.renderTopContent(root, records)
  }

  private platformMetrics(id: PlatformId, records: ContentRecord[], monthStart: Date, nextMonth: Date): PlatformMetrics {
    const raw = this.dashboardData.accounts[id]
    const account = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {}
    return {
      id,
      label: PLATFORM_LABELS[id],
      handle: text(account['账号']),
      followers: numberValue(account['粉丝']),
      monthGrowth: numberValue(account['本月净增']),
      averageViews: numberValue(account['平均阅读播放']),
      monthlyPublished: records.filter((record) => isDateInRange(record.platforms[id].publishedDate, monthStart, nextMonth)).length,
      lastUpdated: text(account['最后更新']),
      history: numberList(account['近12个月粉丝']),
    }
  }

  private renderAccount(parent: HTMLElement, metrics: PlatformMetrics) {
    const card = parent.createDiv({ cls: 'ai-linzi-dashboard-account' })
    const header = card.createDiv({ cls: 'ai-linzi-dashboard-account-head' })
    this.platformIcon(header, metrics.id)
    header.createSpan({ text: metrics.label, cls: 'ai-linzi-dashboard-account-name' })
    header.createSpan({ text: metrics.handle || '未设置账号', cls: 'ai-linzi-dashboard-account-handle' })
    header.createSpan({ text: metrics.lastUpdated ? `本地记录 · ${shortDate(metrics.lastUpdated)}` : '待首次记录', cls: 'ai-linzi-dashboard-account-sync' })
    const stats = card.createDiv({ cls: 'ai-linzi-dashboard-account-stats' })
    for (const [value, label, tone] of [
      [formatNumber(metrics.followers), '粉丝', ''],
      [`${metrics.monthGrowth >= 0 ? '+' : ''}${formatNumber(metrics.monthGrowth)}`, '本月净增', 'jade'],
      [formatNumber(metrics.averageViews), metrics.id === 'wechat' || metrics.id === 'xiaohongshu' ? '平均阅读' : '平均播放', ''],
      [String(metrics.monthlyPublished), '本月发布', ''],
    ]) {
      const stat = stats.createDiv()
      stat.createDiv({ text: value, cls: `ai-linzi-dashboard-account-number${tone ? ` is-${tone}` : ''}` })
      stat.createDiv({ text: label, cls: 'ai-linzi-dashboard-account-label' })
    }
    const trend = card.createDiv({ cls: 'ai-linzi-dashboard-mini-trend' })
    const source = metrics.history.length > 1 ? metrics.history : [0, metrics.followers]
    const max = Math.max(...source, 1)
    for (const [index, value] of source.entries()) {
      const bar = trend.createDiv({ cls: `ai-linzi-dashboard-mini-bar${index === source.length - 1 ? ' is-latest' : ''}` })
      bar.style.height = `${Math.max(10, (value / max) * 100)}%`
    }
    const actions = card.createDiv({ cls: 'ai-linzi-dashboard-account-actions' })
    const manual = actions.createEl('button', { text: '✏️ 手动记录', cls: 'is-primary' })
    manual.onclick = () => void this.editAccount(metrics)
    const screenshot = actions.createEl('button', { text: '📷 截图导入数据' })
    screenshot.onclick = () => void this.importAccountScreenshot(metrics)
  }

  private renderFollowersChart(root: HTMLElement, metrics: PlatformMetrics[]) {
    const panel = root.createDiv({ cls: 'ai-linzi-dashboard-panel' })
    this.sectionHeading(panel, '📈 公域粉丝增长', '近 12 个月各平台粉丝数 · 来自本地手动记录')
    if (!metrics.some((item) => item.history.length > 1)) {
      this.empty(panel, '记录至少两个月的平台粉丝数后，这里会出现增长趋势。')
      return
    }
    const chart = panel.createDiv({ cls: 'ai-linzi-dashboard-growth-chart' })
    for (const item of metrics) {
      if (item.history.length === 0) continue
      const row = chart.createDiv({ cls: 'ai-linzi-dashboard-growth-row' })
      const label = row.createDiv({ cls: 'ai-linzi-dashboard-growth-label' })
      this.platformIcon(label, item.id)
      label.createSpan({ text: `${item.label} ${formatNumber(item.followers)}` })
      const bars = row.createDiv({ cls: 'ai-linzi-dashboard-growth-bars' })
      const max = Math.max(...item.history, 1)
      for (const value of item.history) {
        const bar = bars.createDiv({ cls: `ai-linzi-dashboard-growth-bar is-${item.id}` })
        bar.style.height = `${Math.max(4, (value / max) * 100)}%`
        bar.title = formatNumber(value)
      }
    }
  }

  private renderTopContent(root: HTMLElement, records: ContentRecord[]) {
    const rows = records
      .flatMap((record) => PLATFORM_IDS.map((id) => ({ record, id, state: record.platforms[id], score: record.platforms[id].views + record.platforms[id].engagement * 10 + record.platforms[id].followersGained * 20 })))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
    const panel = root.createDiv({ cls: 'ai-linzi-dashboard-panel' })
    this.sectionHeading(panel, '🏆 本月内容 Top', '跨平台按阅读/播放、互动和涨粉综合排序')
    if (rows.length === 0) {
      this.empty(panel, '在内容笔记 frontmatter 记录平台阅读/播放、互动或涨粉后，这里会自动排行。')
      return
    }
    const list = panel.createDiv({ cls: 'ai-linzi-dashboard-top-list' })
    rows.forEach((row, index) => {
      const item = list.createDiv({ cls: 'ai-linzi-dashboard-top-row' })
      item.createSpan({ text: String(index + 1), cls: 'ai-linzi-dashboard-top-rank' })
      this.platformIcon(item, row.id)
      const title = item.createEl('button', { text: row.record.title, cls: 'ai-linzi-dashboard-top-title' })
      title.onclick = () => void this.openRecord(row.record)
      item.createSpan({ text: `${row.id === 'wechat' || row.id === 'xiaohongshu' ? '阅读' : '播放'} ${formatNumber(row.state.views)} · 互动 ${formatNumber(row.state.engagement)} · 涨粉 ${formatNumber(row.state.followersGained)}`, cls: 'ai-linzi-dashboard-top-metrics' })
    })
  }

  private sectionHeading(parent: HTMLElement, title: string, caption: string) {
    const heading = parent.createDiv({ cls: 'ai-linzi-dashboard-section-heading' })
    heading.createEl('h3', { text: title })
    heading.createSpan({ text: caption })
  }

  private platformIcon(parent: HTMLElement, id: PlatformId) {
    parent.createSpan({ text: PLATFORM_ICONS[id], cls: `ai-linzi-dashboard-platform-icon is-${id}` })
  }

  private empty(parent: HTMLElement, message: string) {
    parent.createDiv({ text: message, cls: 'ai-linzi-dashboard-empty' })
  }

  private async editAccount(metrics: PlatformMetrics) {
    const result = await new AccountMetricsModal(this.app, metrics).result
    if (!result) return
    await this.saveAccountMetrics(result)
    new Notice(`✅ ${metrics.label}数据已保存到本地 Vault`)
  }

  private async importAccountScreenshot(metrics: PlatformMetrics) {
    chooseComputerAiImageReferences(1, async (references) => {
      const image = references[0]
      if (!image) return
      const notice = new Notice(`正在识别${metrics.label}后台数据…`, 0)
      try {
        const prompt = [
          `请识别这张${metrics.label}账号后台截图中的账号数据。`,
          '只返回一个 JSON 对象，不要解释、不要 Markdown。',
          '字段必须是：{"handle":"账号名称","followers":当前粉丝,"monthGrowth":本月净增,"averageViews":平均阅读或播放,"history":[近12个月粉丝数]}。',
          '只填写截图中能确认的数字；无法确认的数字填 0，数组可以为空。',
        ].join('\n')
        const sessionId = `obsidian:content-dashboard:${Date.now()}`
        const data = await this.plugin.api('/api/plugin/v1/chat', {
          method: 'POST',
          body: {
            messages: [{ id: `content-metrics-${Date.now()}`, role: 'user', parts: [{ type: 'text', text: prompt }] }],
            sessionId,
            stream: false,
            imageAttachments: [{ filename: image.name, dataUrl: image.dataUrl, mediaType: 'image/jpeg' }],
            noteEdit: false,
            noteImageIntent: false,
          },
        })
        const raw = typeof data.text === 'string' ? data.text : ''
        await this.plugin.api(`/api/plugin/v1/chat/history?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => undefined)
        const recognized = recognizedAccountMetrics(raw, metrics)
        notice.hide()
        const result = await new AccountMetricsModal(this.app, recognized, 'screenshot').result
        if (!result) return
        await this.saveAccountMetrics(result)
        new Notice(`✅ ${metrics.label}识别数据已确认并保存到本地 Vault`)
      } catch (error) {
        notice.hide()
        new Notice(error instanceof Error ? error.message : '截图识别失败，请稍后重试')
      }
    })
  }

  private async editContentMetrics(record: ContentRecord, platform: PlatformId, button: HTMLButtonElement) {
    const result = await new ContentMetricsModal(this.app, platform, record.platforms[platform]).result
    if (!result) return
    const file = this.app.vault.getAbstractFileByPath(record.filePath)
    if (!(file instanceof TFile)) {
      new Notice('这篇内容的笔记已经不存在')
      return
    }
    button.disabled = true
    try {
      const label = PLATFORM_LABELS[platform]
      const viewLabel = platform === 'wechat' || platform === 'xiaohongshu' ? '阅读' : '播放'
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        fm[`${label}${viewLabel}`] = result.views
        fm[`${label}互动`] = result.engagement
        fm[`${label}涨粉`] = result.followersGained
      })
      new Notice(`✅ ${label}单篇数据已保存到本地笔记`)
      this.render()
    } finally {
      button.disabled = false
    }
  }

  private async updatePlatformStatus(record: ContentRecord, platform: PlatformId, button: HTMLButtonElement) {
    const result = await new PlatformStatusModal(this.app, platform, record.platforms[platform]).result
    if (!result) return
    const file = this.app.vault.getAbstractFileByPath(record.filePath)
    if (!(file instanceof TFile)) {
      new Notice('这篇内容的笔记已经不存在')
      return
    }
    button.disabled = true
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        fm[statusField(platform)] = stageToStoredStatus(platform, result.stage)
        if (platform === 'shipinhao') fm['视频状态'] = stageToStoredStatus(platform, result.stage)
        if (result.stage === 'ready') {
          fm[generatedDateField(platform)] = result.date
          delete fm[publishedDateField(platform)]
        } else if (result.stage === 'published') {
          fm[publishedDateField(platform)] = result.date
          if (result.url) fm[urlField(platform)] = result.url
          else delete fm[urlField(platform)]
          if (platform === 'wechat') {
            fm['状态'] = '已正式发布'
            fm['发布日期'] = result.date
            if (result.url) fm['发布链接'] = result.url
          }
        } else {
          delete fm[publishedDateField(platform)]
          delete fm[urlField(platform)]
        }
      })
      new Notice(`✅ ${PLATFORM_LABELS[platform]}状态已更新；不会自动发布到平台`)
      this.render()
    } finally {
      button.disabled = false
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
}

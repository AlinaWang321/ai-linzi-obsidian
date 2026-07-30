/**
 * 一人公司驾驶舱(v0.6.35,2026-07-30 Alina 拍板)
 *
 * 通用模版看板:AI霖子今日判断(气泡) + 经营循环带 + 获客/销售/交付三泳道 + 任务/日历/第二大脑。
 * 数据双来源,卡片角标标注:
 * - 🏠 本地:vault 扫描(文件事件防抖自动刷新,永不上传)——第二大脑/日历/内容管线/本周发布
 * - ☁️ 云端:/api/plugin/v1/dashboard(打开时+手动刷新,30 分钟缓存;纯读不扣积分)——CRM/任务/积分
 * 「今天的判断」由服务端 Flash 生成(免费),按 serverDate 当日缓存在设置里,跨天才重新请求。
 * 设计稿真相源:Obsidian大脑 04_Output/方案文档/2026.07.30_一人公司驾驶舱_设计稿.html(v0.3)。
 */
import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath } from 'obsidian'
import type AiLinziPlugin from './main'
import { boardLane, deriveContentRecord, isDashboardContentPath, type ContentRecord } from './content-state'

export const VIEW_TYPE_COCKPIT = 'ai-linzi-cockpit'

const CLOUD_TTL_MS = 30 * 60_000

// ── 云端返回类型(与 /api/plugin/v1/dashboard 对齐) ──
interface CloudTask {
  id: number
  title: string
  status: 'pending' | 'done' | 'gave_up'
  period: 'week' | 'month' | 'quarter'
  source: string
}
interface CloudCrm {
  thisMonth: { new: number; consults: number; deals: number; amount: number }
  lastMonth: { new: number; consults: number; deals: number; amount: number }
  stageCounts: Record<string, number>
  channelCounts: Record<string, number>
  stageLabels: { key: string; label: string }[]
  ytdAmount: number
  lifetimeAmount: number
  todos: { open: number; overdue: number; items: { content: string; customerName: string; dueDate: string | null; overdue: boolean }[] }
  silent: { count: number; thresholdDays: number; items: { name: string; stage: string; days: number }[] }
  upcomingConsults7d: number
}
interface CloudDashboard {
  ok: boolean
  serverDate: string
  tier: string
  balance: number
  crm: CloudCrm | null
  crmReason: string | null
  tasks: CloudTask[]
  judgment: { text: string; date: string } | null
}

// ── 本地扫描 ──
interface LocalStats {
  totalNotes: number
  weekNew: number
  folders: { key: string; icon: string; name: string; path: string; count: number }[]
  inboxOldest: { file: TFile; days: number }[]
  inboxCount: number
  /** 日期(YYYY-MM-DD) → 当天有记录/发布 */
  noteDays: Set<string>
  publishDays: Set<string>
  weekPublished: number
  streak: number
  pipeline: { topic: number; draft: number; ready: number; monthPublished: number }
}

function localDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function startOfWeekMs(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekday = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - weekday)
  return d.getTime()
}

function inFolder(path: string, folder: string): boolean {
  if (!folder) return false
  const prefix = normalizePath(folder)
  return path === prefix || path.startsWith(prefix + '/')
}

export function scanLocalStats(plugin: AiLinziPlugin): LocalStats {
  const now = new Date()
  const weekStart = startOfWeekMs(now)
  const monthPrefix = localDate(now.getTime()).slice(0, 7)
  const files = plugin.app.vault.getMarkdownFiles()
  const { cockpitInboxFolder, cockpitSourcesFolder, cockpitKnowledgeFolder, outputFolder } = plugin.settings

  const folders = [
    { key: 'inbox', icon: '📥', name: '收件箱', path: normalizePath(cockpitInboxFolder || ''), count: 0 },
    { key: 'sources', icon: '🎙', name: '原始素材', path: normalizePath(cockpitSourcesFolder || ''), count: 0 },
    { key: 'knowledge', icon: '📚', name: '知识库', path: normalizePath(cockpitKnowledgeFolder || ''), count: 0 },
    { key: 'output', icon: '🚀', name: '对外输出', path: normalizePath(outputFolder || ''), count: 0 },
  ]

  const noteDays = new Set<string>()
  const publishDays = new Set<string>()
  const inboxFiles: { file: TFile; days: number }[] = []
  let weekNew = 0
  let weekPublished = 0
  const outputRoot = normalizePath(outputFolder || 'AI霖子输出')
  const records: ContentRecord[] = []

  for (const file of files) {
    noteDays.add(localDate(file.stat.ctime))
    if (file.stat.ctime >= weekStart) weekNew++
    for (const folder of folders) {
      if (folder.path && inFolder(file.path, folder.path)) folder.count++
    }
    if (folders[0].path && inFolder(file.path, folders[0].path)) {
      inboxFiles.push({ file, days: Math.floor((Date.now() - file.stat.ctime) / 86400_000) })
    }
    if (isDashboardContentPath(file.path, outputRoot)) {
      const cache = plugin.app.metadataCache.getFileCache(file)
      const record = deriveContentRecord({
        path: file.path,
        basename: file.basename,
        frontmatter: cache?.frontmatter ?? null,
        createdAt: file.stat.ctime,
        modifiedAt: file.stat.mtime,
        hasLocalImages: false,
      })
      if (record) records.push(record)
    }
  }

  const pipeline = { topic: 0, draft: 0, ready: 0, monthPublished: 0 }
  for (const record of records) {
    const lane = boardLane(record)
    if (lane === 'topic') pipeline.topic++
    else if (lane === 'write' || lane === 'format') pipeline.draft++
    else if (lane === 'draftbox') pipeline.ready++
    if (record.wechatPublishedDate) {
      publishDays.add(record.wechatPublishedDate)
      if (record.wechatPublishedDate.startsWith(monthPrefix)) pipeline.monthPublished++
      const published = new Date(record.wechatPublishedDate + 'T00:00:00').getTime()
      if (!Number.isNaN(published) && published >= weekStart) weekPublished++
    }
  }

  let streak = 0
  for (let i = 0; ; i++) {
    const day = localDate(Date.now() - i * 86400_000)
    if (noteDays.has(day)) streak++
    else if (i === 0) continue // 今天还没记,不打断连续记录
    else break
    if (i > 400) break
  }

  inboxFiles.sort((a, b) => b.days - a.days)
  return {
    totalNotes: files.length,
    weekNew,
    folders,
    inboxOldest: inboxFiles.slice(0, 3),
    inboxCount: inboxFiles.length,
    noteDays,
    publishDays,
    weekPublished,
    streak,
    pipeline,
  }
}

function fmtAmount(cny: number): string {
  if (cny >= 10000) return `¥${(cny / 10000).toFixed(cny >= 1_000_000 ? 0 : 1)}万`
  return `¥${cny.toLocaleString('zh-CN')}`
}

const TASK_SOURCE_LABEL: Record<string, string> = {
  private_coach: '私教',
  self_plan: '自建',
  manual: '自建',
  manager: '团队',
}

export class CockpitView extends ItemView {
  private cloud: CloudDashboard | null = null
  private cloudFetchedAt = 0
  private cloudError = ''
  private loading = false
  private taskTab: 'week' | 'month' | 'quarter' = 'week'
  private month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  private refreshTimer: number | null = null

  constructor(leaf: WorkspaceLeaf, private plugin: AiLinziPlugin) {
    super(leaf)
  }

  getViewType() {
    return VIEW_TYPE_COCKPIT
  }

  getDisplayText() {
    return '一人公司驾驶舱'
  }

  getIcon() {
    return 'gauge'
  }

  async onOpen() {
    const schedule = () => this.scheduleLocalRefresh()
    this.registerEvent(this.app.vault.on('create', schedule))
    this.registerEvent(this.app.vault.on('modify', schedule))
    this.registerEvent(this.app.vault.on('delete', schedule))
    this.render()
    void this.refreshCloud(false)
  }

  async onClose() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
  }

  private scheduleLocalRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      this.render()
    }, 400)
  }

  /** 云端拉取:默认走 30 分钟缓存;force=手动刷新。判断句只在跨天(或强制)时带 judgment=1 */
  private async refreshCloud(force: boolean) {
    if (this.loading) return
    if (!force && this.cloud && Date.now() - this.cloudFetchedAt < CLOUD_TTL_MS) return
    if (!this.plugin.getApiToken()) {
      this.cloudError = 'not-connected'
      this.render()
      return
    }
    this.loading = true
    this.render()
    try {
      const today = localDate(Date.now())
      const needJudgment = force || this.plugin.settings.cockpitJudgmentDate !== today
      const data = (await this.plugin.api(
        `/api/plugin/v1/dashboard${needJudgment ? '?judgment=1' : ''}`,
      )) as unknown as CloudDashboard
      this.cloud = data
      this.cloudFetchedAt = Date.now()
      this.cloudError = ''
      if (data.judgment?.text) {
        this.plugin.settings.cockpitJudgmentDate = data.judgment.date
        this.plugin.settings.cockpitJudgmentText = data.judgment.text
        await this.plugin.saveSettings()
      }
    } catch (e) {
      this.cloudError = e instanceof Error ? e.message : '云端数据加载失败'
    } finally {
      this.loading = false
      this.render()
    }
  }

  private render() {
    const local = scanLocalStats(this.plugin)
    const root = this.contentEl
    root.empty()
    root.addClass('ai-linzi-cockpit-root')

    this.renderHeader(root)
    this.renderJudgment(root)
    this.renderLoop(root, local)
    this.renderLanes(root, local)

    const grid = root.createDiv({ cls: 'ai-linzi-cockpit-grid' })
    this.renderTasks(grid)
    this.renderCalendar(grid, local)
    this.renderBrain(grid, local)

    const foot = root.createDiv({ cls: 'ai-linzi-cockpit-foot' })
    foot.createSpan({ text: '🏠 本地 vault 实时统计(不上传) · ☁️ AI霖子云端(CRM/任务/积分)' })
  }

  private renderHeader(root: HTMLElement) {
    const header = root.createDiv({ cls: 'ai-linzi-cockpit-header' })
    header.createDiv({ cls: 'ai-linzi-cockpit-avatar' })
    const heading = header.createDiv({ cls: 'ai-linzi-cockpit-heading' })
    heading.createDiv({ text: '一人公司驾驶舱', cls: 'ai-linzi-cockpit-title' })
    heading.createDiv({
      text: 'AI霖子帮你盯住每一条线索，也记住你写下的每一步。',
      cls: 'ai-linzi-cockpit-tagline',
    })
    const actions = header.createDiv({ cls: 'ai-linzi-cockpit-header-actions' })
    if (this.cloud) {
      actions.createSpan({ text: `积分 ${this.cloud.balance.toLocaleString('zh-CN')}`, cls: 'ai-linzi-cockpit-pill' })
    }
    const refresh = actions.createEl('button', { text: this.loading ? '刷新中…' : '⟳ 刷新' })
    refresh.disabled = this.loading
    refresh.onclick = () => void this.refreshCloud(true)
  }

  private renderJudgment(root: HTMLElement) {
    const say = root.createDiv({ cls: 'ai-linzi-cockpit-say' })
    say.createDiv({ cls: 'ai-linzi-cockpit-avatar is-small' })
    const bubble = say.createDiv({ cls: 'ai-linzi-cockpit-bubble' })
    bubble.createDiv({ text: 'AI霖子 · 今天的判断', cls: 'ai-linzi-cockpit-kicker' })
    const today = localDate(Date.now())
    const cached =
      this.plugin.settings.cockpitJudgmentDate === today ? this.plugin.settings.cockpitJudgmentText : ''
    const text = this.cloud?.judgment?.text || cached
    if (text) {
      bubble.createDiv({ text, cls: 'ai-linzi-cockpit-judge' })
    } else if (this.loading) {
      bubble.createDiv({ text: '正在为你盘点今天的生意…', cls: 'ai-linzi-cockpit-judge is-muted' })
    } else if (this.cloudError === 'not-connected') {
      bubble.createDiv({
        text: '连接 AI霖子 后，我每天在这里给你一句经营判断。先去插件设置里粘贴连接码吧。',
        cls: 'ai-linzi-cockpit-judge is-muted',
      })
    } else if (this.cloud && !this.cloud.crm) {
      bubble.createDiv({
        text: '开始记录你的客户后，我每天在这里告诉你最该做的一件事。',
        cls: 'ai-linzi-cockpit-judge is-muted',
      })
    } else {
      bubble.createDiv({ text: this.cloudError || '点右上角刷新，看看今天的判断。', cls: 'ai-linzi-cockpit-judge is-muted' })
    }
    const act = bubble.createDiv({ cls: 'ai-linzi-cockpit-bubble-act' })
    const chat = act.createEl('button', { text: '和 AI霖子 聊聊今天怎么打 →', cls: 'mod-cta' })
    chat.onclick = () => void this.plugin.activateChatView()
  }

  private cloudUnavailable(card: HTMLElement, hint: string) {
    if (this.cloudError === 'not-connected') {
      card.createDiv({ text: '未连接 AI霖子。在插件设置里粘贴连接码后，这里会自动亮起来。', cls: 'ai-linzi-cockpit-empty' })
      return true
    }
    if (this.loading && !this.cloud) {
      card.createDiv({ text: '加载中…', cls: 'ai-linzi-cockpit-empty' })
      return true
    }
    if (this.cloudError) {
      card.createDiv({ text: this.cloudError, cls: 'ai-linzi-cockpit-empty' })
      return true
    }
    if (!this.cloud) {
      card.createDiv({ text: '加载中…', cls: 'ai-linzi-cockpit-empty' })
      return true
    }
    if (!this.cloud.crm) {
      card.createDiv({ text: hint, cls: 'ai-linzi-cockpit-empty' })
      return true
    }
    return false
  }

  private renderLoop(root: HTMLElement, local: LocalStats) {
    const card = root.createDiv({ cls: 'ai-linzi-cockpit-card ai-linzi-cockpit-loop' })
    const head = card.createDiv({ cls: 'ai-linzi-cockpit-card-head' })
    head.createSpan({ text: '经营循环', cls: 'ai-linzi-cockpit-card-title' })
    head.createSpan({ text: '从内容到复购，你的生意是一条河', cls: 'ai-linzi-cockpit-card-cap' })
    const crm = this.cloud?.crm
    const flow = card.createDiv({ cls: 'ai-linzi-cockpit-flow' })
    const node = (
      value: string,
      label: string,
      tone: 'sea' | 'jade' | 'gold',
      sub?: string,
    ) => {
      const el = flow.createDiv({ cls: `ai-linzi-cockpit-node is-${tone}` })
      el.createDiv({ text: value, cls: 'ai-linzi-cockpit-node-num' })
      el.createDiv({ text: label, cls: 'ai-linzi-cockpit-node-label' })
      if (sub) el.createDiv({ text: sub, cls: 'ai-linzi-cockpit-node-sub' })
    }
    node(String(local.weekPublished), '本周发布 🏠', 'sea')
    if (crm) {
      const delta = crm.thisMonth.new - crm.lastMonth.new
      node(String(crm.thisMonth.new), '本月新增线索', 'sea', delta === 0 ? '与上月持平' : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)} vs 上月`)
      node(String(crm.thisMonth.consults), '本月咨询', 'jade')
      node(`${crm.thisMonth.deals} 单`, '本月成交', 'jade', fmtAmount(crm.thisMonth.amount))
      node(String(crm.stageCounts['delivering'] ?? 0), '交付中', 'gold')
      const rev = flow.createDiv({ cls: 'ai-linzi-cockpit-rev' })
      rev.createDiv({ text: '今年总营收 ☁️', cls: 'ai-linzi-cockpit-node-label' })
      rev.createDiv({ text: fmtAmount(crm.ytdAmount), cls: 'ai-linzi-cockpit-rev-num' })
      rev.createDiv({ text: `本月 ${fmtAmount(crm.thisMonth.amount)}`, cls: 'ai-linzi-cockpit-node-sub' })
    } else {
      node('—', '本月新增线索', 'sea')
      node('—', '本月成交', 'jade')
      node('—', '今年总营收', 'gold')
    }
  }

  private renderLanes(root: HTMLElement, local: LocalStats) {
    const lanes = root.createDiv({ cls: 'ai-linzi-cockpit-lanes' })
    const crm = this.cloud?.crm

    // ── 获客 · 水 ──
    const grow = lanes.createDiv({ cls: 'ai-linzi-cockpit-card ai-linzi-cockpit-lane is-sea' })
    this.laneHead(grow, '获客', '流量如水 · 内容即引流', crm ? String(crm.thisMonth.new) : '—', '本月新增线索')
    if (crm && crm.silent.count > 0) {
      this.focusLine(grow, `今天最该做：给 ${crm.silent.count} 条超过 ${crm.silent.thresholdDays} 天没动静的线索发一条轻量触达`)
    } else {
      this.focusLine(grow, '今天最该做：发一篇内容，让陌生人找到你')
    }
    const pipe = grow.createDiv({ cls: 'ai-linzi-cockpit-pipe' })
    const pipeNode = (n: number, t: string, hot = false) => {
      const el = pipe.createDiv({ cls: `ai-linzi-cockpit-pipe-node${hot ? ' is-hot' : ''}` })
      el.createDiv({ text: String(n), cls: 'ai-linzi-cockpit-pipe-num' })
      el.createDiv({ text: t, cls: 'ai-linzi-cockpit-pipe-label' })
    }
    pipeNode(local.pipeline.topic, '选题')
    pipeNode(local.pipeline.draft, '草稿')
    pipeNode(local.pipeline.ready, '待发布')
    pipeNode(local.pipeline.monthPublished, '本月已发', true)
    if (crm) {
      const channels = Object.entries(crm.channelCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
      if (channels.length > 0) {
        this.footLine(grow, '线索来源 Top', channels.map(([k, v]) => `${k} ${v}`).join(' · '))
      }
    }

    // ── 销售 · 木 ──
    const sell = lanes.createDiv({ cls: 'ai-linzi-cockpit-card ai-linzi-cockpit-lane is-jade' })
    this.laneHead(sell, '销售', '生长成交 · 咨询变订单', crm ? fmtAmount(crm.thisMonth.amount) : '—', crm ? `本月成交 ${crm.thisMonth.deals} 单` : '本月成交')
    if (!this.cloudUnavailable(sell, 'CRM 客户管理是 Pro 功能。在网页版录入客户后，销售漏斗会在这里亮起来。')) {
      const c = crm as CloudCrm
      const firstTodo = c.todos.items.find((t) => t.overdue) ?? c.todos.items[0]
      if (firstTodo) {
        this.focusLine(sell, `今天最该做：${firstTodo.customerName ? `「${firstTodo.customerName}」` : ''}${firstTodo.content}${firstTodo.overdue ? '（已逾期）' : ''}`)
      } else if (c.upcomingConsults7d > 0) {
        this.focusLine(sell, `今天最该做：未来 7 天有 ${c.upcomingConsults7d} 场咨询，把准备做在前面`)
      } else {
        this.focusLine(sell, '今天最该做：从漏斗里挑一位「已咨询」的客户，往前推一步')
      }
      const funnelStages = ['new', 'booked', 'consulted', 'won'] as const
      const max = Math.max(...funnelStages.map((s) => c.stageCounts[s] ?? 0), 1)
      const labelOf = (key: string) => c.stageLabels.find((s) => s.key === key)?.label ?? key
      const funnel = sell.createDiv({ cls: 'ai-linzi-cockpit-funnel' })
      funnelStages.forEach((stage, index) => {
        const count = c.stageCounts[stage] ?? 0
        const row = funnel.createDiv({ cls: 'ai-linzi-cockpit-funnel-row' })
        row.createSpan({ text: labelOf(stage), cls: 'ai-linzi-cockpit-funnel-stage' })
        const wrap = row.createDiv({ cls: 'ai-linzi-cockpit-funnel-bar-wrap' })
        const bar = wrap.createDiv({ cls: `ai-linzi-cockpit-funnel-bar is-step-${index}` })
        bar.style.width = `${Math.max(6, Math.round((count / max) * 100))}%`
        row.createSpan({ text: String(count), cls: 'ai-linzi-cockpit-funnel-num' })
      })
      const avg = c.thisMonth.deals > 0 ? fmtAmount(Math.round(c.thisMonth.amount / c.thisMonth.deals)) : '—'
      this.footLine(sell, '当前漏斗(在库客户)', `本月客单均价 ${avg}`)
    }

    // ── 交付 · 光 ──
    const serve = lanes.createDiv({ cls: 'ai-linzi-cockpit-card ai-linzi-cockpit-lane is-gold' })
    this.laneHead(serve, '交付', '收获口碑 · 服务养复购', crm ? String(crm.stageCounts['delivering'] ?? 0) : '—', '交付中客户')
    if (!this.cloudUnavailable(serve, '成交后把客户阶段推到「交付中」，交付节奏会在这里亮起来。')) {
      const c = crm as CloudCrm
      if (c.todos.overdue > 0) {
        this.focusLine(serve, `今天最该做：${c.todos.overdue} 项待办已逾期，先还上这笔账`)
      } else if (c.todos.open > 0) {
        this.focusLine(serve, `今天最该做：${c.todos.open} 项客户待办在排队，挑一件做完`)
      } else {
        this.focusLine(serve, '今天最该做：给一位交付中的客户发一条主动进展汇报')
      }
      const list = serve.createDiv({ cls: 'ai-linzi-cockpit-dlist' })
      const row = (label: string, value: string, warn = false) => {
        const el = list.createDiv({ cls: 'ai-linzi-cockpit-dlist-row' })
        el.createSpan({ text: label })
        el.createSpan({ text: value, cls: `ai-linzi-cockpit-dlist-num${warn ? ' is-warn' : ''}` })
      }
      row('客户待办(未完成)', String(c.todos.open), c.todos.overdue > 0)
      row('其中已逾期', String(c.todos.overdue), c.todos.overdue > 0)
      row('未来 7 天已约咨询', String(c.upcomingConsults7d))
      row('本月咨询交付', `${c.thisMonth.consults} 次`)
      const referral = Object.entries(c.channelCounts).find(([k]) => /转介绍|推荐/.test(k))
      this.footLine(serve, referral ? `♻️ 交付养获客：${referral[0]} ${referral[1]} 人` : '♻️ 交付做好，下一单会自己来', `已完结 ${c.stageCounts['done'] ?? 0}`)
    }
  }

  private laneHead(card: HTMLElement, name: string, en: string, big: string, cap: string) {
    const head = card.createDiv({ cls: 'ai-linzi-cockpit-lane-head' })
    const left = head.createDiv()
    left.createDiv({ text: name, cls: 'ai-linzi-cockpit-lane-name' })
    left.createDiv({ text: en, cls: 'ai-linzi-cockpit-lane-en' })
    const right = head.createDiv({ cls: 'ai-linzi-cockpit-lane-big' })
    right.createDiv({ text: big, cls: 'ai-linzi-cockpit-lane-big-num' })
    right.createDiv({ text: cap, cls: 'ai-linzi-cockpit-lane-big-cap' })
  }

  private focusLine(card: HTMLElement, text: string) {
    card.createDiv({ text, cls: 'ai-linzi-cockpit-focus' })
  }

  private footLine(card: HTMLElement, left: string, right: string) {
    const el = card.createDiv({ cls: 'ai-linzi-cockpit-footline' })
    el.createSpan({ text: left })
    el.createSpan({ text: right })
  }

  private renderTasks(grid: HTMLElement) {
    const card = grid.createDiv({ cls: 'ai-linzi-cockpit-card' })
    const head = card.createDiv({ cls: 'ai-linzi-cockpit-card-head' })
    head.createSpan({ text: '当前任务', cls: 'ai-linzi-cockpit-card-title' })
    head.createSpan({ text: '☁️', cls: 'ai-linzi-cockpit-src' })
    const tasks = this.cloud?.tasks ?? []
    if (this.cloudError === 'not-connected' || (!this.cloud && !this.loading)) {
      card.createDiv({ text: '连接 AI霖子 后，网页版任务会同步到这里。', cls: 'ai-linzi-cockpit-empty' })
      return
    }
    const tabs = card.createDiv({ cls: 'ai-linzi-cockpit-tabs' })
    const periods: { key: 'week' | 'month' | 'quarter'; label: string }[] = [
      { key: 'week', label: '本周' },
      { key: 'month', label: '本月' },
      { key: 'quarter', label: '本季' },
    ]
    for (const p of periods) {
      const count = tasks.filter((t) => t.period === p.key && t.status !== 'gave_up').length
      const tab = tabs.createEl('button', { text: `${p.label} ${count}`, cls: 'ai-linzi-cockpit-tab' })
      tab.toggleClass('is-active', this.taskTab === p.key)
      tab.onclick = () => {
        this.taskTab = p.key
        this.render()
      }
    }
    const items = tasks.filter((t) => t.period === this.taskTab && t.status !== 'gave_up')
    if (items.length === 0) {
      card.createDiv({ text: this.loading ? '加载中…' : '这个周期还没有任务。去对话里让 AI霖子 帮你定几个。', cls: 'ai-linzi-cockpit-empty' })
      return
    }
    for (const task of items.slice(0, 8)) {
      const row = card.createDiv({ cls: `ai-linzi-cockpit-task${task.status === 'done' ? ' is-done' : ''}` })
      row.createSpan({ text: task.status === 'done' ? '✅' : '⬜️', cls: 'ai-linzi-cockpit-task-mark' })
      row.createSpan({ text: task.title, cls: 'ai-linzi-cockpit-task-title' })
      row.createSpan({ text: TASK_SOURCE_LABEL[task.source] ?? task.source, cls: 'ai-linzi-cockpit-badge' })
    }
    const hint = card.createDiv({ cls: 'ai-linzi-cockpit-hint' })
    hint.createSpan({ text: '勾选完成去网页版 → ' })
    const link = hint.createEl('a', { text: '我的任务', href: `${this.plugin.settings.serverUrl.replace(/\/+$/, '')}/tasks` })
    link.addClass('ai-linzi-cockpit-link')
  }

  private renderCalendar(grid: HTMLElement, local: LocalStats) {
    const card = grid.createDiv({ cls: 'ai-linzi-cockpit-card' })
    const head = card.createDiv({ cls: 'ai-linzi-cockpit-card-head' })
    const prev = head.createEl('button', { text: '‹', cls: 'ai-linzi-cockpit-cal-nav' })
    head.createSpan({
      text: `${this.month.getFullYear()} 年 ${this.month.getMonth() + 1} 月`,
      cls: 'ai-linzi-cockpit-card-title',
    })
    const next = head.createEl('button', { text: '›', cls: 'ai-linzi-cockpit-cal-nav' })
    head.createSpan({ text: '🏠', cls: 'ai-linzi-cockpit-src' })
    prev.onclick = () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() - 1, 1)
      this.render()
    }
    next.onclick = () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 1)
      this.render()
    }
    const cal = card.createDiv({ cls: 'ai-linzi-cockpit-cal' })
    for (const weekday of ['一', '二', '三', '四', '五', '六', '日']) {
      cal.createDiv({ text: weekday, cls: 'ai-linzi-cockpit-cal-wd' })
    }
    const year = this.month.getFullYear()
    const month = this.month.getMonth()
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7
    const days = new Date(year, month + 1, 0).getDate()
    const today = localDate(Date.now())
    const cells = Math.ceil((firstWeekday + days) / 7) * 7
    for (let index = 0; index < cells; index++) {
      const day = index - firstWeekday + 1
      const cell = cal.createDiv({ cls: 'ai-linzi-cockpit-cal-day' })
      if (day < 1 || day > days) {
        cell.addClass('is-dim')
        continue
      }
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (date === today) cell.addClass('is-today')
      cell.createDiv({ text: String(day) })
      const dots = cell.createDiv({ cls: 'ai-linzi-cockpit-cal-dots' })
      if (local.publishDays.has(date)) dots.createSpan({ cls: 'ai-linzi-cockpit-dot is-pub' })
      if (local.noteDays.has(date)) dots.createSpan({ cls: 'ai-linzi-cockpit-dot is-note' })
    }
    const legend = card.createDiv({ cls: 'ai-linzi-cockpit-legend' })
    legend.createSpan({ text: '● 发布', cls: 'is-pub' })
    legend.createSpan({ text: '● 记录', cls: 'is-note' })
    legend.createSpan({ text: `🔥 连续记录 ${local.streak} 天`, cls: 'ai-linzi-cockpit-streak' })
  }

  private renderBrain(grid: HTMLElement, local: LocalStats) {
    const card = grid.createDiv({ cls: 'ai-linzi-cockpit-card' })
    const head = card.createDiv({ cls: 'ai-linzi-cockpit-card-head' })
    head.createSpan({ text: '第二大脑', cls: 'ai-linzi-cockpit-card-title' })
    head.createSpan({ text: '🏠', cls: 'ai-linzi-cockpit-src' })
    const top = card.createDiv({ cls: 'ai-linzi-cockpit-brain-top' })
    const big = (n: string, t: string, jade = false) => {
      const el = top.createDiv({ cls: 'ai-linzi-cockpit-brain-big' })
      el.createDiv({ text: n, cls: `ai-linzi-cockpit-brain-num${jade ? ' is-jade' : ''}` })
      el.createDiv({ text: t, cls: 'ai-linzi-cockpit-brain-cap' })
    }
    big(String(local.totalNotes), '全库笔记')
    big(`+${local.weekNew}`, '本周新增', true)
    const configured = local.folders.filter((f) => f.path)
    if (configured.length === 0) {
      card.createDiv({
        text: '在插件设置「驾驶舱目录」里指定 收件箱/原始素材/知识库 文件夹后，这里显示目录分布。',
        cls: 'ai-linzi-cockpit-empty',
      })
    } else {
      const max = Math.max(...configured.map((f) => f.count), 1)
      for (const folder of configured) {
        const row = card.createDiv({ cls: 'ai-linzi-cockpit-fold' })
        row.createSpan({ text: `${folder.icon} ${folder.name}`, cls: 'ai-linzi-cockpit-fold-name' })
        const wrap = row.createDiv({ cls: 'ai-linzi-cockpit-fold-bar-wrap' })
        const bar = wrap.createDiv({ cls: `ai-linzi-cockpit-fold-bar is-${folder.key}` })
        bar.style.width = `${Math.max(4, Math.round((folder.count / max) * 100))}%`
        row.createSpan({ text: String(folder.count), cls: 'ai-linzi-cockpit-fold-num' })
      }
    }
    if (local.inboxOldest.length > 0) {
      const inbox = card.createDiv({ cls: 'ai-linzi-cockpit-inbox' })
      const ih = inbox.createDiv({ cls: 'ai-linzi-cockpit-inbox-head' })
      ih.createSpan({ text: `📥 收件箱待处理 ${local.inboxCount}` })
      const overstay = local.inboxOldest.filter((i) => i.days >= 5).length
      if (overstay > 0) ih.createSpan({ text: `${overstay} 个超过 5 天`, cls: 'is-warn' })
      for (const item of local.inboxOldest.slice(0, 2)) {
        const row = inbox.createDiv({ cls: 'ai-linzi-cockpit-inbox-item' })
        const name = row.createSpan({ text: item.file.basename, cls: 'ai-linzi-cockpit-inbox-name' })
        name.onclick = () => {
          void this.app.workspace.getLeaf('tab').openFile(item.file)
        }
        row.createSpan({ text: item.days === 0 ? '今天' : `${item.days} 天`, cls: `ai-linzi-cockpit-inbox-age${item.days >= 5 ? ' is-warn' : ''}` })
      }
    }
  }
}

/**
 * AI霖子 Obsidian 插件 · v0.1(M1 骨架)
 *
 * 已实现:设置页(服务器地址/Token/测试连接) + 侧边栏对话面板(可带当前笔记上下文)
 * M1 用非流式模式(requestUrl 绕 CORS,稳定优先);流式 fetch 升级排 M3。
 * 后续里程碑:一键喂库(M2)、四技能笔记即输入+落盘(M2)、内容看板(v1.5)。
 *
 * 服务端对应:webapp feature/obsidian-plugin 分支 /api/plugin/*
 */
import {
  App,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  requestUrl,
} from 'obsidian'
import { applyUpdate, autoCheck, checkLatest, type UpdateInfo } from './updater'
import { copyWechatFormatted, sendToWechatDraft } from './publish'
import { prepareWechatArticle } from './article-format'
import {
  applyNotePatch,
  formatNotePatchMarkdown,
  isNoteEditIntent,
  parseNotePatch,
  type ParsedNotePatch,
} from './note-patch'
import {
  feedKnowledge,
  runArticleIllustration,
  runArticleIllustrationEdit,
  runDistribute,
  runSalesReview,
  runTopicRadar,
  runWechatWriter,
  writeOutput,
} from './actions'
import {
  extractPluginSkillSuggestions,
  isArticleIllustrationEditIntent,
  type PluginSkillSuggestion,
} from './skill-suggest'

/** 五个动作的唯一清单:命令面板、正文右键、对话面板按钮三个入口共用 */
export const SKILL_ACTIONS: {
  id: string
  name: string
  fn: (p: AiLinziPlugin) => Promise<void>
}[] = [
  {
    id: 'interview',
    name: '原创访谈写作:AI 采访你 → 写成公众号长文',
    fn: async (p) => p.startInterview(),
  },
  { id: 'topic-radar', name: '选题雷达:从当前笔记提炼选题', fn: runTopicRadar },
  { id: 'wechat-writer', name: '公众号写作:当前笔记作素材', fn: runWechatWriter },
  { id: 'distribute', name: '多平台分发:当前笔记成稿 → 小红书/口播/朋友圈', fn: runDistribute },
  { id: 'sales-review', name: '谈单复盘:诊断当前逐字稿', fn: runSalesReview },
  { id: 'illustration', name: '文章配图:极简小清新手绘(先看方案再生图)', fn: runArticleIllustration },
  { id: 'wechat-copy', name: '公众号排版:一键复制(去后台粘贴)', fn: async (p) => copyWechatFormatted(p) },
  { id: 'wechat-draft', name: '发到公众号草稿箱(自动传图,需配置AppID)', fn: async (p) => sendToWechatDraft(p) },
  { id: 'feed-knowledge', name: '喂库:把当前笔记存入 AI霖子知识库', fn: feedKnowledge },
]

// ── 设置 ──────────────────────────────────────────────

interface AiLinziSettings {
  serverUrl: string
  token: string
  /** 「带上当前笔记」开关的默认值 */
  attachNoteDefault: boolean
  /** 技能产出落盘的文件夹(相对 vault 根) */
  outputFolder: string
  /** 选题雷达默认受众(跑一次后自动记住;历史key沿用defaultNiche兼容旧设置) */
  defaultNiche: string
  /** 上次自动检查更新的时间戳(约每20小时一次) */
  lastUpdateCheckAt?: number
  /** 公众号发布(选配):学员自己的公众号开发者凭证,只存本地 */
  wechatAppId: string
  wechatAppSecret: string
  /** 文末品牌小卡「排版与配图 · AI霖子」(默认开,可关) */
  brandFooter: boolean
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  serverUrl: 'https://chat.alinalinzi.com',
  token: '',
  attachNoteDefault: true,
  outputFolder: 'AI霖子输出',
  defaultNiche: '',
  wechatAppId: '',
  wechatAppSecret: '',
  brandFooter: true,
}

const VIEW_TYPE_CHAT = 'ai-linzi-chat'

// 与服务端 chat-core UIMessage 对齐的最小结构
interface WireMessage {
  id: string
  role: 'user' | 'assistant'
  parts: { type: 'text'; text: string }[]
}

/** 本地保存的会话(存插件目录 conversations.json,升级/重启不丢) */
interface SavedConvo {
  id: string
  mode: 'chat' | 'interview'
  title: string
  updatedAt: number
  messages: WireMessage[]
}

const MAX_SAVED_CONVOS = 30

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 解析缓冲后的 UIMessage SSE 流(访谈写作路由用):只取 text-delta 正文,
 * 跳过 reasoning-delta(V4 Pro 思考过程,不该给用户看),error 事件透传。
 * 格式实测于 2026-07-21 生产环境。
 */
function extractTextFromSSE(raw: string): { text: string; error?: string } {
  let text = ''
  let error: string | undefined
  for (const line of raw.split('\n')) {
    const l = line.trim()
    if (!l.startsWith('data:')) continue
    const payload = l.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const ev = JSON.parse(payload) as { type?: string; delta?: string; errorText?: string }
      if (ev.type === 'text-delta' && typeof ev.delta === 'string') text += ev.delta
      else if (ev.type === 'error') error = ev.errorText ?? '生成出错'
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return { text, error }
}

// ── 插件主体 ──────────────────────────────────────────

export default class AiLinziPlugin extends Plugin {
  settings: AiLinziSettings = DEFAULT_SETTINGS
  /**
   * 最近一次激活的笔记。侧边面板(对话)获得焦点时 getActiveFile() 会返回 null,
   * 面板上的「调用技能/存入知识库」按钮靠这个记录知道用户"当前开着哪篇笔记"。
   */
  lastActiveFile: TFile | null = null
  /** 启动检查发现的待装更新(设置页展示) */
  pendingUpdate: UpdateInfo | null = null

  async onload() {
    await this.loadSettings()

    // 启动 8s 后静默查一次更新(不阻塞加载;找到只提示,由用户在设置页确认)
    window.setTimeout(() => void autoCheck(this), 8000)

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const f = this.app.workspace.getActiveFile()
        if (f) this.lastActiveFile = f
      }),
    )

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this))

    this.addRibbonIcon('sparkles', 'AI霖子对话', () => this.activateChatView())

    this.addCommand({
      id: 'open-chat',
      name: '打开 AI霖子 对话面板',
      callback: () => this.activateChatView(),
    })

    this.addCommand({
      id: 'test-connection',
      name: '测试与 AI霖子 的连接',
      callback: () => this.testConnection(),
    })

    // ── M2:四技能 + 喂库(笔记即输入);三入口共用 SKILL_ACTIONS ──
    for (const c of SKILL_ACTIONS) {
      this.addCommand({ id: c.id, name: c.name, callback: () => void c.fn(this) })
    }

    // 编辑器右键菜单(编辑模式正文;对话面板按钮是主入口,这里是顺手入口)
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu) => {
        for (const c of SKILL_ACTIONS) {
          menu.addItem((item) =>
            item
              .setTitle(`AI霖子:${c.name.split(':')[0]}`)
              .setIcon('sparkles')
              .onClick(() => void c.fn(this)),
          )
        }
      }),
    )

    this.addSettingTab(new AiLinziSettingTab(this.app, this))
  }

  async onunload() {
    // Obsidian 官方规范:卸载时不 detach leaves(用户布局归用户)
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  // ── 会话本地持久化(独立文件,不进 data.json 防设置写放大) ──

  private convosPath(): string {
    return `${this.manifest.dir}/conversations.json`
  }

  async loadConvos(): Promise<SavedConvo[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.convosPath())
      const list = JSON.parse(raw) as SavedConvo[]
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  async saveConvo(convo: SavedConvo): Promise<void> {
    const list = (await this.loadConvos()).filter((c) => c.id !== convo.id)
    list.unshift(convo)
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    await this.app.vault.adapter.write(this.convosPath(), JSON.stringify(list.slice(0, MAX_SAVED_CONVOS)))
  }

  async deleteAllConvos(): Promise<void> {
    await this.app.vault.adapter.write(this.convosPath(), '[]')
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  async activateChatView() {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT)
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true })
    workspace.revealLeaf(leaf)
  }

  /** 进入访谈写作模式(SKILL_ACTIONS 菜单入口) */
  async startInterview() {
    await this.activateChatView()
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0]
    const view = leaf?.view
    if (view instanceof ChatView) view.enterInterviewMode()
  }

  /** 统一 API 调用(requestUrl 绕 CORS;throw:false 自己处理错误码) */
  async api(path: string, init?: { method?: string; body?: unknown }) {
    const { serverUrl, token } = this.settings
    if (!serverUrl || !token) {
      throw new Error('请先在设置里填写服务器地址和 Token')
    }
    const res = await requestUrl({
      url: `${serverUrl.replace(/\/+$/, '')}${path}`,
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      throw: false,
    })
    let data: Record<string, unknown> = {}
    try {
      data = res.json as Record<string, unknown>
    } catch {
      /* 非 JSON 响应 */
    }
    if (res.status >= 400) {
      const msg = typeof data.error === 'string' ? data.error : `请求失败(${res.status})`
      throw new Error(msg)
    }
    return data
  }

  /**
   * 调用返回纯文本流的技能路由(toTextStreamResponse)。
   * requestUrl 会把流缓冲成完整文本;错误时这些路由返回 JSON,这里解析出友好文案。
   */
  async apiText(path: string, body: unknown): Promise<string> {
    const { serverUrl, token } = this.settings
    if (!serverUrl || !token) {
      throw new Error('请先在设置里填写服务器地址和 Token')
    }
    const res = await requestUrl({
      url: `${serverUrl.replace(/\/+$/, '')}${path}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      throw: false,
    })
    if (res.status >= 400) {
      let msg = `请求失败(${res.status})`
      try {
        const data = JSON.parse(res.text) as { error?: string }
        if (typeof data.error === 'string') msg = data.error
      } catch {
        /* 非 JSON 错误体 */
      }
      throw new Error(msg)
    }
    const text = res.text?.trim()
    if (!text) throw new Error('AI 返回了空内容,请稍后重试')
    return text
  }

  async testConnection() {
    try {
      const data = await this.api('/api/plugin/ping')
      new Notice(
        `✅ 已连接 AI霖子\n学号:${data.studentNo}\ntier:${data.tier} · 余额:${data.balance} 积分`,
        6000,
      )
      return true
    } catch (e) {
      new Notice(`❌ 连接失败:${e instanceof Error ? e.message : String(e)}`, 6000)
      return false
    }
  }
}

// ── 对话面板 ──────────────────────────────────────────

class ChatView extends ItemView {
  private plugin: AiLinziPlugin
  private messages: WireMessage[] = []
  private sessionId = uid()
  private attachNote: boolean
  private sending = false
  /** chat=日常对话;interview=访谈写作(多轮采访→成稿) */
  private mode: 'chat' | 'interview' = 'chat'
  private interviewBar!: HTMLElement

  private listEl!: HTMLElement
  private inputEl!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private attachToggleEl!: HTMLInputElement

  constructor(leaf: WorkspaceLeaf, plugin: AiLinziPlugin) {
    super(leaf)
    this.plugin = plugin
    this.attachNote = plugin.settings.attachNoteDefault
  }

  getViewType() {
    return VIEW_TYPE_CHAT
  }
  getDisplayText() {
    return 'AI霖子'
  }
  getIcon() {
    return 'sparkles'
  }

  async onOpen() {
    const root = this.contentEl
    root.empty()
    root.addClass('ai-linzi-root')

    // 顶栏:历史 + 新对话
    const topbar = root.createDiv({ cls: 'ai-linzi-topbar' })
    topbar.createSpan({ text: 'AI霖子 · 你的 24 小时商业教练', cls: 'ai-linzi-title' })
    const btns = topbar.createDiv({ cls: 'ai-linzi-topbar-btns' })
    const histBtn = btns.createEl('button', { text: '历史', cls: 'ai-linzi-newchat' })
    histBtn.onclick = (evt: MouseEvent) => void this.showHistoryMenu(evt)
    const newBtn = btns.createEl('button', { text: '新对话', cls: 'ai-linzi-newchat' })
    newBtn.onclick = () => {
      void this.persistNow() // 旧对话先落盘
      this.messages = []
      this.sessionId = uid()
      if (this.mode === 'interview') this.exitInterviewMode()
      this.renderMessages()
    }

    // 访谈写作模式条(默认隐藏)
    this.interviewBar = root.createDiv({ cls: 'ai-linzi-interview-bar' })
    this.interviewBar.hide()
    this.interviewBar.createSpan({ text: '✍️ 访谈写作中:答完 AI 的采访,它会写成公众号长文' })
    const ivBtns = this.interviewBar.createDiv({ cls: 'ai-linzi-interview-btns' })
    const saveBtn = ivBtns.createEl('button', { text: '存为笔记' })
    saveBtn.onclick = () => void this.saveLastReplyAsNote()
    const exitBtn = ivBtns.createEl('button', { text: '结束访谈' })
    exitBtn.onclick = () => this.exitInterviewMode()

    this.listEl = root.createDiv({ cls: 'ai-linzi-messages' })

    // 底部输入区
    const footer = root.createDiv({ cls: 'ai-linzi-footer' })

    // 动作按钮行:技能与喂库的主入口(比正文右键菜单直观,对小白友好)
    const actionsRow = footer.createDiv({ cls: 'ai-linzi-actions' })
    const skillBtn = actionsRow.createEl('button', { text: '⚡ 调用技能', cls: 'ai-linzi-action-btn' })
    skillBtn.onclick = (evt: MouseEvent) => {
      const menu = new Menu()
      for (const c of SKILL_ACTIONS) {
        if (c.id === 'feed-knowledge') continue
        menu.addItem((item) =>
          item
            .setTitle(c.name)
            .setIcon('sparkles')
            .onClick(() => void c.fn(this.plugin)),
        )
      }
      menu.showAtMouseEvent(evt)
    }
    const kbBtn = actionsRow.createEl('button', { text: '📚 存入知识库', cls: 'ai-linzi-action-btn' })
    kbBtn.onclick = () => void feedKnowledge(this.plugin)
    actionsRow.createSpan({ text: '作用于当前打开的笔记', cls: 'ai-linzi-actions-hint' })

    const toggleRow = footer.createDiv({ cls: 'ai-linzi-toggle-row' })
    const label = toggleRow.createEl('label', { cls: 'ai-linzi-toggle' })
    this.attachToggleEl = label.createEl('input', { type: 'checkbox' })
    this.attachToggleEl.checked = this.attachNote
    this.attachToggleEl.onchange = () => {
      this.attachNote = this.attachToggleEl.checked
    }
    label.createSpan({ text: ' 带上当前笔记(Pro)' })

    this.inputEl = footer.createEl('textarea', {
      cls: 'ai-linzi-input',
      attr: { placeholder: '问 AI霖子 任何事…(Enter 发送,Shift+Enter 换行)' },
    })
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault()
        void this.send()
      }
    })

    this.sendBtn = footer.createEl('button', { text: '发送', cls: 'ai-linzi-send' })
    this.sendBtn.onclick = () => void this.send()

    this.renderMessages()
    // 恢复最近一次会话(升级/重启后不丢)
    void this.restoreLatest()
  }

  /** 每轮对话后自动保存;消息为空不存 */
  private async persistNow(): Promise<void> {
    if (this.messages.length === 0) return
    const firstUser = this.messages.find((m) => m.role === 'user')
    const title = (firstUser?.parts.map((p) => p.text).join('') ?? '对话').slice(0, 24)
    await this.plugin.saveConvo({
      id: this.sessionId,
      mode: this.mode,
      title,
      updatedAt: Date.now(),
      messages: this.messages,
    })
  }

  private async restoreLatest(): Promise<void> {
    if (this.messages.length > 0) return
    const [latest] = await this.plugin.loadConvos()
    if (!latest || latest.messages.length === 0) return
    this.loadConvo(latest)
  }

  private loadConvo(c: SavedConvo): void {
    this.messages = c.messages
    this.sessionId = c.id
    if (c.mode === 'interview' && this.mode !== 'interview') {
      this.mode = 'interview'
      this.interviewBar.show()
      this.inputEl.placeholder = '先告诉 AI 你想写什么方向(一句话),它会开始采访你…'
    } else if (c.mode === 'chat' && this.mode === 'interview') {
      this.mode = 'chat'
      this.interviewBar.hide()
      this.inputEl.placeholder = '问 AI霖子 任何事…(Enter 发送,Shift+Enter 换行)'
    }
    this.renderMessages()
  }

  private async showHistoryMenu(evt: MouseEvent): Promise<void> {
    const convos = await this.plugin.loadConvos()
    const menu = new Menu()
    if (convos.length === 0) {
      menu.addItem((i) => i.setTitle('还没有历史对话').setDisabled(true))
    }
    for (const c of convos.slice(0, 15)) {
      const d = new Date(c.updatedAt)
      const stamp = `${d.getMonth() + 1}/${d.getDate()}`
      menu.addItem((i) =>
        i
          .setTitle(`${c.mode === 'interview' ? '✍️ ' : ''}${c.title} · ${stamp}`)
          .onClick(() => {
            void this.persistNow()
            this.loadConvo(c)
          }),
      )
    }
    menu.addSeparator()
    menu.addItem((i) =>
      i.setTitle('🗑 清空全部历史对话').onClick(() => {
        if (!window.confirm('确定清空全部历史对话吗?此操作不可恢复(已「存为笔记」的成稿不受影响)。')) return
        void this.plugin.deleteAllConvos().then(() => {
          this.messages = []
          this.sessionId = uid()
          this.renderMessages()
          new Notice('历史对话已清空')
        })
      }),
    )
    menu.showAtMouseEvent(evt)
  }

  private async currentNoteContext(): Promise<{ filename: string; text: string } | undefined> {
    if (!this.attachNote) return undefined
    const file = this.app.workspace.getActiveFile() ?? this.plugin.lastActiveFile
    if (!file) return undefined
    const text = await this.app.vault.cachedRead(file)
    if (!text.trim()) return undefined
    return { filename: file.name, text }
  }

  private async send() {
    const text = this.inputEl.value.trim()
    if (!text || this.sending) return

    this.messages.push({ id: uid(), role: 'user', parts: [{ type: 'text', text }] })
    this.inputEl.value = ''
    this.sending = true
    this.sendBtn.disabled = true
    this.renderMessages(true)

    try {
      if (this.mode === 'interview') {
        const answer = await this.sendInterview()
        this.messages.push({ id: uid(), role: 'assistant', parts: [{ type: 'text', text: answer }] })
        await this.persistNow()
        return
      }
      const noteContext = await this.currentNoteContext()
      const noteEdit = Boolean(noteContext && isNoteEditIntent(text))
      // M3:优先流式(fetch 纯文本流,逐块显示);CORS/网络不支持时自动回落非流式;
      // 业务错误(积分不足/tier/限流)不回落不重发,直接显示。
      let answer: string
      let streamed: { kind: 'ok'; text: string } | { kind: 'bizError'; message: string } | null
      try {
        streamed = await this.sendStreaming(noteContext, noteEdit)
      } catch {
        streamed = null
      }
      if (streamed?.kind === 'bizError') {
        answer = `⚠️ ${streamed.message}`
      } else if (streamed?.kind === 'ok') {
        answer = streamed.text
      } else {
        const data = await this.plugin.api('/api/plugin/chat', {
          method: 'POST',
          body: {
            messages: this.messages,
            sessionId: this.sessionId,
            stream: false,
            noteContext,
            noteEdit,
          },
        })
        answer = typeof data.text === 'string' ? data.text : '(空响应)'
      }
      this.messages.push({ id: uid(), role: 'assistant', parts: [{ type: 'text', text: answer }] })
      await this.persistNow()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      new Notice(`AI霖子:${msg}`, 6000)
      // 失败的那条用户消息保留在输入历史里,方便重试
      this.messages.push({
        id: uid(),
        role: 'assistant',
        parts: [{ type: 'text', text: `⚠️ ${msg}` }],
      })
    } finally {
      this.sending = false
      this.sendBtn.disabled = false
      this.renderMessages()
    }
  }

  enterInterviewMode() {
    this.mode = 'interview'
    this.messages = []
    this.sessionId = uid()
    this.interviewBar.show()
    this.inputEl.placeholder = '先告诉 AI 你想写什么方向(一句话),它会开始采访你…'
    this.renderMessages()
    new Notice('✍️ 已进入访谈写作:先说你想写的方向', 5000)
  }

  exitInterviewMode() {
    this.mode = 'chat'
    this.messages = []
    this.sessionId = uid()
    this.interviewBar.hide()
    this.inputEl.placeholder = '问 AI霖子 任何事…(Enter 发送,Shift+Enter 换行)'
    this.renderMessages()
  }

  /** 把最新一条 AI 回复(通常是成稿)落盘为笔记 */
  private async saveLastReplyAsNote() {
    const lastAi = [...this.messages].reverse().find((m) => m.role === 'assistant')
    if (!lastAi) {
      new Notice('还没有可保存的 AI 回复')
      return
    }
    const body = lastAi.parts.map((p) => p.text).join('')
    const article = prepareWechatArticle(body)
    const firstUser = this.messages.find((m) => m.role === 'user')
    const hint = firstUser ? firstUser.parts.map((p) => p.text).join('').slice(0, 24) : '访谈成稿'
    const f = await writeOutput(this.plugin, {
      skill: '访谈写作',
      platform: '公众号',
      title: article.titleCandidates[0] || `访谈成稿_${hint}`,
      body: article.body,
      summary: article.digest,
      titleCandidates: article.titleCandidates,
    })
    new Notice(`✅ 已存为笔记:${f.basename}`)
  }

  /** 访谈模式发送:走 wechat-interview 技能路由(UIMessage SSE,缓冲后解析) */
  private async sendInterview(): Promise<string> {
    const { serverUrl, token } = this.plugin.settings
    const res = await requestUrl({
      url: `${serverUrl.replace(/\/+$/, '')}/api/skills/wechat-interview`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: this.messages }),
      throw: false,
    })
    if (res.status >= 400) {
      let msg = `请求失败(${res.status})`
      try {
        const d = JSON.parse(res.text) as { error?: string }
        if (typeof d.error === 'string') msg = d.error
      } catch { /* 非 JSON */ }
      return `⚠️ ${msg}`
    }
    const { text, error } = extractTextFromSSE(res.text ?? '')
    if (error) return `⚠️ ${error}`
    if (!text.trim()) return '⚠️ AI 返回了空内容,请再发一次'
    return text
  }

  /**
   * 流式发送:POST stream:'text' → fetch 逐块读 → 实时刷在临时气泡里。
   * 返回 {kind:'ok'} 完整文本 或 {kind:'bizError'} 服务端业务错误(调用方不回落不重发);
   * 网络/CORS 层异常直接 throw,由调用方回落非流式。
   */
  private async sendStreaming(
    noteContext: { filename: string; text: string } | undefined,
    noteEdit: boolean,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'bizError'; message: string }> {
    const { serverUrl, token } = this.plugin.settings
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/plugin/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: this.messages,
        sessionId: this.sessionId,
        stream: 'text',
        noteContext,
        noteEdit,
      }),
    })
    if (!res.ok) {
      let msg = `请求失败(${res.status})`
      try {
        const data = (await res.json()) as { error?: string }
        if (typeof data.error === 'string') msg = data.error
      } catch {
        /* 非 JSON */
      }
      return { kind: 'bizError', message: msg }
    }
    if (!res.body) throw new Error('no stream body')

    // 临时流式气泡
    const row = this.listEl.createDiv({ cls: 'ai-linzi-msg ai-linzi-msg-assistant' })
    const body = row.createDiv({ cls: 'ai-linzi-msg-body' })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let full = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        full += decoder.decode(value, { stream: true })
        const patchAt = full.indexOf('<AI_LINZI_NOTE_PATCH>')
        body.setText(
          patchAt >= 0
            ? `${full.slice(0, patchAt).trim()}\n\n正在整理可一键应用的修改…`
            : full,
        )
        this.listEl.scrollTop = this.listEl.scrollHeight
      }
      full += decoder.decode()
    } finally {
      row.remove() // 定稿气泡由 renderMessages 统一渲染(markdown)
    }
    if (!full.trim()) throw new Error('empty stream')
    return { kind: 'ok', text: full }
  }

  private renderMessages(thinking = false) {
    this.listEl.empty()
    if (this.messages.length === 0) {
      const empty = this.listEl.createDiv({ cls: 'ai-linzi-empty' })
      empty.createDiv({ text: '👋 我是 AI霖子' })
      empty.createDiv({
        text: '开着某篇笔记问我,我可以结合它给你商业判断、内容建议和下一步行动。',
        cls: 'ai-linzi-empty-sub',
      })
      return
    }
    for (let mi = 0; mi < this.messages.length; mi++) {
      const m = this.messages[mi]
      const row = this.listEl.createDiv({
        cls: `ai-linzi-msg ai-linzi-msg-${m.role}`,
      })
      const body = row.createDiv({ cls: 'ai-linzi-msg-body' })
      const text = m.parts.map((p) => p.text).join('')
      if (m.role === 'assistant') {
        let previousUserText = ''
        for (let j = mi - 1; j >= 0; j--) {
          if (this.messages[j].role === 'user') {
            previousUserText = this.messages[j].parts.map((p) => p.text).join('')
            break
          }
        }
        const skillResult = extractPluginSkillSuggestions(text, previousUserText)
        const cleanText = skillResult.cleanText
        const patch = parseNotePatch(cleanText)
        const editReply = this.mode === 'chat' && isNoteEditIntent(previousUserText)
        void MarkdownRenderer.render(this.app, patch?.displayText ?? cleanText, body, '', this)
        if (patch) this.renderPatchCards(row, patch)
        // 每条 AI 回复都能一键落盘——内容留在用户自己的 Obsidian 里才是关键(Alina 2026-07-21)
        if (text.trim().length > 0 && !text.startsWith('⚠️')) {
          const bar = row.createDiv({ cls: 'ai-linzi-msg-actions' })
          if (patch) {
            const applyBtn = bar.createEl('button', {
              text: `✅ 一键应用 ${patch.operations.length} 处修改`,
              cls: 'ai-linzi-apply-patch',
            })
            applyBtn.onclick = () => void this.applyPatchToCurrentNote(patch, applyBtn)
          }
          for (const suggestion of skillResult.suggestions) {
            const skillBtn = bar.createEl('button', {
              text:
                suggestion.actionId === 'illustration' && isArticleIllustrationEditIntent(previousUserText)
                  ? '🖼️ 修改当前文章配图'
                  : `⚡ ${suggestion.label}`,
              cls: 'ai-linzi-suggested-skill',
            })
            skillBtn.onclick = () => void this.runSuggestedSkill(suggestion, previousUserText)
          }
          const saveBtn = bar.createEl('button', { text: '📝 存为笔记' })
          saveBtn.onclick = async () => {
            // 标题:往前找最近一条用户消息作主题;找不到用回复首行
            let hint = previousUserText.slice(0, 24)
            if (!hint) hint = text.split('\n')[0].replace(/[#*>]/g, '').trim().slice(0, 24) || '对话内容'
            const savedText = patch ? formatNotePatchMarkdown(patch) : text
            const article = prepareWechatArticle(savedText)
            const isArticle = article.recognizedContainer
            const f = await writeOutput(this.plugin, {
              skill: isArticle ? '公众号写作' : '对话',
              platform: isArticle ? '公众号' : '通用',
              title: article.titleCandidates[0] || hint,
              body: article.body,
              summary: article.digest,
              titleCandidates: article.titleCandidates,
            })
            new Notice(`✅ 已存为笔记:${f.basename}`)
          }
          if (!patch && editReply) {
            const unavailableBtn = bar.createEl('button', { text: '⚠️ 未识别到可安全应用的修改' })
            unavailableBtn.disabled = true
            unavailableBtn.title = '请让 AI 重新读取当前笔记，并明确要修改的原文'
          } else if (!patch) {
            // 非局部编辑回复仍保留“整篇更新”出口；它始终位于回复底部且需要二次确认。
            const updateBtn = bar.createEl('button', { text: '✏️ 更新当前笔记' })
            updateBtn.onclick = async () => {
              const file = this.app.workspace.getActiveFile() ?? this.plugin.lastActiveFile
              if (!file) {
                new Notice('没有找到当前打开的笔记')
                return
              }
              const ok = window.confirm(
                `将用这条回复替换笔记「${file.basename}」的正文(文档属性 frontmatter 保留)。\n\n改错了不用慌:笔记内可 ⌘Z 撤销,或 设置 → 文件恢复 里回滚历史版本。\n\n确定更新?`,
              )
              if (!ok) return
              const article = prepareWechatArticle(text)
              await this.app.vault.process(file, (content) => {
                const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content)
                return (fm ? fm[0] : '') + article.body.trim() + '\n'
              })
              new Notice(`✅ 已更新「${file.basename}」(可用 ⌘Z 或「文件恢复」回滚)`)
            }
          }
        }
      } else {
        body.setText(text)
      }
    }
    if (thinking) {
      const row = this.listEl.createDiv({ cls: 'ai-linzi-msg ai-linzi-msg-assistant' })
      row.createDiv({ cls: 'ai-linzi-msg-body', text: 'AI霖子思考中…' })
    }
    this.listEl.scrollTop = this.listEl.scrollHeight
  }

  private renderPatchCards(row: HTMLElement, patch: ParsedNotePatch): void {
    const list = row.createDiv({ cls: 'ai-linzi-note-patch' })
    patch.operations.forEach((op, index) => {
      const card = list.createDiv({ cls: 'ai-linzi-note-patch-item' })
      card.createDiv({ text: `修改 ${index + 1}${op.all ? ' · 全文同类位置' : ''}`, cls: 'ai-linzi-patch-title' })
      card.createDiv({ text: '原文', cls: 'ai-linzi-patch-label' })
      card.createDiv({ text: op.old, cls: 'ai-linzi-patch-text ai-linzi-patch-old' })
      card.createDiv({ text: '改为', cls: 'ai-linzi-patch-label' })
      card.createDiv({ text: op.new || '（删除）', cls: 'ai-linzi-patch-text ai-linzi-patch-new' })
      if (op.reason) card.createDiv({ text: op.reason, cls: 'ai-linzi-patch-reason' })
    })
  }

  private async runSuggestedSkill(
    suggestion: PluginSkillSuggestion,
    previousUserText: string,
  ): Promise<void> {
    if (suggestion.actionId === 'illustration' && isArticleIllustrationEditIntent(previousUserText)) {
      await runArticleIllustrationEdit(this.plugin, previousUserText)
      return
    }
    const action = SKILL_ACTIONS.find((item) => item.id === suggestion.actionId)
    if (!action) {
      new Notice(`插件暂不支持「${suggestion.label}」`)
      return
    }
    await action.fn(this.plugin)
  }

  private async applyPatchToCurrentNote(patch: ParsedNotePatch, button: HTMLButtonElement): Promise<void> {
    const file = this.app.workspace.getActiveFile() ?? this.plugin.lastActiveFile
    if (!file) {
      new Notice('没有找到当前打开的笔记')
      return
    }
    const originalLabel = button.textContent ?? '一键应用修改'
    button.disabled = true
    button.setText('正在应用…')
    try {
      let replacements = 0
      let alreadyApplied = 0
      await this.app.vault.process(file, (content) => {
        const result = applyNotePatch(content, patch)
        replacements = result.replacements
        alreadyApplied = result.alreadyApplied
        return result.content
      })
      button.setText(replacements > 0 ? '✅ 已应用到当前笔记' : '✅ 当前笔记已是修改后内容')
      new Notice(
        replacements > 0
          ? `✅ 已在「${file.basename}」精确更新 ${replacements} 处（可用 ⌘Z 撤销）`
          : `「${file.basename}」已经包含这些修改，无需重复应用`,
        6000,
      )
      if (alreadyApplied > 0 && replacements > 0) {
        new Notice(`另有 ${alreadyApplied} 项此前已经应用，本次已自动跳过`)
      }
    } catch (error) {
      button.disabled = false
      button.setText(originalLabel)
      new Notice(error instanceof Error ? error.message : String(error), 8000)
    }
  }
}

// ── 设置页 ──────────────────────────────────────────

class AiLinziSettingTab extends PluginSettingTab {
  private plugin: AiLinziPlugin

  constructor(app: App, plugin: AiLinziPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('服务器地址')
      .setDesc('默认已是 AI霖子 官方地址,一般不需要修改')
      .addText((t) =>
        t
          .setPlaceholder('http://localhost:3000')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (v) => {
            this.plugin.settings.serverUrl = v.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('API Token')
      .setDesc('在 AI霖子 网页「我的 → 连接中心」生成密钥后粘贴到这里。还没有账号?先到 chat.alinalinzi.com 注册。⚠️ 不要把含密钥的 vault 配置分享给别人。')
      .addText((t) => {
        t.inputEl.type = 'password'
        t.setPlaceholder('alz_...')
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('产出内容保存到文件夹')
      .setDesc('技能生成的选题、文章、分发内容都会保存到这个文件夹(只新建、不覆盖你的笔记)')
      .addText((t) =>
        t
          .setPlaceholder('AI霖子输出')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (v) => {
            this.plugin.settings.outputFolder = v.trim() || 'AI霖子输出'
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('默认带上当前笔记')
      .setDesc('对话面板「带上当前笔记」开关的默认状态(带笔记走 Pro 附件通道)')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.attachNoteDefault).onChange(async (v) => {
          this.plugin.settings.attachNoteDefault = v
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl).setName('公众号发布(选配)').setHeading()

    new Setting(containerEl)
      .setName('公众号 AppID')
      .setDesc('登录 微信开发者平台 developers.weixin.qq.com/platform → 我的业务 → 公众号 → 你的号 → 基础信息里复制(个人订阅号即可)。凭证只保存在你的电脑上。')
      .addText((t) =>
        t
          .setPlaceholder('wx 开头的一串')
          .setValue(this.plugin.settings.wechatAppId)
          .onChange(async (v) => {
            this.plugin.settings.wechatAppId = v.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('公众号 AppSecret')
      .setDesc('同一页面「开发密钥」处点重置获取(只显示一次,立即复制)。⚠️ 还需把本机 IP 加入同页「API IP 白名单」。')
      .addText((t) => {
        t.inputEl.type = 'password'
        t.setPlaceholder('•••')
          .setValue(this.plugin.settings.wechatAppSecret)
          .onChange(async (v) => {
            this.plugin.settings.wechatAppSecret = v.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('文末品牌小卡')
      .setDesc('排版/发草稿箱时在文章末尾加一枚极简小徽章「✨ 排版与配图 · AI霖子」。读者好奇你的排版是怎么做的,答案就在文末。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.brandFooter).onChange(async (v) => {
          this.plugin.settings.brandFooter = v
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('查看本机 IP')
      .setDesc('加 IP 白名单用。家里网络的 IP 隔段时间会变,变了就再查一次、再加一次。')
      .addButton((b) =>
        b.setButtonText('查询并复制').onClick(async () => {
          b.setDisabled(true)
          try {
            let ip = ''
            for (const url of ['https://myip.ipip.net/s', 'https://api.ipify.org']) {
              try {
                const r = await requestUrl({ url, throw: false })
                const t = (r.text ?? '').trim()
                if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) { ip = t; break }
              } catch { /* 换下一个源 */ }
            }
            if (!ip) throw new Error('查询失败,请稍后再试或打开 ip.cn 查看')
            await navigator.clipboard.writeText(ip)
            new Notice(`你的本机 IP:${ip}\n已复制,去微信开发者平台粘进「API IP 白名单」`, 10000)
          } catch (e) {
            new Notice(`${e instanceof Error ? e.message : String(e)}`, 6000)
          } finally {
            b.setDisabled(false)
          }
        }),
      )

    new Setting(containerEl)
      .setName('图文配置教程')
      .setDesc('AppID / AppSecret / IP 白名单,带截图的一步步指引')
      .addButton((b) =>
        b.setButtonText('打开教程').onClick(() => {
          window.open('https://github.com/AlinaWang321/ai-linzi-obsidian/blob/master/docs/wechat-setup-guide.md')
        }),
      )

    new Setting(containerEl)
      .setName(`插件更新(当前 v${this.plugin.manifest.version})`)
      .setDesc(this.plugin.pendingUpdate ? `发现新版本 v${this.plugin.pendingUpdate.version}!` : '检查 GitHub 上是否有新版本,一键更新并自动重载')
      .addButton((b) =>
        b
          .setButtonText(this.plugin.pendingUpdate ? `更新到 v${this.plugin.pendingUpdate.version}` : '检查并更新')
          .setCta()
          .onClick(async () => {
            b.setDisabled(true)
            try {
              const info = this.plugin.pendingUpdate ?? (await checkLatest(this.plugin))
              if (!info) {
                new Notice('✅ 已经是最新版本')
                return
              }
              new Notice(`开始更新到 v${info.version}…`)
              await applyUpdate(this.plugin, info)
            } catch (e) {
              new Notice(`更新失败:${e instanceof Error ? e.message : String(e)}`, 8000)
            } finally {
              b.setDisabled(false)
            }
          }),
      )

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('验证地址与密钥是否可用,并显示账号与积分余额')
      .addButton((b) =>
        b.setButtonText('测试').onClick(async () => {
          b.setDisabled(true)
          await this.plugin.testConnection()
          b.setDisabled(false)
        }),
      )

    const support = containerEl.createEl('p', { cls: 'ai-linzi-support' })
    support.setText('遇到任何问题,欢迎添加开发者 Alina霖子 微信:AlinaWang321')
  }
}

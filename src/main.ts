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
import {
  feedKnowledge,
  runDistribute,
  runSalesReview,
  runTopicRadar,
  runWechatWriter,
  writeOutput,
} from './actions'

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
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  serverUrl: 'https://chat.alinalinzi.com',
  token: '',
  attachNoteDefault: true,
  outputFolder: 'AI霖子输出',
  defaultNiche: '',
}

const VIEW_TYPE_CHAT = 'ai-linzi-chat'

// 与服务端 chat-core UIMessage 对齐的最小结构
interface WireMessage {
  id: string
  role: 'user' | 'assistant'
  parts: { type: 'text'; text: string }[]
}

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

    // 顶栏:新对话
    const topbar = root.createDiv({ cls: 'ai-linzi-topbar' })
    topbar.createSpan({ text: 'AI霖子 · 你的商业军师', cls: 'ai-linzi-title' })
    const newBtn = topbar.createEl('button', { text: '新对话', cls: 'ai-linzi-newchat' })
    newBtn.onclick = () => {
      this.messages = []
      this.sessionId = uid()
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
  }

  private async currentNoteContext(): Promise<{ filename: string; text: string } | undefined> {
    if (!this.attachNote) return undefined
    const file = this.app.workspace.getActiveFile()
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
        return
      }
      const noteContext = await this.currentNoteContext()
      // M3:优先流式(fetch 纯文本流,逐块显示);CORS/网络不支持时自动回落非流式;
      // 业务错误(积分不足/tier/限流)不回落不重发,直接显示。
      let answer: string
      let streamed: { kind: 'ok'; text: string } | { kind: 'bizError'; message: string } | null
      try {
        streamed = await this.sendStreaming(noteContext)
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
          },
        })
        answer = typeof data.text === 'string' ? data.text : '(空响应)'
      }
      this.messages.push({ id: uid(), role: 'assistant', parts: [{ type: 'text', text: answer }] })
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
    const firstUser = this.messages.find((m) => m.role === 'user')
    const hint = firstUser ? firstUser.parts.map((p) => p.text).join('').slice(0, 24) : '访谈成稿'
    const f = await writeOutput(this.plugin, {
      skill: '访谈写作',
      platform: '公众号',
      title: `访谈成稿_${hint}`,
      body,
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
        body.setText(full)
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
    for (const m of this.messages) {
      const row = this.listEl.createDiv({
        cls: `ai-linzi-msg ai-linzi-msg-${m.role}`,
      })
      const body = row.createDiv({ cls: 'ai-linzi-msg-body' })
      const text = m.parts.map((p) => p.text).join('')
      if (m.role === 'assistant') {
        void MarkdownRenderer.render(this.app, text, body, '', this)
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
      .setDesc('AI霖子 服务地址。本地联调填 http://localhost:3000')
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
      .setDesc('在 AI霖子 网页「我的」页生成。⚠️ 不要把含 Token 的 vault 配置分享给别人。')
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
      .setName('产出落盘文件夹')
      .setDesc('技能生成的内容保存到这里(只新建不覆盖)。相对 vault 根路径。')
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
      .setDesc('验证地址与 Token 是否可用,并显示账号与积分余额')
      .addButton((b) =>
        b.setButtonText('测试').onClick(async () => {
          b.setDisabled(true)
          await this.plugin.testConnection()
          b.setDisabled(false)
        }),
      )
  }
}

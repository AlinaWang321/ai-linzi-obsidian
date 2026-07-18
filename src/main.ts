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
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  requestUrl,
} from 'obsidian'
import {
  feedKnowledge,
  runDistribute,
  runSalesReview,
  runTopicRadar,
  runWechatWriter,
} from './actions'

// ── 设置 ──────────────────────────────────────────────

interface AiLinziSettings {
  serverUrl: string
  token: string
  /** 「带上当前笔记」开关的默认值 */
  attachNoteDefault: boolean
  /** 技能产出落盘的文件夹(相对 vault 根) */
  outputFolder: string
  /** 选题雷达默认赛道描述(跑一次后自动记住) */
  defaultNiche: string
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  // 本地联调默认;正式发布版改为生产地址
  serverUrl: 'http://localhost:3000',
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

// ── 插件主体 ──────────────────────────────────────────

export default class AiLinziPlugin extends Plugin {
  settings: AiLinziSettings = DEFAULT_SETTINGS

  async onload() {
    await this.loadSettings()

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

    // ── M2:四技能 + 喂库(笔记即输入) ──
    const skillCommands: { id: string; name: string; fn: (p: AiLinziPlugin) => Promise<void> }[] = [
      { id: 'topic-radar', name: '选题雷达:从当前笔记提炼选题', fn: runTopicRadar },
      { id: 'wechat-writer', name: '公众号写作:当前笔记作素材', fn: runWechatWriter },
      { id: 'distribute', name: '多平台分发:当前笔记成稿 → 小红书/口播/朋友圈', fn: runDistribute },
      { id: 'sales-review', name: '谈单复盘:诊断当前逐字稿', fn: runSalesReview },
      { id: 'feed-knowledge', name: '喂库:把当前笔记存入 AI霖子知识库', fn: feedKnowledge },
    ]
    for (const c of skillCommands) {
      this.addCommand({ id: c.id, name: c.name, callback: () => void c.fn(this) })
    }

    // 编辑器右键菜单
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu) => {
        for (const c of skillCommands) {
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

    this.listEl = root.createDiv({ cls: 'ai-linzi-messages' })

    // 底部输入区
    const footer = root.createDiv({ cls: 'ai-linzi-footer' })

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
      attr: { placeholder: '问军师任何事…(Enter 发送,Shift+Enter 换行)' },
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
      const noteContext = await this.currentNoteContext()
      const data = await this.plugin.api('/api/plugin/chat', {
        method: 'POST',
        body: {
          messages: this.messages,
          sessionId: this.sessionId,
          stream: false, // M1:非流式兜底;M3 升级流式
          noteContext,
        },
      })
      const answer = typeof data.text === 'string' ? data.text : '(空响应)'
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
      row.createDiv({ cls: 'ai-linzi-msg-body', text: '军师思考中…' })
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

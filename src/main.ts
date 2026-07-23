/**
 * AI霖子 Obsidian 插件 · 学员内容工作流
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
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
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
  chooseComputerAiImageReferences,
  chooseVaultAiImageReference,
  feedKnowledge,
  generateAiImage,
  generateArticleIllustrationFromChat,
  insertSavedAiImageIntoCurrentNote,
  insertChatIllustrationIntoNote,
  runArticleIllustration,
  runArticleIllustrationEdit,
  runDistribute,
  runSalesReview,
  runTopicRadar,
  runWechatWriter,
  writeOutput,
  saveAiImageToVault,
  vaultImageToReferenceDataUrl,
  type AiImageRatio,
  type ChatIllustrationCandidate,
  type LocalImageReference,
} from './actions'
import {
  extractPluginSkillSuggestions,
  isArticleIllustrationEditIntent,
  isSingleArticleIllustrationIntent,
  type PluginSkillSuggestion,
} from './skill-suggest'
import {
  ContentDashboardView,
  VIEW_TYPE_CONTENT_DASHBOARD,
} from './content-dashboard'

/** 五个动作的唯一清单:命令面板、正文右键、对话面板按钮三个入口共用 */
export const SKILL_ACTIONS: {
  id: string
  name: string
  fn: (p: AiLinziPlugin) => Promise<void>
}[] = [
  { id: 'topic-radar', name: '选题雷达:结合定位与知识库生成选题', fn: runTopicRadar },
  { id: 'wechat-writer', name: '公众号写作:当前笔记作素材', fn: runWechatWriter },
  {
    id: 'interview',
    name: '公众号原创访谈写作:AI 采访你 → 写成公众号长文',
    fn: async (p) => p.startInterview(),
  },
  { id: 'distribute', name: '多平台分发:当前笔记成稿 → 小红书/口播/朋友圈', fn: runDistribute },
  { id: 'sales-review', name: '谈单复盘:诊断当前逐字稿', fn: runSalesReview },
  { id: 'illustration', name: '文章配图:可使用你的专属人偶(先看方案再生图)', fn: runArticleIllustration },
  { id: 'wechat-copy', name: '公众号排版:一键复制(去后台粘贴)', fn: async (p) => copyWechatFormatted(p) },
  { id: 'wechat-draft', name: '发到公众号草稿箱(自动传图,需配置AppID)', fn: async (p) => sendToWechatDraft(p) },
  { id: 'feed-knowledge', name: '喂库:把当前笔记存入 AI霖子知识库', fn: feedKnowledge },
]

// ── 设置 ──────────────────────────────────────────────

interface AiLinziSettings {
  serverUrl: string
  /** SecretStorage 中保存 AI霖子连接密钥的条目名，不保存密钥明文 */
  tokenSecretId: string
  /** 「带上当前笔记」开关的默认值 */
  attachNoteDefault: boolean
  /** 技能产出落盘的文件夹(相对 vault 根) */
  outputFolder: string
  /** 公众号一键配图使用的专属人偶参考图，只保存用户 Vault 内的路径 */
  illustrationCharacterReferencePath: string
  /** 选题雷达默认受众(跑一次后自动记住;历史key沿用defaultNiche兼容旧设置) */
  defaultNiche: string
  /** 上次自动检查更新的时间戳(约每20小时一次) */
  lastUpdateCheckAt?: number
  /** 公众号发布(选配):AppID 可留在普通设置，AppSecret 只存 SecretStorage */
  wechatAppId: string
  wechatAppSecretId: string
  /** 文末品牌小卡「排版与配图 · AI霖子」(默认开,可关) */
  brandFooter: boolean
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  serverUrl: 'https://chat.alinalinzi.com',
  tokenSecretId: '',
  attachNoteDefault: true,
  outputFolder: 'AI霖子输出',
  illustrationCharacterReferencePath: '',
  defaultNiche: '',
  wechatAppId: '',
  wechatAppSecretId: '',
  brandFooter: true,
}

interface LegacyAiLinziSettings extends Partial<AiLinziSettings> {
  /** v0.5.1 及以前曾把这两个敏感值明文写进 data.json，仅用于一次性迁移 */
  token?: string
  wechatAppSecret?: string
}

const DEFAULT_TOKEN_SECRET_ID = 'ai-linzi-api-token'
const DEFAULT_WECHAT_SECRET_ID = 'ai-linzi-wechat-app-secret'
const OFFICIAL_SERVER_URL = 'https://chat.alinalinzi.com'

const VIEW_TYPE_CHAT = 'ai-linzi-chat'

// 与服务端 chat-core UIMessage 对齐的最小结构
interface WireMessage {
  id: string
  role: 'user' | 'assistant'
  parts: { type: 'text'; text: string }[]
  /** 只保存在插件本机历史；发送给主对话 API 时会被剥离。 */
  imageResult?: ChatIllustrationCandidate
  /** 主对话生图模式的本地图片卡片；图片已自动落到用户 Vault，不上传本地路径。 */
  aiImageResult?: ChatAiImageResult
}

interface ChatAiImageResult {
  kind: 'ai-image'
  imageUrl: string
  savedPath: string
  instruction: string
  ratio: AiImageRatio
  articleCandidate?: ChatIllustrationCandidate
  insertedNotePath?: string
}

/** 本地保存的会话(存插件目录 conversations.json,升级/重启不丢) */
interface SavedConvo {
  id: string
  mode: 'chat' | 'interview'
  title: string
  updatedAt: number
  messages: WireMessage[]
}

interface CloudSessionSummary {
  sessionId: string
  preview: string
  title: string | null
  lastActivity: string
  messageCount: number
}

interface ChatHistoryEntry {
  kind: 'cloud' | 'local'
  id: string
  title: string
  updatedAt: number
  mode: 'chat' | 'interview'
  convo?: SavedConvo
}

/**
 * 插件历史管理窗口。每条会话的“打开”和“删除”分开，避免用户只能清空全部。
 * 删除回调仍由 ChatView 执行，以便同时收窄云端 obsidian: 会话与本机缓存。
 */
class ChatHistoryModal extends Modal {
  constructor(
    app: App,
    private entries: ChatHistoryEntry[],
    private readonly currentSessionId: string,
    private readonly onOpenEntry: (entry: ChatHistoryEntry) => Promise<void>,
    private readonly onDeleteEntry: (entry: ChatHistoryEntry) => Promise<void>,
    private readonly onClearAll: () => Promise<void>,
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-history-modal')
    this.renderHistory()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private renderHistory(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h2', { text: '插件对话历史' })
    contentEl.createDiv({
      text: '这里只显示 AI霖子 Obsidian 插件产生的对话，不包含网页版和微信端历史。',
      cls: 'ai-linzi-history-note',
    })

    if (this.entries.length === 0) {
      contentEl.createDiv({ text: '还没有插件对话历史', cls: 'ai-linzi-history-empty' })
      return
    }

    const list = contentEl.createDiv({ cls: 'ai-linzi-history-list' })
    for (const entry of this.entries) {
      const row = list.createDiv({ cls: 'ai-linzi-history-row' })
      const summary = row.createDiv({ cls: 'ai-linzi-history-summary' })
      const titleRow = summary.createDiv({ cls: 'ai-linzi-history-title-row' })
      titleRow.createSpan({
        text: `${entry.mode === 'interview' ? '✍️ ' : ''}${entry.title.slice(0, 60) || '未命名对话'}`,
        cls: 'ai-linzi-history-title',
      })
      if (entry.id === this.currentSessionId) {
        titleRow.createSpan({ text: '当前', cls: 'ai-linzi-history-current' })
      }
      const timestamp =
        Number.isFinite(entry.updatedAt) && entry.updatedAt > 0
          ? new Date(entry.updatedAt).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '时间未知'
      summary.createDiv({ text: timestamp, cls: 'ai-linzi-history-time' })

      const actions = row.createDiv({ cls: 'ai-linzi-history-actions' })
      const openButton = actions.createEl('button', { text: '打开' })
      openButton.onclick = async () => {
        openButton.disabled = true
        try {
          await this.onOpenEntry(entry)
          this.close()
        } catch (error) {
          new Notice(`恢复对话失败:${error instanceof Error ? error.message : String(error)}`)
          openButton.disabled = false
        }
      }
      const deleteButton = actions.createEl('button', {
        text: '删除',
        cls: 'ai-linzi-history-delete',
      })
      deleteButton.onclick = async () => {
        const confirmed = window.confirm(
          `确定删除这条插件对话“${entry.title.slice(0, 30) || '未命名对话'}”吗？\n\n只会删除这一条 AI霖子 Obsidian 插件对话；其他插件对话、网页版和微信端对话都不受影响。删除后不可恢复。`,
        )
        if (!confirmed) return
        deleteButton.disabled = true
        try {
          await this.onDeleteEntry(entry)
          this.entries = this.entries.filter((item) => item.id !== entry.id)
          this.renderHistory()
        } catch (error) {
          new Notice(`删除这条对话失败:${error instanceof Error ? error.message : String(error)}`)
          deleteButton.disabled = false
        }
      }
    }

    const footer = contentEl.createDiv({ cls: 'ai-linzi-history-footer' })
    const clearButton = footer.createEl('button', {
      text: '清空全部插件对话',
      cls: 'ai-linzi-history-clear',
    })
    clearButton.onclick = async () => {
      const confirmed = window.confirm(
        '确定清空 AI霖子 Obsidian 插件产生的云端及本机历史吗？此操作不可恢复；网页版和微信端对话不会被删除，已「存为笔记」的成稿不受影响。',
      )
      if (!confirmed) return
      clearButton.disabled = true
      try {
        await this.onClearAll()
        this.entries = []
        this.renderHistory()
      } catch (error) {
        new Notice(`清空历史失败:${error instanceof Error ? error.message : String(error)}`)
        clearButton.disabled = false
      }
    }
  }
}

const MAX_SAVED_CONVOS = 30
const PLUGIN_SESSION_PREFIX = 'obsidian:'

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 插件会话必须使用独立命名空间。服务端只允许插件历史接口读取/删除这个前缀，
 * 因而网页端会话不会被插件历史列表拉回，也不会被插件的“清空历史”误删。
 */
function normalizePluginSessionId(value?: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return `${PLUGIN_SESSION_PREFIX}${uid()}`
  return trimmed.startsWith(PLUGIN_SESSION_PREFIX) ? trimmed : `${PLUGIN_SESSION_PREFIX}${trimmed}`
}

function newPluginSessionId(): string {
  return normalizePluginSessionId(uid())
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function responseHeader(headers: Record<string, string>, wanted: string): string {
  const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted.toLowerCase())
  return hit?.[1] ?? ''
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
    this.registerView(VIEW_TYPE_CONTENT_DASHBOARD, (leaf) => new ContentDashboardView(leaf, this))

    this.addRibbonIcon('sparkles', 'AI霖子对话', () => this.activateChatView())
    this.addRibbonIcon('layout-dashboard', 'AI霖子内容发布看板', () => this.activateContentDashboard())

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

    this.addCommand({
      id: 'open-content-dashboard',
      name: '打开内容发布看板',
      callback: () => this.activateContentDashboard(),
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
    const raw = ((await this.loadData()) ?? {}) as LegacyAiLinziSettings
    const { token: legacyToken, wechatAppSecret: legacyWechatSecret, ...safeSettings } = raw
    this.settings = Object.assign({}, DEFAULT_SETTINGS, safeSettings)
    let migrated = false
    // 学员正式版只连接 AI霖子官方后端，避免误按第三方教程把连接密钥和笔记
    // 发送到陌生服务器。localhost 仅保留给本机开发联调。
    if (
      this.settings.serverUrl !== OFFICIAL_SERVER_URL &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/i.test(this.settings.serverUrl)
    ) {
      this.settings.serverUrl = OFFICIAL_SERVER_URL
      migrated = true
    }

    // v0.6.0：首次启动自动把旧 data.json 里的明文密钥迁到 Obsidian SecretStorage，
    // 随后立刻重写 data.json，只留下 SecretStorage 条目名。
    if (legacyToken?.trim()) {
      const id = this.settings.tokenSecretId || DEFAULT_TOKEN_SECRET_ID
      this.app.secretStorage.setSecret(id, legacyToken.trim())
      this.settings.tokenSecretId = id
      migrated = true
    }
    if (legacyWechatSecret?.trim()) {
      const id = this.settings.wechatAppSecretId || DEFAULT_WECHAT_SECRET_ID
      this.app.secretStorage.setSecret(id, legacyWechatSecret.trim())
      this.settings.wechatAppSecretId = id
      migrated = true
    }
    if (migrated) await this.saveSettings()
  }

  getApiToken(): string {
    const id = this.settings.tokenSecretId.trim()
    return id ? this.app.secretStorage.getSecret(id)?.trim() ?? '' : ''
  }

  getWechatAppSecret(): string {
    const id = this.settings.wechatAppSecretId.trim()
    return id ? this.app.secretStorage.getSecret(id)?.trim() ?? '' : ''
  }

  // ── 会话本地持久化(独立文件,不进 data.json 防设置写放大) ──

  private convosPath(): string {
    return `${this.manifest.dir}/conversations.json`
  }

  async loadConvos(): Promise<SavedConvo[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.convosPath())
      const list = JSON.parse(raw) as SavedConvo[]
      // conversations.json 本来就只保存插件对话。旧版本的普通 UUID 在本机读取时
      // 安全迁入 obsidian: 命名空间；无法辨认来源的旧云端 UUID 则不做迁移。
      return Array.isArray(list)
        ? list.map((convo) => ({ ...convo, id: normalizePluginSessionId(convo.id) }))
        : []
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

  async deleteConvo(sessionId: string): Promise<void> {
    const targetId = normalizePluginSessionId(sessionId)
    const list = (await this.loadConvos()).filter((convo) => convo.id !== targetId)
    await this.app.vault.adapter.write(this.convosPath(), JSON.stringify(list.slice(0, MAX_SAVED_CONVOS)))
  }

  async loadCloudSessions(): Promise<CloudSessionSummary[]> {
    const data = await this.api('/api/plugin/v1/chat/sessions')
    return Array.isArray(data.sessions) ? (data.sessions as CloudSessionSummary[]) : []
  }

  async loadCloudConvo(sessionId?: string): Promise<SavedConvo | null> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const data = await this.api(`/api/plugin/v1/chat/history${query}`)
    const id = typeof data.sessionId === 'string' ? data.sessionId : ''
    const rows = Array.isArray(data.messages)
      ? (data.messages as Array<{ id?: unknown; role?: unknown; content?: unknown; createdAt?: unknown }>)
      : []
    if (!id || rows.length === 0) return null
    const messages: WireMessage[] = rows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        id: String(row.id ?? uid()),
        role: row.role as 'user' | 'assistant',
        parts: [{ type: 'text' as const, text: String(row.content ?? '') }],
      }))
    const firstUser = messages.find((message) => message.role === 'user')
    const lastCreatedAt = String(rows.at(-1)?.createdAt ?? '')
    return {
      id,
      mode: 'chat',
      title: (firstUser?.parts.map((part) => part.text).join('') ?? '云端对话').slice(0, 24),
      updatedAt: Number.isFinite(Date.parse(lastCreatedAt)) ? Date.parse(lastCreatedAt) : Date.now(),
      messages,
    }
  }

  async deleteAllCloudConvos(): Promise<void> {
    await this.api('/api/plugin/v1/chat/history', { method: 'DELETE' })
  }

  async deleteCloudConvo(sessionId: string): Promise<void> {
    const targetId = normalizePluginSessionId(sessionId)
    await this.api(`/api/plugin/v1/chat/history?sessionId=${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
    })
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

  async activateContentDashboard() {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CONTENT_DASHBOARD)
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getLeaf('tab')
    await leaf.setViewState({ type: VIEW_TYPE_CONTENT_DASHBOARD, active: true })
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
    const { serverUrl } = this.settings
    const token = this.getApiToken()
    if (!serverUrl || !token) {
      throw new Error('请先在设置里填写服务器地址和 Token')
    }
    const res = await requestUrl({
      url: `${serverUrl.replace(/\/+$/, '')}${path}`,
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-AI-Linzi-Plugin-Version': this.manifest.version,
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
    const minPluginVersion = responseHeader(res.headers, 'X-AI-Linzi-Min-Plugin-Version')
    if (minPluginVersion && compareVersions(this.manifest.version, minPluginVersion) < 0) {
      throw new Error(
        `当前插件版本 ${this.manifest.version} 已不再兼容服务器，请先更新到 ${minPluginVersion} 或更高版本`,
      )
    }
    if (res.status >= 400) {
      const timeout = /FUNCTION_INVOCATION_TIMEOUT|Task timed out|exceeded.*duration/i.test(res.text ?? '')
      const msg =
        typeof data.error === 'string'
          ? data.error
          : timeout
            ? '生成时间超过服务上限。系统没有写入残缺图片，请稍后重试。'
            : `请求失败(${res.status})`
      const supportId = typeof data.requestId === 'string' ? `（问题编号：${data.requestId}）` : ''
      throw new Error(`${msg}${supportId}`)
    }
    return data
  }

  /**
   * 调用返回纯文本流的技能路由(toTextStreamResponse)。
   * requestUrl 会把流缓冲成完整文本;错误时这些路由返回 JSON,这里解析出友好文案。
   */
  async apiText(path: string, body: unknown): Promise<string> {
    const { serverUrl } = this.settings
    const token = this.getApiToken()
    if (!serverUrl || !token) {
      throw new Error('请先在设置里填写服务器地址和 Token')
    }
    const res = await requestUrl({
      url: `${serverUrl.replace(/\/+$/, '')}${path}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-AI-Linzi-Plugin-Version': this.manifest.version,
      },
      body: JSON.stringify(body),
      throw: false,
    })
    if (res.status >= 400) {
      let msg = `请求失败(${res.status})`
      try {
        const data = JSON.parse(res.text) as { error?: string; requestId?: string }
        if (typeof data.error === 'string') msg = data.error
        if (typeof data.requestId === 'string') msg += `（问题编号：${data.requestId}）`
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
      const data = await this.api('/api/plugin/v1/capabilities')
      new Notice(
        `✅ 已连接 AI霖子\n学号:${data.studentNo}\ntier:${data.tier}\n插件 API:v${data.apiVersion}`,
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
  private sessionId = newPluginSessionId()
  private attachNote: boolean
  private imageMode = false
  private imageRatio: AiImageRatio = '16:9'
  private imageReferences: LocalImageReference[] = []
  private activeImageMessageId = ''
  private usePreviousImage = true
  private sending = false
  /** chat=日常对话;interview=访谈写作(多轮采访→成稿) */
  private mode: 'chat' | 'interview' = 'chat'
  private interviewBar!: HTMLElement

  private listEl!: HTMLElement
  private inputEl!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private attachToggleEl!: HTMLInputElement
  private imageToggleEl!: HTMLInputElement
  private imageModeBtn!: HTMLButtonElement
  private imageRatioEl!: HTMLSelectElement
  private imageUsePreviousEl!: HTMLInputElement
  private imageOptionsEl!: HTMLElement
  private imageReferenceStatusEl!: HTMLElement

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
    histBtn.onclick = () => void this.showHistoryMenu()
    const newBtn = btns.createEl('button', { text: '新对话', cls: 'ai-linzi-newchat' })
    newBtn.onclick = () => {
      void this.persistNow() // 旧对话先落盘
      this.messages = []
      this.sessionId = newPluginSessionId()
      this.activeImageMessageId = ''
      this.usePreviousImage = true
      if (this.mode === 'interview') this.exitInterviewMode()
      this.refreshImageModeUi()
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
    this.imageModeBtn = actionsRow.createEl('button', { text: '🖼️ 用 AI 生图', cls: 'ai-linzi-action-btn' })
    this.imageModeBtn.onclick = () => this.setImageMode(!this.imageMode)
    const dashboardBtn = actionsRow.createEl('button', { text: '📊 内容看板', cls: 'ai-linzi-action-btn' })
    dashboardBtn.onclick = () => void this.plugin.activateContentDashboard()
    actionsRow.createSpan({ text: '技能是否使用当前笔记，以弹窗说明为准', cls: 'ai-linzi-actions-hint' })

    const toggleRow = footer.createDiv({ cls: 'ai-linzi-toggle-row' })
    const label = toggleRow.createEl('label', { cls: 'ai-linzi-toggle' })
    this.attachToggleEl = label.createEl('input', { type: 'checkbox' })
    this.attachToggleEl.checked = this.attachNote
    this.attachToggleEl.onchange = () => {
      this.attachNote = this.attachToggleEl.checked
      this.refreshImageModeUi()
    }
    label.createSpan({ text: ' 主对话带上当前笔记' })

    const imageLabel = toggleRow.createEl('label', { cls: 'ai-linzi-toggle ai-linzi-image-toggle' })
    this.imageToggleEl = imageLabel.createEl('input', { type: 'checkbox' })
    this.imageToggleEl.checked = false
    this.imageToggleEl.onchange = () => this.setImageMode(this.imageToggleEl.checked)
    imageLabel.createSpan({ text: ' AI 生图模式' })

    this.imageOptionsEl = footer.createDiv({ cls: 'ai-linzi-image-mode-options' })
    this.imageOptionsEl.createSpan({ text: '图片比例' })
    this.imageRatioEl = this.imageOptionsEl.createEl('select', { cls: 'dropdown' })
    for (const [value, labelText] of [
      ['16:9', '16:9 横版'],
      ['3:4', '3:4 竖版'],
      ['1:1', '1:1 方图'],
    ] as const) {
      this.imageRatioEl.createEl('option', { value, text: labelText })
    }
    this.imageRatioEl.value = this.imageRatio
    this.imageRatioEl.onchange = () => {
      const value = this.imageRatioEl.value
      this.imageRatio = value === '3:4' || value === '1:1' ? value : '16:9'
    }
    const addReferenceBtn = this.imageOptionsEl.createEl('button', { text: '添加参考图' })
    addReferenceBtn.onclick = (event) => {
      const menu = new Menu()
      menu.addItem((item) =>
        item.setTitle('从 Vault 选择').setIcon('image').onClick(() => this.addVaultImageReference()),
      )
      menu.addItem((item) =>
        item.setTitle('从电脑选择').setIcon('folder-open').onClick(() => this.addComputerImageReferences()),
      )
      menu.showAtMouseEvent(event)
    }
    const clearReferencesBtn = this.imageOptionsEl.createEl('button', { text: '清除参考图' })
    clearReferencesBtn.onclick = () => {
      this.imageReferences = []
      this.refreshImageModeUi()
    }
    const previousLabel = this.imageOptionsEl.createEl('label', { cls: 'ai-linzi-image-previous-toggle' })
    this.imageUsePreviousEl = previousLabel.createEl('input', { type: 'checkbox' })
    this.imageUsePreviousEl.checked = this.usePreviousImage
    this.imageUsePreviousEl.onchange = () => {
      this.usePreviousImage = this.imageUsePreviousEl.checked
      this.refreshImageModeUi()
    }
    previousLabel.createSpan({ text: ' 参考上一张图' })
    this.imageReferenceStatusEl = this.imageOptionsEl.createSpan({ cls: 'ai-linzi-image-reference-status' })

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

    this.refreshImageModeUi()

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
    const [latestLocal] = await this.plugin.loadConvos()
    try {
      const [latestCloudSummary] = await this.plugin.loadCloudSessions()
      const cloudTime = latestCloudSummary ? Date.parse(latestCloudSummary.lastActivity) : 0
      const sameSession = Boolean(
        latestCloudSummary && latestLocal
        && normalizePluginSessionId(latestCloudSummary.sessionId) === normalizePluginSessionId(latestLocal.id),
      )
      const localHasImageCards = Boolean(
        latestLocal?.messages.some((message) => message.aiImageResult || message.imageResult),
      )
      const preserveRicherLocalCopy = sameSession && localHasImageCards
      if (latestCloudSummary && (!latestLocal || (cloudTime > latestLocal.updatedAt && !preserveRicherLocalCopy))) {
        const cloud = await this.plugin.loadCloudConvo(latestCloudSummary.sessionId)
        if (cloud?.messages.length) {
          this.loadConvo(cloud)
          return
        }
      }
    } catch {
      // 离线或旧服务器尚未部署 v1 历史接口时，继续使用本机缓存。
    }
    if (latestLocal?.messages.length) this.loadConvo(latestLocal)
  }

  private loadConvo(c: SavedConvo): void {
    this.messages = c.messages
    this.sessionId = normalizePluginSessionId(c.id)
    if (c.mode === 'interview' && this.mode !== 'interview') {
      this.mode = 'interview'
      this.interviewBar.show()
      this.inputEl.placeholder = '先告诉 AI 你想写什么方向(一句话),它会开始采访你…'
    } else if (c.mode === 'chat' && this.mode === 'interview') {
      this.mode = 'chat'
      this.interviewBar.hide()
      this.inputEl.placeholder = '问 AI霖子 任何事…(Enter 发送,Shift+Enter 换行)'
    }
    this.refreshImageModeUi()
    this.renderMessages()
  }

  private setImageMode(active: boolean): void {
    if (this.mode === 'interview' && active) {
      new Notice('请先结束访谈写作，再进入 AI 生图模式')
      this.refreshImageModeUi()
      return
    }
    this.imageMode = active
    this.refreshImageModeUi()
    if (active) this.inputEl.focus()
  }

  private refreshImageModeUi(): void {
    if (!this.inputEl) return
    this.imageToggleEl.checked = this.imageMode
    this.imageModeBtn.toggleClass('is-active', this.imageMode)
    this.imageModeBtn.setText(this.imageMode ? '✅ AI 生图模式' : '🖼️ 用 AI 生图')
    this.imageOptionsEl.toggle(this.imageMode)
    this.imageRatioEl.value = this.imageRatio
    const hasPreviousImage = Boolean(this.latestImageModeResult())
    this.imageUsePreviousEl.disabled = !hasPreviousImage
    this.imageUsePreviousEl.checked = hasPreviousImage && this.usePreviousImage
    this.imageReferenceStatusEl.setText(
      this.imageReferences.length > 0
        ? `已添加 ${this.imageReferences.length} 张参考图`
        : hasPreviousImage && this.usePreviousImage
          ? '下一轮会继续修改上一张图'
          : '下一轮会生成一张新图',
    )
    this.inputEl.placeholder = this.imageMode
      ? this.attachNote
        ? '描述要给当前笔记生成的图片；下一轮可直接说怎么修改…'
        : '描述要生成的图片；下一轮可直接说怎么修改…'
      : '问 AI霖子 任何事…(Enter 发送,Shift+Enter 换行)'
    this.sendBtn.setText(this.imageMode ? '生成图片' : '发送')
  }

  private addVaultImageReference(): void {
    if (this.imageReferences.length >= 3) {
      new Notice('参考图最多 3 张')
      return
    }
    chooseVaultAiImageReference(this.plugin, (reference) => {
      this.imageReferences.push(reference)
      this.refreshImageModeUi()
    })
  }

  private addComputerImageReferences(): void {
    if (this.imageReferences.length >= 3) {
      new Notice('参考图最多 3 张')
      return
    }
    chooseComputerAiImageReferences(3 - this.imageReferences.length, (references) => {
      this.imageReferences.push(...references)
      this.refreshImageModeUi()
    })
  }

  private async showHistoryMenu(): Promise<void> {
    await this.persistNow()
    const localConvos = await this.plugin.loadConvos()
    let cloudSessions: CloudSessionSummary[] = []
    try {
      cloudSessions = await this.plugin.loadCloudSessions()
    } catch {
      // 云端不可用时历史菜单仍能展示本机缓存。
    }
    const cloudIds = new Set(cloudSessions.map((session) => session.sessionId))
    const localById = new Map(localConvos.map((convo) => [convo.id, convo]))
    const items: ChatHistoryEntry[] = cloudSessions.map((session) => {
      const local = localById.get(session.sessionId)
      return {
        kind: 'cloud' as const,
        id: session.sessionId,
        title: session.title || session.preview || '云端对话',
        updatedAt: Math.max(Date.parse(session.lastActivity) || 0, local?.updatedAt ?? 0),
        mode: local?.mode ?? 'chat',
        // 云端保存标准文字历史；本地副本还包含待确认图片卡片，打开时应优先保留它。
        convo: local,
      }
    })
    for (const convo of localConvos) {
      if (cloudIds.has(convo.id)) continue
      items.push({
        kind: 'local',
        id: convo.id,
        convo,
        title: convo.title,
        updatedAt: convo.updatedAt,
        mode: convo.mode,
      })
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    new ChatHistoryModal(
      this.app,
      items.slice(0, MAX_SAVED_CONVOS),
      this.sessionId,
      async (item) => {
        if (item.convo) {
          this.loadConvo(item.convo)
          return
        }
        const convo = await this.plugin.loadCloudConvo(item.id)
        if (!convo) throw new Error('云端没有找到这条对话')
        this.loadConvo(convo)
      },
      async (item) => {
        await this.plugin.deleteCloudConvo(item.id)
        await this.plugin.deleteConvo(item.id)
        if (item.id === this.sessionId) {
          if (this.mode === 'interview') this.exitInterviewMode()
          else {
            this.messages = []
            this.sessionId = newPluginSessionId()
            this.renderMessages()
          }
        }
        new Notice('已删除这条插件对话；其他插件、网页版和微信端对话未受影响')
      },
      async () => {
        await Promise.all([this.plugin.deleteAllCloudConvos(), this.plugin.deleteAllConvos()])
        if (this.mode === 'interview') this.exitInterviewMode()
        else {
          this.messages = []
          this.sessionId = newPluginSessionId()
          this.renderMessages()
        }
        new Notice('插件产生的云端及本机历史已清空；网页版和微信端对话未受影响')
      },
    ).open()
  }

  private async currentNoteContext(): Promise<{ filename: string; text: string; path: string } | undefined> {
    if (!this.attachNote) return undefined
    const file = this.app.workspace.getActiveFile() ?? this.plugin.lastActiveFile
    if (!file) return undefined
    const text = await this.app.vault.cachedRead(file)
    if (!text.trim()) return undefined
    return { filename: file.name, text, path: file.path }
  }

  /** 本地候选图片元数据绝不传给主对话；云端只收到标准 UIMessage。 */
  private messagesForApi(): WireMessage[] {
    return this.messages.map(({ id, role, parts }) => ({ id, role, parts }))
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
      if (this.imageMode) {
        await this.sendImageModePrompt(text)
        return
      }
      const noteContext = await this.currentNoteContext()
      // “修改第一张图片/封面”属于配图修改，不得误送进正文局部补丁协议。
      // 图片修改会在 AI 回复下方显示专用入口，先预览候选图再由用户确认替换。
      const illustrationEdit = isArticleIllustrationEditIntent(text)
      const singleIllustration = Boolean(noteContext && isSingleArticleIllustrationIntent(text))
      const noteEdit = Boolean(
        noteContext && !illustrationEdit && !singleIllustration && isNoteEditIntent(text),
      )
      // M3:优先流式(fetch 纯文本流,逐块显示);CORS/网络不支持时自动回落非流式;
      // 业务错误(积分不足/tier/限流)不回落不重发,直接显示。
      let answer: string
      let streamed: { kind: 'ok'; text: string } | { kind: 'bizError'; message: string } | null
      try {
        streamed = await this.sendStreaming(noteContext, noteEdit, singleIllustration)
      } catch {
        streamed = null
      }
      if (streamed?.kind === 'bizError') {
        answer = `⚠️ ${streamed.message}`
      } else if (streamed?.kind === 'ok') {
        answer = streamed.text
      } else {
        const data = await this.plugin.api('/api/plugin/v1/chat', {
          method: 'POST',
          body: {
            messages: this.messagesForApi(),
            sessionId: this.sessionId,
            stream: false,
            noteContext,
            noteEdit,
            noteImageIntent: singleIllustration,
          },
        })
        answer = typeof data.text === 'string' ? data.text : '(空响应)'
      }
      this.messages.push({ id: uid(), role: 'assistant', parts: [{ type: 'text', text: answer }] })
      await this.persistNow()
      if (singleIllustration && noteContext && !answer.startsWith('⚠️')) {
        await this.generateChatIllustration(text, noteContext)
      }
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

  private latestImageModeResult(): { message: WireMessage; result: ChatAiImageResult } | null {
    const preferred = this.activeImageMessageId
      ? this.messages.find((message) => message.id === this.activeImageMessageId)
      : undefined
    if (preferred?.aiImageResult) return { message: preferred, result: preferred.aiImageResult }
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index]
      if (message.aiImageResult) return { message, result: message.aiImageResult }
    }
    return null
  }

  private async sendImageModePrompt(instruction: string): Promise<void> {
    const message: WireMessage = {
      id: uid(),
      role: 'assistant',
      parts: [{ type: 'text', text: 'AI 正在生成图片…' }],
    }
    this.messages.push(message)
    this.renderMessages()
    const notice = new Notice('🎨 AI 正在生成图片…', 0)
    try {
      const previous = this.usePreviousImage ? this.latestImageModeResult() : null
      const previousReference = previous
        ? await vaultImageToReferenceDataUrl(this.plugin, previous.result.savedPath)
        : undefined
      const references = [
        ...(previousReference ? [previousReference] : []),
        ...this.imageReferences.map((reference) => reference.dataUrl),
      ].slice(0, 3)
      const noteContext = await this.currentNoteContext()
      let imageUrl = ''
      let ratio: AiImageRatio = this.imageRatio
      let articleCandidate: ChatIllustrationCandidate | undefined
      if (noteContext) {
        articleCandidate = await generateArticleIllustrationFromChat(
          this.plugin,
          instruction,
          noteContext,
          { referenceImageDataUrl: references[0], sessionId: this.sessionId },
        )
        imageUrl = articleCandidate.imageUrl
        ratio = '16:9'
      } else {
        const generated = await generateAiImage(
          this.plugin,
          instruction,
          this.imageRatio,
          references,
          this.sessionId,
        )
        imageUrl = generated.imageUrl
        ratio = generated.ratio
      }
      const savedPath = await saveAiImageToVault(this.plugin, imageUrl, instruction)
      if (articleCandidate) articleCandidate.savedPath = savedPath
      message.aiImageResult = {
        kind: 'ai-image',
        imageUrl,
        savedPath,
        instruction,
        ratio,
        articleCandidate,
      }
      message.parts = [{
        type: 'text',
        text: articleCandidate
          ? `已结合当前笔记生成图片，并自动保存到 Vault。建议放在「${articleCandidate.anchor}」之后。继续输入要求可以修改这张图。`
          : '图片已生成并自动保存到 Vault。继续输入要求可以修改这张图。',
      }]
      this.activeImageMessageId = message.id
      // 新图成为后续修改的默认参考；用户仍可取消勾选来开启另一张新图。
      this.usePreviousImage = true
      this.imageReferences = []
    } catch (error) {
      message.parts = [{
        type: 'text',
        text: `⚠️ AI 生图失败：${error instanceof Error ? error.message : String(error)}`,
      }]
    } finally {
      notice.hide()
      await this.persistNow()
      this.refreshImageModeUi()
      this.renderMessages()
    }
  }

  private async generateChatIllustration(
    instruction: string,
    noteContext: { filename: string; text: string; path: string },
  ): Promise<void> {
    const message: WireMessage = {
      id: uid(),
      role: 'assistant',
      parts: [{ type: 'text', text: '正在结合当前笔记全文生成一张候选配图…' }],
    }
    this.messages.push(message)
    this.renderMessages()
    const notice = new Notice('🎨 正在读取文章并生成候选配图…', 0)
    try {
      const candidate = await generateArticleIllustrationFromChat(
        this.plugin,
        instruction,
        noteContext,
      )
      message.imageResult = candidate
      message.parts = [{
        type: 'text',
        text: `已根据当前笔记生成一张候选配图，准备放在「${candidate.anchor}」之后。请先预览，确认后再插入文章。`,
      }]
    } catch (error) {
      message.parts = [{
        type: 'text',
        text: `⚠️ 候选配图生成失败：${error instanceof Error ? error.message : String(error)}`,
      }]
    } finally {
      notice.hide()
      await this.persistNow()
      this.renderMessages()
    }
  }

  enterInterviewMode() {
    this.mode = 'interview'
    this.messages = []
    this.sessionId = newPluginSessionId()
    this.interviewBar.show()
    this.inputEl.placeholder = '先告诉 AI 你想写什么方向(一句话),它会开始采访你…'
    this.renderMessages()
    new Notice('✍️ 已进入访谈写作:先说你想写的方向', 5000)
  }

  exitInterviewMode() {
    this.mode = 'chat'
    this.messages = []
    this.sessionId = newPluginSessionId()
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
    const { serverUrl } = this.plugin.settings
    const token = this.plugin.getApiToken()
    if (!token) return '⚠️ 请先在设置里选择或新建 AI霖子连接密钥'
    const res = await requestUrl({
      url: `${serverUrl.replace(/\/+$/, '')}/api/plugin/v1/skills/wechat-interview`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-AI-Linzi-Plugin-Version': this.plugin.manifest.version,
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
    noteContext: { filename: string; text: string; path: string } | undefined,
    noteEdit: boolean,
    noteImageIntent: boolean,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'bizError'; message: string }> {
    const { serverUrl } = this.plugin.settings
    const token = this.plugin.getApiToken()
    if (!token) return { kind: 'bizError', message: '请先在设置里选择或新建 AI霖子连接密钥' }
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/plugin/v1/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-AI-Linzi-Plugin-Version': this.plugin.manifest.version,
      },
      body: JSON.stringify({
        messages: this.messagesForApi(),
        sessionId: this.sessionId,
        stream: 'text',
        noteContext,
        noteEdit,
        noteImageIntent,
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
        const illustrationEdit = isArticleIllustrationEditIntent(previousUserText)
        const editReply = this.mode === 'chat' && !illustrationEdit && isNoteEditIntent(previousUserText)
        void MarkdownRenderer.render(this.app, patch?.displayText ?? cleanText, body, '', this)
        if (m.imageResult) {
          this.renderChatIllustrationResult(row, m)
          continue
        }
        if (m.aiImageResult) {
          this.renderAiImageResult(row, m)
          continue
        }
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

  private renderAiImageResult(row: HTMLElement, message: WireMessage): void {
    const result = message.aiImageResult
    if (!result) return
    const card = row.createDiv({ cls: 'ai-linzi-chat-image-result' })
    const localFile = this.app.vault.getAbstractFileByPath(result.savedPath)
    const src = localFile instanceof TFile
      ? this.app.vault.getResourcePath(localFile)
      : result.imageUrl
    if (/^(?:app:|https?:\/\/|data:image\/)/i.test(src)) {
      card.createEl('img', { attr: { src, alt: 'AI 生成图片' } })
    } else {
      card.createDiv({ text: '图片文件已经移动或不存在。', cls: 'ai-linzi-image-error' })
    }
    const meta = card.createDiv({ cls: 'ai-linzi-chat-image-meta' })
    meta.createEl('strong', { text: `${result.ratio} · 已自动保存` })
    meta.createEl('span', { text: result.savedPath })
    if (result.articleCandidate) {
      meta.createEl('span', { text: `建议放在「${result.articleCandidate.anchor}」之后` })
    }
    const actions = card.createDiv({ cls: 'ai-linzi-chat-image-actions' })
    const continueBtn = actions.createEl('button', { text: '继续修改这张' })
    continueBtn.onclick = () => {
      this.activeImageMessageId = message.id
      this.usePreviousImage = true
      this.setImageMode(true)
      this.inputEl.placeholder = '直接写修改要求，例如：标题缩小，人物移到右边…'
      this.inputEl.focus()
    }
    const inserted = Boolean(result.articleCandidate?.insertedPath || result.insertedNotePath)
    const insertBtn = actions.createEl('button', {
      text: inserted ? '✅ 已插入当前笔记' : '插入当前笔记',
      cls: 'ai-linzi-apply-patch',
    })
    insertBtn.disabled = inserted
    insertBtn.onclick = async () => {
      insertBtn.disabled = true
      insertBtn.setText('正在插入…')
      try {
        if (result.articleCandidate) {
          result.articleCandidate.insertedPath = await insertChatIllustrationIntoNote(
            this.plugin,
            result.articleCandidate,
          )
        } else {
          await insertSavedAiImageIntoCurrentNote(this.plugin, result.savedPath)
          result.insertedNotePath = (this.app.workspace.getActiveFile() ?? this.plugin.lastActiveFile)?.path || '已插入'
        }
        await this.persistNow()
        this.renderMessages()
      } catch (error) {
        insertBtn.disabled = false
        insertBtn.setText('插入当前笔记')
        new Notice(`插入图片失败：${error instanceof Error ? error.message : String(error)}`, 9000)
      }
    }
  }

  private renderChatIllustrationResult(row: HTMLElement, message: WireMessage): void {
    const candidate = message.imageResult
    if (!candidate) return
    const card = row.createDiv({ cls: 'ai-linzi-chat-image-result' })
    if (/^(?:https?:\/\/|data:image\/)/i.test(candidate.imageUrl)) {
      card.createEl('img', {
        attr: { src: candidate.imageUrl, alt: candidate.title || 'AI 生成的文章配图' },
      })
    } else {
      card.createDiv({ text: '候选图片地址已失效，请重新生成。', cls: 'ai-linzi-image-error' })
    }
    const meta = card.createDiv({ cls: 'ai-linzi-chat-image-meta' })
    meta.createEl('strong', { text: candidate.title || '新增配图' })
    meta.createEl('span', { text: `放在「${candidate.anchor}」之后` })
    const actions = card.createDiv({ cls: 'ai-linzi-chat-image-actions' })
    const insertBtn = actions.createEl('button', {
      text: candidate.insertedPath ? '✅ 已插入当前笔记' : '插入当前笔记',
      cls: 'ai-linzi-apply-patch',
    })
    insertBtn.disabled = Boolean(candidate.insertedPath)
    insertBtn.onclick = async () => {
      insertBtn.disabled = true
      insertBtn.setText('正在插入…')
      try {
        candidate.insertedPath = await insertChatIllustrationIntoNote(this.plugin, candidate)
        await this.persistNow()
        this.renderMessages()
        new Notice(`✅ 配图已插入「${candidate.articleTitle}」对应段落`, 7000)
      } catch (error) {
        insertBtn.disabled = false
        insertBtn.setText('插入当前笔记')
        new Notice(`插入配图失败：${error instanceof Error ? error.message : String(error)}`, 9000)
      }
    }
    const regenerateBtn = actions.createEl('button', { text: '重新生成' })
    regenerateBtn.onclick = () => void this.regenerateChatIllustration(message)
  }

  private async regenerateChatIllustration(message: WireMessage): Promise<void> {
    const previous = message.imageResult
    if (!previous) return
    const file = this.app.vault.getAbstractFileByPath(previous.notePath)
    if (!(file instanceof TFile)) {
      new Notice('原笔记已经移动或不存在，无法重新生成')
      return
    }
    const notice = new Notice('🎨 正在结合当前文章重新生成候选图…', 0)
    try {
      message.imageResult = await generateArticleIllustrationFromChat(
        this.plugin,
        previous.instruction,
        { filename: file.name, text: await this.app.vault.cachedRead(file), path: file.path },
      )
      const candidate = message.imageResult
      message.parts = [{
        type: 'text',
        text: `已重新生成候选配图，准备放在「${candidate.anchor}」之后。确认后再插入文章。`,
      }]
      await this.persistNow()
    } catch (error) {
      new Notice(`重新生成失败：${error instanceof Error ? error.message : String(error)}`, 9000)
    } finally {
      notice.hide()
      this.renderMessages()
    }
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
      .setName('AI霖子云端服务')
      .setDesc('已安全连接官方服务 chat.alinalinzi.com；学员版无需修改服务器地址')

    new Setting(containerEl)
      .setName('连接 AI霖子账号')
      .setDesc('先在 AI霖子 网页「我的 → 连接中心」生成连接密钥，再在这里新建安全条目并粘贴。插件只保存安全条目名；换电脑后重新绑定即可。')
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.tokenSecretId)
          .onChange(async (v) => {
            this.plugin.settings.tokenSecretId = v.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('获取连接密钥')
      .setDesc('打开 AI霖子账号的连接中心')
      .addButton((button) =>
        button.setButtonText('打开连接中心').onClick(() => {
          window.open(`${OFFICIAL_SERVER_URL}/connections`)
        }),
      )

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
      .setDesc('对话面板「带上当前笔记」开关的默认状态；只读取用户当前主动打开的这一篇笔记')
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
      .setDesc('在公众号后台获取后，新建一个安全条目并粘贴。data.json 只保存条目名；密钥保留在当前设备的 Obsidian SecretStorage。换设备时需要重新填写。')
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.wechatAppSecretId)
          .onChange(async (v) => {
            this.plugin.settings.wechatAppSecretId = v.trim()
            await this.plugin.saveSettings()
          }),
      )

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
      .setDesc('验证地址、密钥、账号和插件 API 是否可用')
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

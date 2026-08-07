/**
 * AI霖子 Obsidian 插件 · 学员内容工作流
 *
 * 已实现:侧边栏对话(流式+当前笔记+Vault 本地搜索+多笔记授权+长文任务+AI 生图)、
 * 一键喂库、技能落盘、文章配图与单图修改、内容发布看板、公众号排版与草稿箱直发。
 * (2026-07-30 修正本注释:原 M1/M2/M3 里程碑均已完成,旧注释已误导。)
 *
 * 服务端对应:webapp /api/plugin/v1/*(版本协商与最低版本门禁见 api())
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
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
} from 'obsidian'
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
  runXhsCards,
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
import { extractCreateNoteBlocks, type CreateNoteBlock } from './create-note'
import { extractCreateFolderBlocks } from './create-folder'
import {
  extractCreateLocalSkillBlocks,
  type CreateLocalSkillBlock,
} from './create-local-skill'
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
import { CockpitView, VIEW_TYPE_COCKPIT } from './cockpit-view'
import {
  AuthorizedContentModal,
  type AuthorizedContentLimits,
} from './content-selector'
import {
  LONG_DOCUMENT_DEFAULT_CHUNK_CHARS,
  LONG_DOCUMENT_DEFAULT_MAX_CHARS,
  LONG_DOCUMENT_DEFAULT_MAX_CHUNKS,
  readLocalDocumentText,
  splitLongDocument,
  type LongDocumentChunk,
} from './long-document'
import { LocalVaultSearch } from './vault-search'
import { type VaultSearchResult } from './vault-search-core'
import {
  formatLocalSkillList,
  isLocalSkillListIntent,
  normalizeLocalSkillRoot,
  type LocalSkillOutput,
} from './local-skill-core'
import { LocalSkillRegistry } from './local-skills'

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
  { id: 'xhs-cards', name: '小红书图文卡片:当前笔记 → 正文 + 3:4 PNG', fn: runXhsCards },
  { id: 'sales-review', name: '谈单复盘:诊断当前逐字稿', fn: runSalesReview },
  { id: 'illustration', name: '文章配图:可使用你的专属人偶(先看方案再生图)', fn: runArticleIllustration },
  { id: 'wechat-copy', name: '公众号排版:一键复制(去后台粘贴)', fn: async (p) => copyWechatFormatted(p) },
  { id: 'wechat-draft', name: '发到公众号草稿箱(自动传图,需配置AppID)', fn: async (p) => sendToWechatDraft(p) },
  { id: 'feed-knowledge', name: '喂库:把当前笔记存入 AI霖子知识库', fn: feedKnowledge },
]

// ── 设置 ──────────────────────────────────────────────

interface AiLinziSettings {
  serverUrl: string
  /** SecretStorage 的内部条目名，仅用于兼容旧设置；不得在学员界面中暴露 */
  tokenSecretId: string
  /** 一次性迁移标记：不再让旧版两个 true 默认值污染新主对话 */
  cleanChatDefaultsV1: boolean
  /** 「带上当前笔记」开关的默认值 */
  attachNoteDefault: boolean
  /** 主对话默认在本机 Vault 中检索相关笔记；只发送命中的少量片段 */
  vaultSearchDefault: boolean
  /** 技能产出落盘的文件夹(相对 vault 根) */
  outputFolder: string
  /** 公众号一键配图使用的专属人偶参考图，只保存用户 Vault 内的路径 */
  illustrationCharacterReferencePath: string
  /** 选题雷达默认受众(跑一次后自动记住;历史key沿用defaultNiche兼容旧设置) */
  defaultNiche: string
  /** 公众号发布(选配):AppID 可留在普通设置，AppSecret 只存 SecretStorage */
  wechatAppId: string
  wechatAppSecretId: string
  /** 文末品牌小卡「排版与配图 · AI霖子」(默认开,可关) */
  brandFooter: boolean
  /** 驾驶舱目录映射(相对 vault 根;留空=该卡不统计)。默认 inbox/raw/wiki/output 四件套 */
  cockpitInboxFolder: string
  cockpitSourcesFolder: string
  cockpitKnowledgeFolder: string
  cockpitOutputFolder: string
  /** 用户指定的本地 AI 工作流 / SOP 根目录(相对 vault 根) */
  localSkillsFolder: string
  /** 「AI霖子·今天的判断」按日缓存(免费但没必要一天生成多次) */
  cockpitJudgmentDate: string
  cockpitJudgmentText: string
  /** 合伙人学习进度里手动标记完成的步骤 key(clients10 由 CRM 自动判定不入此列表) */
  cockpitPartnerSteps: string[]
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  serverUrl: 'https://chat.alinalinzi.com',
  tokenSecretId: '',
  cleanChatDefaultsV1: false,
  attachNoteDefault: false,
  vaultSearchDefault: false,
  outputFolder: 'AI霖子输出',
  illustrationCharacterReferencePath: '',
  defaultNiche: '',
  wechatAppId: '',
  wechatAppSecretId: '',
  brandFooter: true,
  cockpitInboxFolder: 'inbox',
  cockpitSourcesFolder: 'raw',
  cockpitKnowledgeFolder: 'wiki',
  cockpitOutputFolder: 'output',
  localSkillsFolder: 'system/skills',
  cockpitJudgmentDate: '',
  cockpitJudgmentText: '',
  cockpitPartnerSteps: [],
}

interface LegacyAiLinziSettings extends Partial<AiLinziSettings> {
  /** v0.5.1 及以前曾把这两个敏感值明文写进 data.json，仅用于一次性迁移 */
  token?: string
  wechatAppSecret?: string
  /** v0.6.21-v0.6.24 的手动排除列表；v0.6.25 起清理并停止生效 */
  vaultSearchExcludedFolders?: string
  /** v0.6.27 及以前的插件内更新检查时间；官方市场版不再使用 */
  lastUpdateCheckAt?: number
}

const DEFAULT_TOKEN_SECRET_ID = 'ai-linzi-api-token'
const DEFAULT_WECHAT_SECRET_ID = 'ai-linzi-wechat-app-secret'
const OFFICIAL_SERVER_URL = 'https://chat.alinalinzi.com'

const VIEW_TYPE_CHAT = 'ai-linzi-chat'
const CHAT_SEND_SHORTCUT_HINT = 'Enter 换行 · Mac / Windows：Control + Enter 发送'
const CHAT_INPUT_PLACEHOLDER = '问 AI霖子任何事…'
const INTERVIEW_INPUT_PLACEHOLDER = '先告诉 AI 你想写什么方向（一句话），它会开始采访你…'

function isExplicitCurrentNoteImageRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '')
  const explicitArticleIllustration =
    /(?:公众号|正文|文章)(?:配图|插图|封面)/.test(normalized)
  const explicitCurrentDocument =
    /(?:当前|这篇|本篇|正在打开的)(?:笔记|文章|文档)/.test(normalized) ||
    /(?:根据|结合|读取|参考)(?:当前|这篇|本篇|正在打开的)(?:笔记|文章|文档)/.test(normalized)
  const imageAction =
    /(?:生图|生成|做|画|设计|制作|新增|增加|补充|添加|插入|配)(?:一|1)?(?:张)?(?:配图|插图|图片|图|封面)/.test(normalized)
  return explicitArticleIllustration || (explicitCurrentDocument && imageAction)
}
const CAPABILITIES_CACHE_TTL_MS = 5 * 60 * 1000
// 四处未连接报错共用同一句(2026-07-30 统一;旧版有「服务器地址和 Token」等三种矛盾说法)
const NOT_CONNECTED_MSG =
  '还没连接 AI霖子——请到插件设置页粘贴「AI霖子连接密钥」,并点一次「测试连接」。'

type MembershipTier = 'starter' | 'pro' | 'business'

interface PluginCapabilities {
  studentNo?: string
  apiVersion?: string
  tier?: MembershipTier
  features?: {
    chat?: {
      authorizedContent?: {
        available?: boolean
        maxFiles?: number
        maxTotalChars?: number
        maxPerFileChars?: number
      }
      longDocument?: {
        available?: boolean
        maxChars?: number
        chunkChars?: number
        maxChunks?: number
        supportedExtensions?: string[]
      }
      vaultSearch?: {
        available?: boolean
        localOnly?: boolean
        maxSources?: number
        maxExcerptChars?: number
        maxTotalChars?: number
        supportedExtensions?: string[]
        ocr?: boolean
        legacyDoc?: boolean
      }
      localSkills?: {
        available?: boolean
        localOnly?: boolean
        maxContentChars?: number
        requiresExplicitInvocation?: boolean
        persistsInHistory?: boolean
      }
      imageAttachments?: {
        available?: boolean
        maxImages?: number
        supportedMediaTypes?: string[]
        sentWithNextMessageOnly?: boolean
        persistsInHistory?: boolean
      }
    }
    articleIllustration?: {
      customCharacterReferenceAvailable?: boolean
    }
    aiImage?: {
      available?: boolean
    }
  }
}

// 与服务端 chat-core UIMessage 对齐的最小结构
interface WireMessage {
  id: string
  role: 'user' | 'assistant'
  parts: { type: 'text'; text: string }[]
  /** 只保存在插件本机历史；发送给主对话 API 时会被剥离。 */
  imageResult?: ChatIllustrationCandidate
  /** 主对话生图模式的本地图片卡片；图片已自动落到用户 Vault，不上传本地路径。 */
  aiImageResult?: ChatAiImageResult
  /** 整篇配图完成后的本地操作卡片；只保存目标笔记路径，不同步到云端。 */
  articleIllustrationEditOffer?: ArticleIllustrationEditOffer
  /** 本地 Vault 检索来源；只保存在插件本机历史，messagesForApi 会剥离。 */
  vaultSources?: VaultMessageSource[]
  /** 只保留用户本轮上传的图片名称；图片数据不写本机或云端历史。 */
  imageAttachmentNames?: string[]
}

interface VaultMessageSource {
  sourceId: string
  filename: string
  path: string
}

interface LongDocumentTaskState {
  taskId: string
  path: string
  filename: string
  mtime: number
  size: number
  instruction: string
  totalChars: number
  chunks: LongDocumentChunk[]
  summaries: string[]
  nextIndex: number
  stage: 'processing' | 'synthesizing' | 'paused'
  error?: string
}

function toVaultMessageSource(result: VaultSearchResult): VaultMessageSource {
  return {
    sourceId: result.sourceId,
    filename: result.filename,
    path: result.path,
  }
}

interface ArticleIllustrationEditOffer {
  kind: 'article-illustration-edit-offer'
  notePath: string
  summary: string
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

/** 本地保存的会话（由 Obsidian Plugin.loadData/saveData 管理） */
interface SavedConvo {
  id: string
  mode: 'chat' | 'interview'
  title: string
  updatedAt: number
  messages: WireMessage[]
}

interface AiLinziPluginData extends LegacyAiLinziSettings {
  conversations?: SavedConvo[]
  illustrationJobs?: unknown[]
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

class ConfirmActionModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly resolve: (confirmed: boolean) => void,
    private readonly destructive = false,
  ) {
    super(app)
  }

  onOpen(): void {
    this.setTitle(this.title)
    for (const paragraph of this.message.split(/\n{2,}/)) {
      this.contentEl.createEl('p', { text: paragraph.replace(/\n/g, ' ') })
    }
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
    const cancelButton = actions.createEl('button', { text: '取消' })
    cancelButton.onclick = () => this.finish(false)
    const confirmButton = actions.createEl('button', {
      text: this.confirmLabel,
      cls: this.destructive ? 'mod-warning' : 'mod-cta',
    })
    confirmButton.onclick = () => this.finish(true)
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true
      this.resolve(false)
    }
    this.contentEl.empty()
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(confirmed)
    this.close()
  }
}

function confirmAction(
  app: App,
  options: {
    title: string
    message: string
    confirmLabel: string
    destructive?: boolean
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmActionModal(
      app,
      options.title,
      options.message,
      options.confirmLabel,
      resolve,
      options.destructive,
    ).open()
  })
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
    this.setTitle('插件对话历史')
    this.renderHistory()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private renderHistory(): void {
    const { contentEl } = this
    contentEl.empty()
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
        const confirmed = await confirmAction(this.app, {
          title: '删除插件对话',
          message: `确定删除这条插件对话“${entry.title.slice(0, 30) || '未命名对话'}”吗？\n\n只会删除这一条 AI霖子 Obsidian 插件对话；其他插件对话、网页版和微信端对话都不受影响。删除后不可恢复。`,
          confirmLabel: '删除',
          destructive: true,
        })
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
      const confirmed = await confirmAction(this.app, {
        title: '清空全部插件对话',
        message: '确定清空 AI霖子 Obsidian 插件产生的云端及本机历史吗？此操作不可恢复；网页版和微信端对话不会被删除，已「存为笔记」的成稿不受影响。',
        confirmLabel: '清空全部',
        destructive: true,
      })
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
  return window.activeWindow.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  readonly vaultSearch = new LocalVaultSearch(this.app)
  private capabilitiesCache: { data: PluginCapabilities; loadedAt: number } | null = null
  private savedConversations: SavedConvo[] = []
  private savedIllustrationJobs: unknown[] = []
  /**
   * 最近一次激活的笔记。侧边面板(对话)获得焦点时 getActiveFile() 会返回 null,
   * 面板上的「调用技能/存入知识库」按钮靠这个记录知道用户"当前开着哪篇笔记"。
   */
  lastActiveFile: TFile | null = null
  async onload() {
    await this.loadSettings()

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const f = this.app.workspace.getActiveFile()
        if (f) this.lastActiveFile = f
      }),
    )

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this))
    this.registerView(VIEW_TYPE_CONTENT_DASHBOARD, (leaf) => new ContentDashboardView(leaf, this))
    this.registerView(VIEW_TYPE_COCKPIT, (leaf) => new CockpitView(leaf, this))

    this.addRibbonIcon('sparkles', 'AI霖子对话', () => this.activateChatView())
    this.addRibbonIcon('layout-dashboard', 'AI霖子内容发布看板', () => this.activateContentDashboard())
    this.addRibbonIcon('gauge', '一人公司驾驶舱', () => this.activateCockpit())

    this.addCommand({
      id: 'open-chat',
      name: '打开对话面板',
      callback: () => this.activateChatView(),
    })

    this.addCommand({
      id: 'test-connection',
      name: '测试连接',
      callback: () => this.testConnection(),
    })

    this.addCommand({
      id: 'open-content-dashboard',
      name: '打开内容发布看板',
      callback: () => this.activateContentDashboard(),
    })

    this.addCommand({
      id: 'open-cockpit',
      name: '打开一人公司驾驶舱',
      callback: () => this.activateCockpit(),
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

  onunload(): void {
    // Obsidian 官方规范:卸载时不 detach leaves(用户布局归用户)
  }

  async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as AiLinziPluginData
    const {
      token: legacyToken,
      wechatAppSecret: legacyWechatSecret,
      vaultSearchExcludedFolders: legacyVaultSearchExcludedFolders,
      lastUpdateCheckAt: legacyLastUpdateCheckAt,
      conversations,
      illustrationJobs,
      ...safeSettings
    } = raw
    this.savedConversations = Array.isArray(conversations) ? conversations : []
    this.savedIllustrationJobs = Array.isArray(illustrationJobs) ? illustrationJobs : []
    this.settings = Object.assign({}, DEFAULT_SETTINGS, safeSettings)
    let migrated =
      legacyVaultSearchExcludedFolders !== undefined || legacyLastUpdateCheckAt !== undefined
    // 0.6.48 以前两个主对话上下文开关默认都是 true，用户很容易在不知情时
    // 把当前笔记和 Vault 检索带进普通对话/自由生图。只迁移仍完整保留旧默认
    // 组合的安装；若用户已经单独改过任一开关，则尊重其自定义。
    if (!this.settings.cleanChatDefaultsV1) {
      const stillUsingOldChatDefaults =
        (safeSettings.attachNoteDefault === undefined || safeSettings.attachNoteDefault === true) &&
        (safeSettings.vaultSearchDefault === undefined || safeSettings.vaultSearchDefault === true)
      if (stillUsingOldChatDefaults) {
        this.settings.attachNoteDefault = false
        this.settings.vaultSearchDefault = false
      }
      this.settings.cleanChatDefaultsV1 = true
      migrated = true
    }
    // 学员正式版只连接 AI霖子官方后端，避免误按第三方教程把连接密钥和笔记
    // 发送到陌生服务器。localhost 仅保留给本机开发联调。
    if (
      this.settings.serverUrl !== OFFICIAL_SERVER_URL &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/i.test(this.settings.serverUrl)
    ) {
      this.settings.serverUrl = OFFICIAL_SERVER_URL
      migrated = true
    }

    // 学员只需要粘贴密钥值。SecretStorage 的条目名是实现细节，统一迁移到
    // 两个固定且不在界面暴露的内部 ID。固定条目已有值时优先保留，避免旧
    // 自定义条目中的过期值覆盖用户刚更新的密钥。
    const previousTokenId = this.settings.tokenSecretId.trim()
    const fixedToken = this.app.secretStorage.getSecret(DEFAULT_TOKEN_SECRET_ID)?.trim() ?? ''
    const previousToken =
      previousTokenId && previousTokenId !== DEFAULT_TOKEN_SECRET_ID
        ? this.app.secretStorage.getSecret(previousTokenId)?.trim() ?? ''
        : ''
    const tokenToKeep = fixedToken || legacyToken?.trim() || previousToken
    if (tokenToKeep && tokenToKeep !== fixedToken) {
      this.app.secretStorage.setSecret(DEFAULT_TOKEN_SECRET_ID, tokenToKeep)
    }
    if (legacyToken !== undefined) migrated = true
    if (this.settings.tokenSecretId !== DEFAULT_TOKEN_SECRET_ID) {
      this.settings.tokenSecretId = DEFAULT_TOKEN_SECRET_ID
      migrated = true
    }

    const previousWechatId = this.settings.wechatAppSecretId.trim()
    const fixedWechat = this.app.secretStorage.getSecret(DEFAULT_WECHAT_SECRET_ID)?.trim() ?? ''
    const previousWechat =
      previousWechatId && previousWechatId !== DEFAULT_WECHAT_SECRET_ID
        ? this.app.secretStorage.getSecret(previousWechatId)?.trim() ?? ''
        : ''
    const wechatToKeep = fixedWechat || legacyWechatSecret?.trim() || previousWechat
    if (wechatToKeep && wechatToKeep !== fixedWechat) {
      this.app.secretStorage.setSecret(DEFAULT_WECHAT_SECRET_ID, wechatToKeep)
    }
    if (legacyWechatSecret !== undefined) migrated = true
    if (this.settings.wechatAppSecretId !== DEFAULT_WECHAT_SECRET_ID) {
      this.settings.wechatAppSecretId = DEFAULT_WECHAT_SECRET_ID
      migrated = true
    }
    // 0.6.35→0.6.36:驾驶舱目录默认名从中文改为 inbox/raw/wiki/output(打卡营模板口径);
    // 只迁移仍是旧默认值的设置,用户自定义过的不动
    const cockpitFolderMigrations: [key: 'cockpitInboxFolder' | 'cockpitSourcesFolder' | 'cockpitKnowledgeFolder', old: string, next: string][] = [
      ['cockpitInboxFolder', '收件箱', 'inbox'],
      ['cockpitSourcesFolder', '原始素材', 'raw'],
      ['cockpitKnowledgeFolder', '知识库', 'wiki'],
    ]
    for (const [key, oldValue, nextValue] of cockpitFolderMigrations) {
      if (this.settings[key] === oldValue) {
        this.settings[key] = nextValue
        migrated = true
      }
    }
    if (migrated) await this.saveSettings()
  }

  getApiToken(): string {
    return this.app.secretStorage.getSecret(DEFAULT_TOKEN_SECRET_ID)?.trim() ?? ''
  }

  async setApiToken(value: string): Promise<void> {
    this.app.secretStorage.setSecret(DEFAULT_TOKEN_SECRET_ID, value.trim())
    this.settings.tokenSecretId = DEFAULT_TOKEN_SECRET_ID
    this.capabilitiesCache = null // 换密钥=换账号,旧权益缓存立即作废
    await this.saveSettings()
  }

  /** 打开本插件的设置页(空状态引导按钮用;Obsidian 未公开类型,窄接口断言) */
  openPluginSettings(): void {
    const app = this.app as unknown as {
      setting?: { open: () => void; openTabById: (id: string) => void }
    }
    app.setting?.open()
    app.setting?.openTabById(this.manifest.id)
  }

  getWechatAppSecret(): string {
    return this.app.secretStorage.getSecret(DEFAULT_WECHAT_SECRET_ID)?.trim() ?? ''
  }

  async setWechatAppSecret(value: string): Promise<void> {
    this.app.secretStorage.setSecret(DEFAULT_WECHAT_SECRET_ID, value.trim())
    this.settings.wechatAppSecretId = DEFAULT_WECHAT_SECRET_ID
    await this.saveSettings()
  }

  // ── 会话与短期配图任务持久化（统一使用 Obsidian 插件数据 API） ──

  async loadConvos(): Promise<SavedConvo[]> {
    return this.savedConversations.map((convo) => ({
      ...convo,
      id: normalizePluginSessionId(convo.id),
    }))
  }

  async saveConvo(convo: SavedConvo): Promise<void> {
    const list = (await this.loadConvos()).filter((c) => c.id !== convo.id)
    list.unshift(convo)
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    this.savedConversations = list.slice(0, MAX_SAVED_CONVOS)
    await this.saveSettings()
  }

  async deleteAllConvos(): Promise<void> {
    this.savedConversations = []
    await this.saveSettings()
  }

  async deleteConvo(sessionId: string): Promise<void> {
    const targetId = normalizePluginSessionId(sessionId)
    const list = (await this.loadConvos()).filter((convo) => convo.id !== targetId)
    this.savedConversations = list.slice(0, MAX_SAVED_CONVOS)
    await this.saveSettings()
  }

  getIllustrationJobsData(): unknown[] {
    return [...this.savedIllustrationJobs]
  }

  async setIllustrationJobsData(jobs: unknown[]): Promise<void> {
    this.savedIllustrationJobs = jobs.slice(-20)
    await this.saveSettings()
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
    await this.saveData({
      ...this.settings,
      conversations: this.savedConversations,
      illustrationJobs: this.savedIllustrationJobs,
    } satisfies AiLinziPluginData)
  }

  async activateChatView() {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT)
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true })
    await workspace.revealLeaf(leaf)
  }

  async activateContentDashboard() {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CONTENT_DASHBOARD)
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getLeaf('tab')
    await leaf.setViewState({ type: VIEW_TYPE_CONTENT_DASHBOARD, active: true })
    await workspace.revealLeaf(leaf)
  }

  async activateCockpit() {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_COCKPIT)
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getLeaf('tab')
    await leaf.setViewState({ type: VIEW_TYPE_COCKPIT, active: true })
    await workspace.revealLeaf(leaf)
  }

  /**
   * 整篇配图完成后，把“修改某一张配图”留在右侧对话区。
   * 用户先关闭完成弹窗查看正文效果，再随时回来选择具体图片，不再被弹窗挡住文章。
   */
  async offerArticleIllustrationEdit(notePath: string, summary: string): Promise<void> {
    await this.activateChatView()
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0]
    const view = leaf?.view
    if (view instanceof ChatView) {
      await view.addArticleIllustrationEditOffer(notePath, summary)
    }
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
      throw new Error(NOT_CONNECTED_MSG)
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

  async getCapabilities(force = false): Promise<PluginCapabilities> {
    const now = Date.now()
    if (
      !force &&
      this.capabilitiesCache &&
      now - this.capabilitiesCache.loadedAt < CAPABILITIES_CACHE_TTL_MS
    ) {
      return this.capabilitiesCache.data
    }
    const data = (await this.api('/api/plugin/v1/capabilities')) as PluginCapabilities
    this.capabilitiesCache = { data, loadedAt: now }
    return data
  }

  async hasProAccess(force = false): Promise<boolean> {
    try {
      const data = await this.getCapabilities(force)
      return data.tier === 'pro' || data.tier === 'business'
    } catch {
      return false
    }
  }

  async requireProAccess(featureName: string): Promise<boolean> {
    try {
      let data = await this.getCapabilities()
      if (data.tier !== 'pro' && data.tier !== 'business') {
        // 缓存说无权益时强刷一次再判:网页端刚升级的会员不该被最长 5 分钟的旧缓存拦在门外
        data = await this.getCapabilities(true)
      }
      if (data.tier === 'pro' || data.tier === 'business') return true
      new Notice(`“${featureName}”是 Pro 及以上会员功能，请升级会员后使用。`, 7000)
      return false
    } catch {
      new Notice('暂时无法确认会员权益，请先在设置中测试连接后重试。', 7000)
      return false
    }
  }

  /**
   * 调用返回纯文本流的技能路由(toTextStreamResponse)。
   * requestUrl 会把流缓冲成完整文本;错误时这些路由返回 JSON,这里解析出友好文案。
   */
  async apiText(path: string, body: unknown): Promise<string> {
    const { serverUrl } = this.settings
    const token = this.getApiToken()
    if (!serverUrl || !token) {
      throw new Error(NOT_CONNECTED_MSG)
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
      const data = await this.getCapabilities(true)
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
  private vaultSearchEnabled: boolean
  private localSkills: LocalSkillRegistry
  private imageMode = false
  private imageRatio: AiImageRatio = '16:9'
  private imageReferences: LocalImageReference[] = []
  /** 普通主对话下一轮要识别的图片；压缩数据只驻留当前进程，发送后立即释放。 */
  private chatImageAttachments: LocalImageReference[] = []
  private activeImageMessageId = ''
  private usePreviousImage = true
  /** 只保存用户明确勾选的本地路径；正文不会写入会话历史或插件设置。 */
  private authorizedContentPaths: string[] = []
  private authorizedContentChars = 0
  /** 长文原文与分段只驻留在当前 Obsidian 进程内，不写 data.json 或会话历史。 */
  private longDocumentPath = ''
  private longDocumentChars = 0
  private longDocumentTask: LongDocumentTaskState | null = null
  private sending = false
  /** chat=日常对话;interview=访谈写作(多轮采访→成稿) */
  private mode: 'chat' | 'interview' = 'chat'
  private interviewBar!: HTMLElement

  private listEl!: HTMLElement
  private inputEl!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private attachToggleEl!: HTMLInputElement
  private vaultSearchToggleEl!: HTMLInputElement
  private imageToggleEl!: HTMLInputElement
  private imageRatioEl!: HTMLSelectElement
  private imageUsePreviousEl!: HTMLInputElement
  private imageUsePreviousLabelEl!: HTMLLabelElement
  private imageOptionsEl!: HTMLElement
  private imageReferenceStatusEl!: HTMLElement
  private authorizedContentBtn!: HTMLButtonElement
  private authorizedContentStatusEl!: HTMLElement

  constructor(leaf: WorkspaceLeaf, plugin: AiLinziPlugin) {
    super(leaf)
    this.plugin = plugin
    this.attachNote = plugin.settings.attachNoteDefault
    this.vaultSearchEnabled = plugin.settings.vaultSearchDefault
    this.localSkills = new LocalSkillRegistry(
      plugin.app,
      () => plugin.settings.localSkillsFolder,
    )
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
      this.clearAuthorizedContent()
      this.resetContextTogglesToDefaults()
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
    const skillBtn = actionsRow.createEl('button', { text: '调用技能', cls: 'ai-linzi-action-btn' })
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
    const kbBtn = actionsRow.createEl('button', { text: '存入知识库', cls: 'ai-linzi-action-btn' })
    kbBtn.onclick = () => void feedKnowledge(this.plugin)
    const dashboardBtn = actionsRow.createEl('button', { text: '内容看板', cls: 'ai-linzi-action-btn' })
    dashboardBtn.onclick = () => void this.plugin.activateContentDashboard()
    const localSkillsBtn = actionsRow.createEl('button', {
      text: '本地 Skills',
      cls: 'ai-linzi-action-btn',
      attr: { title: `查看 ${this.localSkills.root()}/ 中的本地 Skill` },
    })
    localSkillsBtn.onclick = (event: MouseEvent) => void this.showLocalSkillsMenu(event)

    const toggleRow = footer.createDiv({ cls: 'ai-linzi-toggle-row' })
    const label = toggleRow.createEl('label', { cls: 'ai-linzi-toggle' })
    this.attachToggleEl = label.createEl('input', { type: 'checkbox' })
    this.attachToggleEl.checked = this.attachNote
    this.attachToggleEl.onchange = () => {
      this.attachNote = this.attachToggleEl.checked
      this.refreshImageModeUi()
    }
    label.createSpan({ text: ' 主对话带上当前笔记' })

    const vaultSearchLabel = toggleRow.createEl('label', {
      cls: 'ai-linzi-toggle ai-linzi-vault-search-toggle',
      attr: {
        title: '在本机搜索 Markdown、TXT、PDF 和 DOCX，只把相关的少量片段交给 AI',
      },
    })
    this.vaultSearchToggleEl = vaultSearchLabel.createEl('input', { type: 'checkbox' })
    this.vaultSearchToggleEl.checked = this.vaultSearchEnabled
    this.vaultSearchToggleEl.onchange = () => {
      this.vaultSearchEnabled = this.vaultSearchToggleEl.checked
    }
    vaultSearchLabel.createSpan({ text: ' 智能搜索 Vault' })

    const imageLabel = toggleRow.createEl('label', { cls: 'ai-linzi-toggle ai-linzi-image-toggle' })
    this.imageToggleEl = imageLabel.createEl('input', { type: 'checkbox' })
    this.imageToggleEl.checked = false
    this.imageToggleEl.onchange = () => void this.setImageMode(this.imageToggleEl.checked)
    imageLabel.createSpan({ text: ' AI 生图模式' })

    this.authorizedContentStatusEl = footer.createDiv({
      cls: 'ai-linzi-authorized-content-status',
    })
    // 初始必须显式隐藏:📎 按钮此时未创建,refreshAuthorizedContentUi 会因守卫早退,
    // 不隐藏就会在输入框上方留一个空的蓝框(0.6.32 Alina 实测反馈)
    this.authorizedContentStatusEl.toggle(false)
    this.refreshAuthorizedContentUi()

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
    this.imageUsePreviousLabelEl = this.imageOptionsEl.createEl('label', { cls: 'ai-linzi-image-previous-toggle' })
    this.imageUsePreviousEl = this.imageUsePreviousLabelEl.createEl('input', { type: 'checkbox' })
    this.imageUsePreviousEl.checked = this.usePreviousImage
    this.imageUsePreviousEl.onchange = () => {
      this.usePreviousImage = this.imageUsePreviousEl.checked
      this.refreshImageModeUi()
    }
    this.imageUsePreviousLabelEl.createSpan({ text: ' 参考上一张图' })
    this.imageReferenceStatusEl = this.imageOptionsEl.createSpan({ cls: 'ai-linzi-image-reference-status' })

    this.inputEl = footer.createEl('textarea', {
      cls: 'ai-linzi-input',
      attr: { placeholder: CHAT_INPUT_PLACEHOLDER },
    })
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
        ev.preventDefault()
        void this.send()
      }
    })

    const sendRow = footer.createDiv({ cls: 'ai-linzi-send-row' })
    const sendMeta = sendRow.createDiv({ cls: 'ai-linzi-send-meta' })
    this.authorizedContentBtn = sendMeta.createEl('button', {
      text: '📎',
      cls: 'ai-linzi-attachment-btn',
      attr: {
        title: '添加文件或图片（Pro）',
        'aria-label': '添加文件或图片',
      },
    })
    this.authorizedContentBtn.onclick = (event) => void this.openAttachmentMenu(event)
    sendMeta.createSpan({ text: CHAT_SEND_SHORTCUT_HINT, cls: 'ai-linzi-send-hint' })
    this.sendBtn = sendRow.createEl('button', {
      text: '发送',
      cls: 'ai-linzi-send',
      attr: { title: CHAT_SEND_SHORTCUT_HINT, 'aria-label': `发送消息，${CHAT_SEND_SHORTCUT_HINT}` },
    })
    this.sendBtn.onclick = () => void this.send()

    this.refreshImageModeUi()

    this.renderMessages()
    // 恢复最近一次会话(升级/重启后不丢)
    void this.restoreLatest()
  }

  private async showLocalSkillsMenu(event: MouseEvent): Promise<void> {
    const skills = await this.localSkills.list()
    if (skills.length === 0) {
      new Notice(`没有找到本地 Skill。请先把技能文件放进 ${this.localSkills.root()}/。`, 5000)
      return
    }
    const menu = new Menu()
    for (const skill of skills) {
      menu.addItem((item) =>
        item
          .setTitle(
            skill.description
              ? `${skill.displayName} · ${skill.description}`
              : skill.displayName,
          )
          .setIcon('sparkles')
          .onClick(() => {
            this.inputEl.value = `用${skill.displayName}技能处理当前笔记`
            this.inputEl.focus()
          }),
      )
    }
    menu.showAtMouseEvent(event)
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

  async addArticleIllustrationEditOffer(notePath: string, summary: string): Promise<void> {
    const previous = this.messages.at(-1)?.articleIllustrationEditOffer
    if (previous?.notePath === notePath && previous.summary === summary) return
    this.messages.push({
      id: uid(),
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text: '配图已经写入文章。请先在正文里查看整体效果；需要调整时，可以从这里选择并修改其中一张。',
        },
      ],
      articleIllustrationEditOffer: {
        kind: 'article-illustration-edit-offer',
        notePath,
        summary,
      },
    })
    await this.persistNow()
    this.renderMessages()
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
      const localHasVaultSources = Boolean(
        latestLocal?.messages.some((message) => (message.vaultSources?.length ?? 0) > 0),
      )
      const preserveRicherLocalCopy = sameSession && (localHasImageCards || localHasVaultSources)
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
    this.clearAuthorizedContent()
    this.resetContextTogglesToDefaults()
    this.messages = c.messages
    this.sessionId = normalizePluginSessionId(c.id)
    if (c.mode === 'interview' && this.mode !== 'interview') {
      this.mode = 'interview'
      this.interviewBar.show()
      this.inputEl.placeholder = INTERVIEW_INPUT_PLACEHOLDER
    } else if (c.mode === 'chat' && this.mode === 'interview') {
      this.mode = 'chat'
      this.interviewBar.hide()
      this.inputEl.placeholder = CHAT_INPUT_PLACEHOLDER
    }
    this.refreshImageModeUi()
    this.renderMessages()
  }

  private async setImageMode(active: boolean): Promise<boolean> {
    if (this.mode === 'interview' && active) {
      new Notice('请先结束访谈写作，再进入 AI 生图模式')
      this.refreshImageModeUi()
      return false
    }
    if (active && !(await this.plugin.requireProAccess('AI 生图模式'))) {
      this.imageMode = false
      this.refreshImageModeUi()
      return false
    }
    this.imageMode = active
    this.refreshImageModeUi()
    if (active) this.inputEl.focus()
    return true
  }

  private refreshImageModeUi(): void {
    if (!this.inputEl) return
    this.imageToggleEl.checked = this.imageMode
    this.imageOptionsEl.toggle(this.imageMode)
    this.imageRatioEl.value = this.imageRatio
    const hasPreviousImage = Boolean(this.latestImageModeResult())
    this.imageUsePreviousEl.disabled = !hasPreviousImage
    this.imageUsePreviousLabelEl.toggleClass('is-disabled', !hasPreviousImage)
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
        ? '自由描述图片；只有明确说“给当前笔记配图”才会读取笔记…'
        : '描述要生成的图片；下一轮可直接说怎么修改…'
      : CHAT_INPUT_PLACEHOLDER
    this.sendBtn.setText(this.imageMode ? '生成图片' : '发送')
  }

  private resetContextTogglesToDefaults(): void {
    this.attachNote = this.plugin.settings.attachNoteDefault
    this.vaultSearchEnabled = this.plugin.settings.vaultSearchDefault
    if (this.attachToggleEl) this.attachToggleEl.checked = this.attachNote
    if (this.vaultSearchToggleEl) this.vaultSearchToggleEl.checked = this.vaultSearchEnabled
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

  private authorizedContentLimits(data?: PluginCapabilities): AuthorizedContentLimits {
    const capability = data?.features?.chat?.authorizedContent
    const longDocument = data?.features?.chat?.longDocument
    return {
      maxFiles: capability?.maxFiles ?? 20,
      maxTotalChars: capability?.maxTotalChars ?? 120_000,
      maxPerFileChars: capability?.maxPerFileChars ?? 50_000,
      longDocumentAvailable: longDocument?.available ?? false,
      longDocumentMaxChars: longDocument?.maxChars ?? LONG_DOCUMENT_DEFAULT_MAX_CHARS,
    }
  }

  private longDocumentLimits(data?: PluginCapabilities): {
    maxChars: number
    chunkChars: number
    maxChunks: number
  } {
    const capability = data?.features?.chat?.longDocument
    return {
      maxChars: capability?.maxChars ?? LONG_DOCUMENT_DEFAULT_MAX_CHARS,
      chunkChars: capability?.chunkChars ?? LONG_DOCUMENT_DEFAULT_CHUNK_CHARS,
      maxChunks: capability?.maxChunks ?? LONG_DOCUMENT_DEFAULT_MAX_CHUNKS,
    }
  }

  private async openAuthorizedContentSelector(): Promise<void> {
    if (this.mode === 'interview') {
      new Notice('请先结束访谈写作，再选择多篇笔记或文件夹')
      return
    }
    if (!(await this.plugin.requireProAccess('多笔记与文件夹授权'))) return
    let capabilities: PluginCapabilities | undefined
    try {
      capabilities = await this.plugin.getCapabilities()
    } catch {
      // 权限刚刚已经通过；旧服务端暂时没有细分能力字段时使用客户端保守默认值。
    }
    const modal = new AuthorizedContentModal(
      this.app,
      this.longDocumentPath ? [this.longDocumentPath] : this.authorizedContentPaths,
      this.authorizedContentLimits(capabilities),
    )
    modal.open()
    const selection = await modal.result
    if (!selection) return
    this.longDocumentTask = null
    if (selection.mode === 'long-document') {
      if (this.chatImageAttachments.length > 0) {
        this.chatImageAttachments = []
        new Notice('长文任务不能同时带图片，已移除待发送图片')
      }
      this.authorizedContentPaths = []
      this.authorizedContentChars = 0
      this.longDocumentPath = selection.path
      this.longDocumentChars = selection.totalChars
      new Notice('已进入长文任务：请在对话框写清楚要完成什么工作，然后发送')
    } else {
      this.longDocumentPath = ''
      this.longDocumentChars = 0
      this.authorizedContentPaths = selection.paths
      this.authorizedContentChars = selection.totalChars
    }
    this.refreshAuthorizedContentUi()
  }

  private clearAuthorizedContent(): void {
    this.authorizedContentPaths = []
    this.authorizedContentChars = 0
    this.longDocumentPath = ''
    this.longDocumentChars = 0
    this.longDocumentTask = null
    this.chatImageAttachments = []
    this.refreshAuthorizedContentUi()
  }

  private async openAttachmentMenu(event: MouseEvent): Promise<void> {
    if (this.mode === 'interview') {
      new Notice('请先结束访谈写作，再添加文件或图片')
      return
    }
    if (this.imageMode) {
      new Notice('AI 生图模式请使用上方「添加参考图」；退出生图模式后可上传图片让主对话识别')
      return
    }
    const menu = new Menu()
    menu.addItem((item) =>
      item
        .setTitle('从 Vault 选择文件或文件夹')
        .setIcon('files')
        .onClick(() => void this.openAuthorizedContentSelector()),
    )
    menu.addItem((item) =>
      item
        .setTitle('从 Vault 选择图片')
        .setIcon('image')
        .onClick(() => void this.addVaultChatImage()),
    )
    menu.addItem((item) =>
      item
        .setTitle('从电脑上传图片')
        .setIcon('folder-open')
        .onClick(() => void this.addComputerChatImages()),
    )
    menu.showAtMouseEvent(event)
  }

  private async addVaultChatImage(): Promise<void> {
    if (this.longDocumentPath) {
      new Notice('长文任务不能同时带图片，请先清除长文任务')
      return
    }
    if (this.chatImageAttachments.length >= 3) {
      new Notice('主对话单次最多上传 3 张图片')
      return
    }
    if (!(await this.plugin.requireProAccess('主对话图片附件'))) return
    chooseVaultAiImageReference(this.plugin, (reference) => {
      this.chatImageAttachments.push(reference)
      this.refreshAuthorizedContentUi()
      this.inputEl.focus()
    })
  }

  private async addComputerChatImages(): Promise<void> {
    if (this.longDocumentPath) {
      new Notice('长文任务不能同时带图片，请先清除长文任务')
      return
    }
    if (this.chatImageAttachments.length >= 3) {
      new Notice('主对话单次最多上传 3 张图片')
      return
    }
    if (!(await this.plugin.requireProAccess('主对话图片附件'))) return
    chooseComputerAiImageReferences(3 - this.chatImageAttachments.length, (references) => {
      this.chatImageAttachments.push(...references)
      this.refreshAuthorizedContentUi()
      this.inputEl.focus()
    })
  }

  private clearChatImageAttachments(): void {
    if (this.chatImageAttachments.length === 0) return
    this.chatImageAttachments = []
    this.refreshAuthorizedContentUi()
  }

  private refreshAuthorizedContentUi(): void {
    if (!this.authorizedContentBtn || !this.authorizedContentStatusEl) return
    const count = this.authorizedContentPaths.length
    const imageCount = this.chatImageAttachments.length
    const isLongDocument = Boolean(this.longDocumentPath)
    const attachmentCount = (isLongDocument ? 1 : count) + imageCount
    this.authorizedContentBtn.setText(
      isLongDocument && imageCount === 0
        ? '📄'
        : attachmentCount > 0
          ? `📎 ${attachmentCount}`
          : '📎',
    )
    this.authorizedContentBtn.setAttr(
      'aria-label',
      isLongDocument
        ? '已选择长文任务，点击更换'
        : attachmentCount > 0
          ? `已添加 ${attachmentCount} 个附件，点击更换`
          : '添加文件或图片',
    )
    this.authorizedContentBtn.title =
      isLongDocument
        ? '已选择长文任务，点击更换'
        : attachmentCount > 0
          ? `已添加 ${attachmentCount} 个附件，点击更换`
          : '添加文件或图片（Pro）'
    this.authorizedContentBtn.toggleClass('is-active', attachmentCount > 0)
    this.authorizedContentStatusEl.empty()
    this.authorizedContentStatusEl.toggle(attachmentCount > 0)
    if (attachmentCount === 0) return
    const statusParts: string[] = []
    if (isLongDocument) {
      statusParts.push(
        `长文任务 · ${this.longDocumentPath.split('/').at(-1) ?? this.longDocumentPath}` +
          (this.longDocumentChars > 0
            ? ` · ${this.longDocumentChars.toLocaleString('zh-CN')} 字`
            : ''),
      )
    } else if (count > 0) {
      statusParts.push(
        `当前对话持续带上 ${count} 份已授权文件` +
          (this.authorizedContentChars > 0
            ? ` · ${this.authorizedContentChars.toLocaleString('zh-CN')} 字`
            : ''),
      )
    }
    if (imageCount > 0) {
      statusParts.push(
        `下一条消息带上 ${imageCount} 张图片：${this.chatImageAttachments
          .map((image) => image.name)
          .join('、')}`,
      )
    }
    this.authorizedContentStatusEl.createSpan({
      text: statusParts.join('；'),
    })
    const changeBtn = this.authorizedContentStatusEl.createEl('button', { text: '更换' })
    changeBtn.onclick = (event) => void this.openAttachmentMenu(event)
    const clearBtn = this.authorizedContentStatusEl.createEl('button', { text: '清除' })
    clearBtn.onclick = () => this.clearAuthorizedContent()
  }

  private async authorizedContentContext(
    currentNotePath?: string,
  ): Promise<{ items: { filename: string; path: string; text: string }[] } | undefined> {
    if (this.authorizedContentPaths.length === 0) return undefined
    const capabilities = await this.plugin.getCapabilities()
    if (capabilities.tier !== 'pro' && capabilities.tier !== 'business') {
      this.clearAuthorizedContent()
      throw new Error('多笔记与文件夹授权是 Pro 及以上会员功能')
    }
    const limits = this.authorizedContentLimits(capabilities)
    const items: { filename: string; path: string; text: string }[] = []
    let totalChars = 0
    for (const path of this.authorizedContentPaths) {
      if (path === currentNotePath) continue
      const file = this.app.vault.getAbstractFileByPath(path)
      if (!(file instanceof TFile)) continue
      const text = (await readLocalDocumentText(this.app, file, limits.maxPerFileChars, 'chat')).text
      if (!text.trim()) continue
      if (text.length > limits.maxPerFileChars) {
        throw new Error(
          `《${file.basename}》超过单篇 ${limits.maxPerFileChars.toLocaleString('zh-CN')} 字上限，` +
          '请拆分后再使用',
        )
      }
      totalChars += text.length
      if (totalChars > limits.maxTotalChars) {
        throw new Error(
          `已授权内容超过 ${limits.maxTotalChars.toLocaleString('zh-CN')} 字上限，请减少几篇后重试`,
        )
      }
      items.push({ filename: file.name, path: file.path, text })
    }
    if (items.length > limits.maxFiles) {
      throw new Error(`单次最多带上 ${limits.maxFiles} 篇笔记`)
    }
    this.authorizedContentChars = totalChars
    this.refreshAuthorizedContentUi()
    return items.length > 0 ? { items } : undefined
  }

  private vaultSearchLimits(data?: PluginCapabilities): {
    maxSources: number
    maxExcerptChars: number
    maxTotalChars: number
  } {
    const capability = data?.features?.chat?.vaultSearch
    return {
      maxSources: capability?.maxSources ?? 6,
      maxExcerptChars: capability?.maxExcerptChars ?? 1_200,
      maxTotalChars: capability?.maxTotalChars ?? 7_200,
    }
  }

  private async vaultSearchContext(
    query: string,
    currentNotePath?: string,
    extraExcludedPaths: string[] = [],
  ): Promise<{
    context:
      | {
          query: string
          items: { sourceId: string; filename: string; excerpt: string }[]
        }
      | undefined
    sources: VaultMessageSource[]
  }> {
    // 精确选择文件/文件夹时，以用户明确划定的资料范围为准，避免额外混入其他笔记。
    if (!this.vaultSearchEnabled || this.authorizedContentPaths.length > 0 || this.longDocumentPath) {
      return { context: undefined, sources: [] }
    }
    let capabilities: PluginCapabilities | undefined
    try {
      capabilities = await this.plugin.getCapabilities()
      if (capabilities.features?.chat?.vaultSearch?.available === false) {
        return { context: undefined, sources: [] }
      }
    } catch {
      // 旧服务端暂时没有能力字段时仍按客户端保守上限搜索；v1 路由会再次校验。
    }
    const search = await this.plugin.vaultSearch.search(query, {
      ...this.vaultSearchLimits(capabilities),
      excludedPaths: [
        ...(currentNotePath ? [currentNotePath] : []),
        ...extraExcludedPaths,
      ],
      excludedFolders: [this.localSkills.root()],
    })
    const items = [
      ...(search.fact ? [search.fact] : []),
      ...search.results.map((result) => ({
        sourceId: result.sourceId,
        filename: result.filename,
        excerpt: result.excerpt,
      })),
    ]
    return {
      context:
        items.length > 0
          ? {
              query,
              items,
            }
          : undefined,
      sources: search.results.map(toVaultMessageSource),
    }
  }

  /** 本地候选图片元数据绝不传给主对话；云端只收到标准 UIMessage。 */
  private messagesForApi(): WireMessage[] {
    return this.messages.map(({ id, role, parts }) => ({ id, role, parts }))
  }

  private async send() {
    const text = this.inputEl.value.trim()
    if (!text || this.sending) return

    const imageAttachments = this.chatImageAttachments.slice()
    this.messages.push({
      id: uid(),
      role: 'user',
      parts: [{ type: 'text', text }],
      imageAttachmentNames:
        imageAttachments.length > 0 ? imageAttachments.map((image) => image.name) : undefined,
    })
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
      if (this.longDocumentPath) {
        await this.startLongDocumentTask(text)
        return
      }
      if (isLocalSkillListIntent(text)) {
        const skills = await this.localSkills.list()
        this.messages.push({
          id: uid(),
          role: 'assistant',
          parts: [{ type: 'text', text: formatLocalSkillList(skills, this.localSkills.root()) }],
        })
        await this.persistNow()
        return
      }
      const localSkillMatch = await this.localSkills.resolve(text)
      if (localSkillMatch.kind === 'missing') {
        throw new Error(
          `没有找到你点名的本地 Skill。可以说「查看本地 Skills」，` +
            `或检查文件是否在 ${this.localSkills.root()}/。`,
        )
      }
      if (localSkillMatch.kind === 'ambiguous') {
        throw new Error(
          `有多个本地 Skill 同时匹配：${localSkillMatch.skills
            .map((skill) => skill.displayName)
            .join('、')}。请说出完整技能名后重试。`,
        )
      }
      const localSkill =
        localSkillMatch.kind === 'matched' ? localSkillMatch.skill : undefined
      const noteContext = await this.currentNoteContext()
      if (localSkill?.output === 'update-current-note' && !noteContext) {
        throw new Error(
          `本地 Skill《${localSkill.name}》需要修改当前笔记。请打开目标笔记并勾选「主对话带上当前笔记」。`,
        )
      }
      const authorizedContent = await this.authorizedContentContext(noteContext?.path)
      // “修改第一张图片/封面”属于配图修改，不得误送进正文局部补丁协议。
      // 图片修改会在 AI 回复下方显示专用入口，先预览候选图再由用户确认替换。
      const illustrationEdit = isArticleIllustrationEditIntent(text)
      const singleIllustration = Boolean(noteContext && isSingleArticleIllustrationIntent(text))
      const directNoteEdit = Boolean(
        noteContext && !illustrationEdit && !singleIllustration && isNoteEditIntent(text),
      )
      const noteEdit =
        directNoteEdit ||
        Boolean(
          noteContext &&
            !illustrationEdit &&
            !singleIllustration &&
            localSkill?.output === 'update-current-note',
        )
      const vaultSearch =
        noteEdit || singleIllustration || illustrationEdit || imageAttachments.length > 0
          ? { context: undefined, sources: [] }
          : await this.vaultSearchContext(
              text,
              noteContext?.path,
              localSkill ? [localSkill.path] : [],
            )
      const localSkillRequest = localSkill
        ? {
            name: localSkill.name,
            description: localSkill.description,
            output: localSkill.output,
            content: localSkill.content,
          }
        : undefined
      if (localSkill) new Notice(`正在调用本地 Skill：${localSkill.name}`, 4000)
      // M3:优先流式(fetch 纯文本流,逐块显示);CORS/网络不支持时自动回落非流式;
      // 业务错误(积分不足/tier/限流)不回落不重发,直接显示。
      let answer: string
      let streamed: { kind: 'ok'; text: string } | { kind: 'bizError'; message: string } | null
      try {
        streamed = await this.sendStreaming(
          noteContext,
          authorizedContent,
          localSkillRequest,
          vaultSearch.context,
          imageAttachments,
          noteEdit,
          singleIllustration,
        )
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
            authorizedContent,
            imageAttachments: imageAttachments.map((image) => ({
              filename: image.name,
              dataUrl: image.dataUrl,
              mediaType: 'image/jpeg',
            })),
            vaultSearch: vaultSearch.context,
            noteEdit,
            noteImageIntent: singleIllustration,
            localSkill: localSkillRequest,
          },
        })
        answer = typeof data.text === 'string' ? data.text : '(空响应)'
      }
      if (!answer.startsWith('⚠️')) this.clearChatImageAttachments()
      this.messages.push({
        id: uid(),
        role: 'assistant',
        parts: [{ type: 'text', text: answer }],
        vaultSources: vaultSearch.sources,
      })
      await this.persistNow()
      if (singleIllustration && noteContext && !answer.startsWith('⚠️')) {
        await this.generateChatIllustration(text, noteContext)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      new Notice(`AI霖子:${msg}`, 6000)
      // 失败的那条用户消息保留在输入历史里,方便重试
      if (!this.longDocumentTask) {
        this.messages.push({
          id: uid(),
          role: 'assistant',
          parts: [{ type: 'text', text: `⚠️ ${msg}` }],
        })
      }
    } finally {
      this.sending = false
      this.sendBtn.disabled = false
      this.renderMessages()
    }
  }

  private async startLongDocumentTask(instruction: string): Promise<void> {
    const capabilities = await this.plugin.getCapabilities(true)
    if (capabilities.tier !== 'pro' && capabilities.tier !== 'business') {
      throw new Error('长文任务是 Pro 及以上会员功能')
    }
    if (capabilities.features?.chat?.longDocument?.available !== true) {
      throw new Error('服务器暂未开放长文任务，请更新插件或稍后重试')
    }
    const file = this.app.vault.getAbstractFileByPath(this.longDocumentPath)
    if (!(file instanceof TFile)) throw new Error('选中的长文档已经移动或删除，请重新选择')
    const limits = this.longDocumentLimits(capabilities)
    const document = await readLocalDocumentText(this.app, file, limits.maxChars)
    const chunks = splitLongDocument(document.text, limits.chunkChars, limits.maxChunks)
    if (chunks.length === 0) throw new Error('这份文件没有可处理的正文')
    this.longDocumentTask = {
      taskId: uid(),
      path: file.path,
      filename: file.name,
      mtime: file.stat.mtime,
      size: file.stat.size,
      instruction,
      totalChars: document.totalChars,
      chunks,
      summaries: [],
      nextIndex: 0,
      stage: 'processing',
    }
    this.renderMessages()
    await this.processLongDocumentTask()
  }

  private async processLongDocumentTask(): Promise<void> {
    const task = this.longDocumentTask
    if (!task) return
    const file = this.app.vault.getAbstractFileByPath(task.path)
    if (!(file instanceof TFile) || file.stat.mtime !== task.mtime || file.stat.size !== task.size) {
      task.stage = 'paused'
      task.error = '原文件在处理中发生了变化。为避免合并错版本，请取消后重新选择这份文件。'
      this.renderMessages()
      throw new Error(task.error)
    }
    try {
      task.stage = 'processing'
      task.error = undefined
      while (task.nextIndex < task.chunks.length) {
        const chunk = task.chunks[task.nextIndex]
        this.renderMessages()
        const data = await this.plugin.api('/api/plugin/v1/long-document', {
          method: 'POST',
          body: {
            phase: 'chunk',
            taskId: task.taskId,
            sessionId: this.sessionId,
            instruction: task.instruction,
            filename: task.filename,
            chunkIndex: chunk.index,
            chunkCount: task.chunks.length,
            text: chunk.text,
          },
        })
        const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
        if (!summary) throw new Error(`第 ${chunk.index + 1} 段没有返回有效结果`)
        task.summaries[chunk.index] = summary
        task.nextIndex = chunk.index + 1
      }

      task.stage = 'synthesizing'
      this.renderMessages()
      const data = await this.plugin.api('/api/plugin/v1/long-document', {
        method: 'POST',
        body: {
          phase: 'final',
          taskId: task.taskId,
          sessionId: this.sessionId,
          instruction: task.instruction,
          filename: task.filename,
          totalChars: task.totalChars,
          summaries: task.summaries.map((summary, index) => ({ index, summary })),
        },
      })
      const answer = typeof data.text === 'string' ? data.text.trim() : ''
      if (!answer) throw new Error('长文合并没有返回有效结果')
      this.messages.push({
        id: uid(),
        role: 'assistant',
        parts: [{ type: 'text', text: answer }],
        vaultSources: [{
          sourceId: `long-document:${task.path}`,
          filename: task.filename,
          path: task.path,
        }],
      })
      this.longDocumentTask = null
      this.longDocumentPath = ''
      this.longDocumentChars = 0
      this.refreshAuthorizedContentUi()
      await this.persistNow()
      new Notice('✅ 长文任务已完成，结果已保留在当前对话，可直接存为笔记', 7000)
    } catch (error) {
      task.stage = 'paused'
      task.error = error instanceof Error ? error.message : String(error)
      this.renderMessages()
      throw error
    }
  }

  private async resumeLongDocumentTask(): Promise<void> {
    if (!this.longDocumentTask || this.sending) return
    this.sending = true
    this.sendBtn.disabled = true
    try {
      await this.processLongDocumentTask()
    } catch (error) {
      new Notice(`长文任务仍未完成：${error instanceof Error ? error.message : String(error)}`, 8000)
    } finally {
      this.sending = false
      this.sendBtn.disabled = false
      this.renderMessages()
    }
  }

  private cancelLongDocumentTask(): void {
    const task = this.longDocumentTask
    if (!task || this.sending) return
    this.longDocumentTask = null
    this.longDocumentPath = ''
    this.longDocumentChars = 0
    this.refreshAuthorizedContentUi()
    this.messages.push({
      id: uid(),
      role: 'assistant',
      parts: [{ type: 'text', text: `已取消《${task.filename}》的长文任务，没有生成残缺结果。` }],
    })
    void this.persistNow()
    this.renderMessages()
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
      // “继续修改这张”必须把上一张图当作主画布，绝不能因为当前笔记开关仍开着
      // 就改走公众号文章配图模板。只有没有上一张图、且用户明确点名当前笔记/文章
      // 配图时，才读取正文并进入文章配图专用流程。
      const editPreviousImage = Boolean(previousReference)
      const requestsCurrentNoteImage =
        !editPreviousImage && isExplicitCurrentNoteImageRequest(instruction)
      const noteContext = requestsCurrentNoteImage
        ? await this.currentNoteContext()
        : undefined
      if (requestsCurrentNoteImage && !noteContext) {
        throw new Error('请先打开目标笔记并勾选“主对话带上当前笔记”')
      }
      let imageUrl = ''
      let ratio: AiImageRatio = this.imageRatio
      let articleCandidate: ChatIllustrationCandidate | undefined
      if (noteContext) {
        articleCandidate = await generateArticleIllustrationFromChat(
          this.plugin,
          instruction,
          noteContext,
          {
            referenceImageDataUrls: references,
            sessionId: this.sessionId,
            ratio: this.imageRatio,
          },
        )
        imageUrl = articleCandidate.imageUrl
        ratio = articleCandidate.ratio ?? this.imageRatio
      } else {
        const generated = await generateAiImage(
          this.plugin,
          instruction,
          this.imageRatio,
          references,
          this.sessionId,
          editPreviousImage,
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
    this.clearAuthorizedContent()
    this.mode = 'interview'
    this.messages = []
    this.sessionId = newPluginSessionId()
    this.interviewBar.show()
    this.inputEl.placeholder = INTERVIEW_INPUT_PLACEHOLDER
    this.renderMessages()
    new Notice('✍️ 已进入访谈写作:先说你想写的方向', 5000)
  }

  exitInterviewMode() {
    this.clearAuthorizedContent()
    this.mode = 'chat'
    this.messages = []
    this.sessionId = newPluginSessionId()
    this.interviewBar.hide()
    this.inputEl.placeholder = CHAT_INPUT_PLACEHOLDER
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
    if (!token) return `⚠️ ${NOT_CONNECTED_MSG}`
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
    authorizedContent:
      | { items: { filename: string; path: string; text: string }[] }
      | undefined,
    localSkill:
      | {
          name: string
          description: string
          output: LocalSkillOutput
          content: string
        }
      | undefined,
    vaultSearch:
      | {
          query: string
          items: { sourceId: string; filename: string; excerpt: string }[]
        }
      | undefined,
    imageAttachments: LocalImageReference[],
    noteEdit: boolean,
    noteImageIntent: boolean,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'bizError'; message: string }> {
    const { serverUrl } = this.plugin.settings
    const token = this.plugin.getApiToken()
    if (!token) return { kind: 'bizError', message: NOT_CONNECTED_MSG }
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
        authorizedContent,
        imageAttachments: imageAttachments.map((image) => ({
          filename: image.name,
          dataUrl: image.dataUrl,
          mediaType: 'image/jpeg',
        })),
        vaultSearch,
        noteEdit,
        noteImageIntent,
        localSkill,
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

  /**
   * 对话创建本地 Skill 确认卡(v0.6.47)：
   * - 目标目录只来自本机设置，不接受模型路径；
   * - 固定写成 `<root>/<portable-name>/SKILL.md`；
   * - 只新建、不覆盖，已存在时要求用户换名。
   */
  private renderCreateLocalSkillOffers(row: HTMLElement, blocks: CreateLocalSkillBlock[]) {
    for (const block of blocks) {
      const root = this.localSkills.root()
      const filePath = normalizePath(`${root}/${block.name}/SKILL.md`)
      const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
      card.createDiv({
        text: `🧩 待创建 AI 工作流:${block.name}`,
        cls: 'ai-linzi-create-note-title',
      })
      card.createDiv({ text: block.description, cls: 'ai-linzi-create-note-preview' })
      card.createDiv({
        text: `保存位置:${filePath}`,
        cls: 'ai-linzi-create-note-preview',
      })
      const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
      const createBtn = actionsRow.createEl('button', { text: '创建 SKILL.md' })
      createBtn.onclick = () => {
        createBtn.disabled = true
        void (async () => {
          try {
            if (this.app.vault.getAbstractFileByPath(filePath)) {
              throw new Error(`已存在 ${filePath}，为避免覆盖请让 AI 换一个 Skill 名称`)
            }
            const parent = filePath.split('/').slice(0, -1)
            let current = ''
            for (const segment of parent) {
              current = current ? `${current}/${segment}` : segment
              if (this.app.vault.getAbstractFileByPath(current)) continue
              await this.app.vault.createFolder(current)
            }
            const file = await this.app.vault.create(filePath, block.content)
            card.empty()
            const done = card.createDiv({ cls: 'ai-linzi-create-note-done' })
            done.createSpan({ text: '✅ 已创建:' })
            const link = done.createEl('a', { text: file.path, href: '#' })
            link.onclick = (event) => {
              event.preventDefault()
              void this.app.workspace.openLinkText(file.path, '', false)
            }
            new Notice(`已创建本地 Skill:${file.path}`, 6000)
          } catch (error) {
            createBtn.disabled = false
            new Notice(`创建失败:${(error as Error).message}`, 7000)
          }
        })()
      }
    }
  }

  /** 「对话直接创建笔记」确认卡(v0.6.34):点击才落盘;writeOutput 保证白名单文件夹/日期前缀/只新建不覆盖 */
  private renderCreateNoteOffers(row: HTMLElement, blocks: CreateNoteBlock[]) {
    for (const block of blocks) {
      const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
      card.createDiv({ text: `📝 待创建笔记:${block.title}`, cls: 'ai-linzi-create-note-title' })
      const previewText = block.body.replace(/\s+/g, ' ').slice(0, 140)
      card.createDiv({
        text: previewText + (block.body.length > 140 ? '…' : ''),
        cls: 'ai-linzi-create-note-preview',
      })
      const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
      const folder = this.plugin.settings.outputFolder || 'AI霖子输出'
      const createBtn = actionsRow.createEl('button', { text: `创建到「${folder}」` })
      createBtn.onclick = () => {
        createBtn.disabled = true
        void (async () => {
          try {
            const file = await writeOutput(this.plugin, {
              skill: '主对话',
              platform: '通用',
              title: block.title,
              body: block.body,
            })
            card.empty()
            const done = card.createDiv({ cls: 'ai-linzi-create-note-done' })
            done.createSpan({ text: '✅ 已创建:' })
            const link = done.createEl('a', { text: file.path, href: '#' })
            link.onclick = (ev) => {
              ev.preventDefault()
              void this.app.workspace.openLinkText(file.path, '', false)
            }
            new Notice(`已创建笔记:${file.path}`)
          } catch (e) {
            createBtn.disabled = false
            new Notice(`创建失败:${(e as Error).message}`, 6000)
          }
        })()
      }
    }
  }

  /** 对话创建文件夹确认卡(v0.6.42):列出净化后的路径,点击才逐级创建,已存在跳过 */
  private renderCreateFolderOffer(row: HTMLElement, folders: string[]) {
    const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
    card.createDiv({ text: `📁 待创建文件夹(${folders.length} 个):`, cls: 'ai-linzi-create-note-title' })
    for (const path of folders) {
      card.createDiv({ text: `· ${path}`, cls: 'ai-linzi-create-note-preview' })
    }
    const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
    const createBtn = actionsRow.createEl('button', { text: `创建这 ${folders.length} 个文件夹` })
    createBtn.onclick = () => {
      createBtn.disabled = true
      void (async () => {
        let created = 0
        let skipped = 0
        try {
          for (const path of folders) {
            // 逐级确保父目录存在(vault.createFolder 不保证递归)
            const segments = normalizePath(path).split('/')
            let current = ''
            let createdForPath = 0
            for (const segment of segments) {
              current = current ? `${current}/${segment}` : segment
              if (this.app.vault.getAbstractFileByPath(current)) continue
              await this.app.vault.createFolder(current)
              createdForPath++
            }
            if (createdForPath > 0) created += createdForPath
            else skipped++
          }
          card.empty()
          card.createDiv({
            cls: 'ai-linzi-create-note-done',
            text: `✅ 已创建 ${created} 个文件夹${skipped > 0 ? `(${skipped} 个已存在,跳过)` : ''}`,
          })
          new Notice(`已创建 ${created} 个文件夹${skipped > 0 ? `,${skipped} 个已存在` : ''}`)
        } catch (e) {
          createBtn.disabled = false
          new Notice(`创建失败:${(e as Error).message}`, 6000)
        }
      })()
    }
  }

  private renderMessages(thinking = false) {
    this.listEl.empty()
    if (this.messages.length === 0) {
      // 空状态排版规范(2026-07-30 Alina 反馈):标题下所有文字进同一个 body 容器,
      // 同字号、同行宽、同对齐;不允许再出现两套字号/宽度。
      const empty = this.listEl.createDiv({ cls: 'ai-linzi-empty' })
      empty.createDiv({ text: '👋 我是 AI霖子', cls: 'ai-linzi-empty-title' })
      const body = empty.createDiv({ cls: 'ai-linzi-empty-body' })
      if (!this.plugin.getApiToken()) {
        // 未连接:主动给三步引导,不让用户发了消息撞报错才发现没配密钥
        body.createDiv({
          text: '第一次使用,先完成连接(约 1 分钟):',
          cls: 'ai-linzi-empty-sub',
        })
        const steps = body.createEl('ol', { cls: 'ai-linzi-empty-steps' })
        steps.createEl('li', { text: '到 AI霖子网页版「连接中心」生成你的连接密钥' })
        steps.createEl('li', { text: '在插件设置页粘贴密钥,点「测试连接」' })
        steps.createEl('li', { text: '回到这里,说出第一句话' })
        const btn = body.createEl('button', {
          text: '打开插件设置',
          cls: 'ai-linzi-empty-btn',
        })
        btn.onclick = () => this.plugin.openPluginSettings()
      } else {
        body.createDiv({
          text: '开着某篇笔记问我,我可以结合它给你商业判断、内容建议和下一步行动。',
          cls: 'ai-linzi-empty-sub',
        })
        // 已连接:给新手三个一分钟能跑通的起手式(文案与真实 UI 控件名严格一致)
        const starters = body.createDiv({ cls: 'ai-linzi-empty-starters' })
        starters.createDiv({ text: '3 个小技巧:' })
        const ul = starters.createEl('ul')
        ul.createEl('li', { text: '勾选「主对话带上当前笔记」,让我基于这篇笔记给建议' })
        ul.createEl('li', { text: '点「调用技能」→ 选题雷达,把素材笔记变成 10 个选题' })
        ul.createEl('li', { text: '写好的核心笔记点「存入知识库」,让我长期记住你的定位' })
      }
      const link = body.createDiv({ cls: 'ai-linzi-empty-link' })
      link.createSpan({ text: '进入网页版 ' })
      link.createEl('a', { text: 'chat.alinalinzi.com', href: 'https://chat.alinalinzi.com' })
      link.createSpan({ text: ' 可注册账号、查看和充值积分' })
      return
    }
    for (let mi = 0; mi < this.messages.length; mi++) {
      const m = this.messages[mi]
      const row = this.listEl.createDiv({
        cls: `ai-linzi-msg ai-linzi-msg-${m.role}`,
      })
      const body = row.createDiv({ cls: 'ai-linzi-msg-body' })
      this.enableMessageTextSelection(body)
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
        // 对话创建本地 Skill(v0.6.47)：先剥整个 Skill 块，避免其中的协议示例
        // 被后续“新建笔记/文件夹”解析器误当成独立写入动作。
        const localSkillCreateResult = extractCreateLocalSkillBlocks(skillResult.cleanText)
        // 对话直接创建笔记(v0.6.34):先剥标记块,确认卡在正文渲染后追加
        const createResult = extractCreateNoteBlocks(localSkillCreateResult.cleanText)
        const folderResult = extractCreateFolderBlocks(createResult.cleanText)
        const cleanText = folderResult.cleanText
        const patch = parseNotePatch(cleanText)
        const illustrationEdit = isArticleIllustrationEditIntent(previousUserText)
        const editReply = this.mode === 'chat' && !illustrationEdit && isNoteEditIntent(previousUserText)
        void MarkdownRenderer.render(this.app, patch?.displayText ?? cleanText, body, '', this)
        if ((m.vaultSources?.length ?? 0) > 0) this.renderVaultSources(row, m.vaultSources ?? [])
        if (localSkillCreateResult.blocks.length > 0) {
          this.renderCreateLocalSkillOffers(row, localSkillCreateResult.blocks)
        }
        if (createResult.blocks.length > 0) this.renderCreateNoteOffers(row, createResult.blocks)
        if (folderResult.folders.length > 0) this.renderCreateFolderOffer(row, folderResult.folders)
        if (m.articleIllustrationEditOffer) {
          this.renderArticleIllustrationEditOffer(row, m.articleIllustrationEditOffer)
          continue
        }
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
              const ok = await confirmAction(this.app, {
                title: '更新当前笔记',
                message: `将用这条回复替换笔记「${file.basename}」的正文(文档属性 frontmatter 保留)。\n\n改错了不用慌:笔记内可 ⌘Z 撤销,或 设置 → 文件恢复 里回滚历史版本。`,
                confirmLabel: '确认更新',
              })
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
        if ((m.imageAttachmentNames?.length ?? 0) > 0) {
          body.createDiv({
            text: `📷 ${m.imageAttachmentNames?.join('、')}`,
            cls: 'ai-linzi-msg-attachment-summary',
          })
        }
        body.createDiv({ text, cls: 'ai-linzi-msg-user-text' })
      }
    }
    if (this.longDocumentTask) this.renderLongDocumentProgress(this.longDocumentTask)
    if (thinking && !this.longDocumentTask) {
      const row = this.listEl.createDiv({ cls: 'ai-linzi-msg ai-linzi-msg-assistant' })
      const body = row.createDiv({ cls: 'ai-linzi-msg-body', text: 'AI霖子思考中…' })
      this.enableMessageTextSelection(body)
    }
    this.listEl.scrollTop = this.listEl.scrollHeight
  }

  private renderLongDocumentProgress(task: LongDocumentTaskState): void {
    const row = this.listEl.createDiv({
      cls: 'ai-linzi-msg ai-linzi-msg-assistant ai-linzi-long-document-progress',
    })
    const body = row.createDiv({ cls: 'ai-linzi-msg-body' })
    const completed = Math.min(task.nextIndex, task.chunks.length)
    const title =
      task.stage === 'synthesizing'
        ? '正在合并全部段落并完成你的任务…'
        : task.stage === 'paused'
          ? `长文任务暂停在 ${completed}/${task.chunks.length} 段`
          : `正在处理长文档 ${completed + 1}/${task.chunks.length} 段…`
    body.createEl('strong', { text: title })
    body.createDiv({
      text: `${task.filename} · ${task.totalChars.toLocaleString('zh-CN')} 字`,
      cls: 'ai-linzi-long-document-meta',
    })
    const progress = body.createEl('progress', {
      cls: 'ai-linzi-long-document-progress-bar',
      attr: { max: String(task.chunks.length + 1) },
    })
    progress.value = task.stage === 'synthesizing' ? task.chunks.length : completed
    if (task.error) {
      body.createDiv({ text: task.error, cls: 'ai-linzi-long-document-error' })
    }
    if (task.stage === 'paused') {
      const actions = body.createDiv({ cls: 'ai-linzi-msg-actions' })
      const resumeBtn = actions.createEl('button', { text: '继续处理', cls: 'mod-cta' })
      resumeBtn.onclick = () => void this.resumeLongDocumentTask()
      const cancelBtn = actions.createEl('button', { text: '取消任务' })
      cancelBtn.onclick = () => this.cancelLongDocumentTask()
    }
  }

  private renderVaultSources(row: HTMLElement, sources: VaultMessageSource[]): void {
    const unique = [...new Map(sources.map((source) => [source.path, source])).values()]
    if (unique.length === 0) return
    const panel = row.createDiv({ cls: 'ai-linzi-vault-sources' })
    panel.createSpan({ text: '本轮在 Vault 中找到：', cls: 'ai-linzi-vault-sources-label' })
    const links = panel.createDiv({ cls: 'ai-linzi-vault-source-links' })
    for (const source of unique) {
      const extension = source.filename.match(/\.([^.]+)$/)?.[1]?.toLocaleUpperCase()
      const basename = source.filename.replace(/\.(?:md|txt|pdf|docx)$/i, '')
      const button = links.createEl('button', {
        cls: 'ai-linzi-vault-source-link',
        text: extension ? `${basename} · ${extension}` : source.filename,
        attr: {
          title: source.path,
          'aria-label': `打开来源笔记 ${source.filename}`,
        },
      })
      button.onclick = () => {
        void this.app.workspace.openLinkText(source.path, '', false)
      }
    }
  }

  private enableMessageTextSelection(body: HTMLElement): void {
    // Obsidian 侧边面板会监听拖拽与右键事件。阻止事件继续冒泡，但不 preventDefault，
    // 浏览器仍会执行原生文字选择；选中文字后提供明确的右键“复制”菜单。
    body.addEventListener('pointerdown', (event) => event.stopPropagation())
    body.addEventListener('mousedown', (event) => event.stopPropagation())
    body.addEventListener('selectstart', (event) => event.stopPropagation())
    body.addEventListener('contextmenu', (event) => {
      const selection = window.getSelection()
      const selectedText = selection?.toString() ?? ''
      const anchorInside = Boolean(selection?.anchorNode && body.contains(selection.anchorNode))
      const focusInside = Boolean(selection?.focusNode && body.contains(selection.focusNode))
      if (!selectedText || (!anchorInside && !focusInside)) return
      event.preventDefault()
      event.stopPropagation()
      const menu = new Menu()
      menu.addItem((item) =>
        item
          .setTitle('复制')
          .setIcon('copy')
          .onClick(async () => {
            await navigator.clipboard.writeText(selectedText)
            new Notice('已复制选中的文字')
          }),
      )
      menu.showAtMouseEvent(event)
    })
  }

  private renderArticleIllustrationEditOffer(
    row: HTMLElement,
    offer: ArticleIllustrationEditOffer,
  ): void {
    const card = row.createDiv({ cls: 'ai-linzi-illustration-edit-offer' })
    card.createDiv({ text: offer.summary, cls: 'ai-linzi-illustration-edit-summary' })
    const button = card.createEl('button', {
      text: '🖼️ 修改某一张配图',
      cls: 'ai-linzi-apply-patch',
    })
    button.onclick = async () => {
      const target = this.app.vault.getAbstractFileByPath(offer.notePath)
      if (!(target instanceof TFile)) {
        new Notice('原文章已经移动或删除，请打开要修改的文章后重试')
        return
      }
      const active = this.app.workspace.getActiveFile() ?? this.plugin.lastActiveFile
      if (active?.path !== target.path) {
        await this.app.workspace.getLeaf('tab').openFile(target)
      }
      await runArticleIllustrationEdit(this.plugin)
    }
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
    meta.createSpan({ text: result.savedPath })
    if (result.articleCandidate) {
      meta.createSpan({ text: `建议放在「${result.articleCandidate.anchor}」之后` })
    }
    const actions = card.createDiv({ cls: 'ai-linzi-chat-image-actions' })
    const continueBtn = actions.createEl('button', { text: '继续修改这张' })
    continueBtn.onclick = async () => {
      this.activeImageMessageId = message.id
      this.usePreviousImage = true
      if (!(await this.setImageMode(true))) return
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
    meta.createSpan({ text: `放在「${candidate.anchor}」之后` })
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
        { ratio: previous.ratio ?? '16:9' },
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
      .setName('AI霖子连接密钥')
      .setDesc('在 AI霖子网页「我的 → 连接中心」生成后，直接粘贴到这里。无需填写密钥名称或 ID。')
      .addText((input) => {
        input.inputEl.type = 'password'
        input.inputEl.autocomplete = 'off'
        input
          .setPlaceholder('粘贴网页端生成的连接密钥')
          .setValue(this.plugin.getApiToken())
          .onChange(async (value) => {
            await this.plugin.setApiToken(value)
          })
      })

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

    new Setting(containerEl).setName('一人公司驾驶舱 · 目录映射').setHeading()
    containerEl.createEl('p', {
      text: '前四项用于驾驶舱「第二大脑」统计；最后一项指定 AI 工作流目录。路径都相对 Vault 根，所有扫描与写入都在本机完成。',
      cls: 'setting-item-description',
    })
    const cockpitFolderSetting = (
      name: string,
      desc: string,
      key: 'cockpitInboxFolder' | 'cockpitSourcesFolder' | 'cockpitKnowledgeFolder' | 'cockpitOutputFolder',
      placeholder: string,
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t
            .setPlaceholder(placeholder)
            .setValue(this.plugin.settings[key])
            .onChange(async (v) => {
              this.plugin.settings[key] = v.trim()
              await this.plugin.saveSettings()
            }),
        )
    }
    cockpitFolderSetting('收件箱 Inbox 文件夹', '随手记、待整理的内容先进这里;驾驶舱会提醒积压', 'cockpitInboxFolder', 'inbox')
    cockpitFolderSetting('原始素材 Raw 文件夹', '录音转写、聊天记录、灵感等原始输入', 'cockpitSourcesFolder', 'raw')
    cockpitFolderSetting('知识库 Wiki 文件夹', '整理后的方法论、案例、洞察', 'cockpitKnowledgeFolder', 'wiki')
    cockpitFolderSetting('对外输出 Output 文件夹', '发出去的文章、笔记、交付物', 'cockpitOutputFolder', 'output')
    new Setting(containerEl)
      .setName('AI 工作流 / SOP 文件夹')
      .setDesc('存放可被 AI霖子调用的 Skills；支持「技能名.md」或标准「技能名/SKILL.md」，也可在对话中让 AI 生成后确认写入')
      .addText((text) =>
        text
          .setPlaceholder('system/skills')
          .setValue(this.plugin.settings.localSkillsFolder)
          .onChange(async (value) => {
            this.plugin.settings.localSkillsFolder = normalizeLocalSkillRoot(value)
            this.plugin.vaultSearch.clear()
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

    new Setting(containerEl)
      .setName('默认智能搜索 Vault')
      .setDesc('在你的电脑本地搜索 Vault 内全部正常的 Markdown、TXT、可复制文字的 PDF 和 DOCX，只把相关的少量片段交给 AI；不会上传整个 Vault')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.vaultSearchDefault).onChange(async (v) => {
          this.plugin.settings.vaultSearchDefault = v
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
      .setDesc('从公众号后台复制后直接粘贴到这里，无需填写密钥名称或 ID。密钥只保存在当前设备的 Obsidian 安全存储中。')
      .addText((input) => {
        input.inputEl.type = 'password'
        input.inputEl.autocomplete = 'off'
        input
          .setPlaceholder('粘贴公众号 AppSecret')
          .setValue(this.plugin.getWechatAppSecret())
          .onChange(async (value) => {
            await this.plugin.setWechatAppSecret(value)
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

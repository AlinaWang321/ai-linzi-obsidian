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
  MarkdownView,
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
  isNoteEditIntent,
  parseNotePatch,
  type ParsedNotePatch,
} from './note-patch'
import {
  chooseComputerAiImageReferences,
  chooseVaultAiImageReference,
  feedKnowledge,
  feedKnowledgeWithResult,
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
import {
  explicitMemoryContent,
  isCurrentNoteKnowledgeSaveIntent,
  isFullCurrentNoteReplaceIntent,
} from './chat-action-intent'
import {
  extractCreateFolderBlocks,
  vaultStructureSettingPatch,
  VAULT_STRUCTURE_BINDING_LABELS,
  type VaultStructureBindingKey,
  type VaultStructurePlan,
} from './create-folder'
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
import { LocalVaultAgent, type VaultActionRecord } from './vault-agent'
import {
  VAULT_AGENT_MAX_ROUNDS,
  extractVaultOrganizePlan,
  extractVaultToolCalls,
  isExplicitCurrentNoteTrashRequest,
  isExplicitVaultTrashIntent,
  isStructuredNoteWriteIntent,
  isVaultMutationExplicitlyDenied,
  isVaultAgentToolAllowed,
  namespaceVaultToolCalls,
  operationLabel,
  vaultAutoAnswerRetryReason,
  vaultAnswerRetryReason,
  type VaultAnswerRetryReason,
  type VaultAgentToolResult,
  type VaultAgentIntent,
  type VaultOrganizePlan,
  type VaultWriteSnapshot,
} from './vault-agent-core'
import {
  formatLocalSkillList,
  isLocalSkillListIntent,
  localSkillMenuTitle,
  normalizeLocalSkillRoot,
  type LocalSkillOutput,
} from './local-skill-core'
import {
  extractChatAiImageRequests,
  isDirectAiImageEditRequest,
  requestedAiImageIndex,
  type ChatAiImageRequest,
} from './chat-ai-image'
import {
  LocalSkillRegistry,
  type ActiveLocalSkillContext,
} from './local-skills'
import {
  LocalSkillExecutor,
  type LocalSkillRunRecord,
} from './local-skill-executor'
import {
  localSkillActionSummary,
  type LocalSkillActionProposal,
} from './local-skill-execution-core'
import {
  isExplicitCurrentNoteIntent,
  selectCurrentOpenMarkdownPath,
  shouldUseCurrentNote,
} from './current-note-intent'
import { runCustomerConsultationBrief } from './customer-consultation-brief'
import {
  openCustomerCrmSyncModal,
  readLocalCustomerProfile,
} from './customer-profile-sync'

/** 内置动作的唯一清单:命令面板、正文右键、对话面板按钮三个入口共用 */
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
  { id: 'illustration', name: '文章配图:可使用你的专属人偶(先看方案再生图)', fn: runArticleIllustration },
  { id: 'wechat-copy', name: '公众号排版:一键复制(去后台粘贴)', fn: async (p) => copyWechatFormatted(p) },
  { id: 'wechat-draft', name: '发到公众号草稿箱(自动传图,需配置AppID)', fn: async (p) => sendToWechatDraft(p) },
  { id: 'xhs-cards', name: '小红书图文卡片:当前笔记 → 正文 + 3:4 PNG', fn: runXhsCards },
  { id: 'distribute', name: '多平台分发:当前笔记成稿 → 小红书/口播/朋友圈', fn: runDistribute },
  { id: 'customer-consultation-brief', name: '客户咨询简报:选择逐字稿 → 客户版 PNG 长图', fn: runCustomerConsultationBrief },
  { id: 'sales-review', name: '销售复盘:选择逐字稿 → 销售诊断', fn: runSalesReview },
  { id: 'feed-knowledge', name: '存入 AI霖子知识库:当前笔记', fn: feedKnowledge },
]

// ── 设置 ──────────────────────────────────────────────

interface AiLinziSettings {
  serverUrl: string
  /** SecretStorage 的内部条目名，仅用于兼容旧设置；不得在学员界面中暴露 */
  tokenSecretId: string
  /** @deprecated v0.7.17 起由明确的 Vault 对话意图按需触发，仅兼容旧 data.json。 */
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
  /** 驾驶舱目录映射(相对 vault 根;留空=该卡不统计)。新安装默认一人公司驾驶舱编号目录 */
  cockpitInboxFolder: string
  cockpitSourcesFolder: string
  cockpitKnowledgeFolder: string
  cockpitOutputFolder: string
  /** 用户指定的本地 AI 工作流 / SOP 根目录(相对 vault 根) */
  localSkillsFolder: string
  /** 本地程序执行默认关闭；开启后仍然每一步单独确认。 */
  localSkillExecutionEnabled: boolean
  /** 「AI霖子·今天的判断」按日缓存(免费但没必要一天生成多次) */
  cockpitJudgmentDate: string
  cockpitJudgmentText: string
  /** 合伙人学习进度里手动标记完成的步骤 key(clients10 由 CRM 自动判定不入此列表) */
  cockpitPartnerSteps: string[]
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  serverUrl: 'https://chat.alinalinzi.com',
  tokenSecretId: '',
  vaultSearchDefault: false,
  outputFolder: 'AI霖子输出',
  illustrationCharacterReferencePath: '',
  defaultNiche: '',
  wechatAppId: '',
  wechatAppSecretId: '',
  brandFooter: true,
  cockpitInboxFolder: '000_Inbox',
  cockpitSourcesFolder: '01_Raw',
  cockpitKnowledgeFolder: '02_Wiki',
  cockpitOutputFolder: '04_Output',
  localSkillsFolder: '05_System/Skills',
  localSkillExecutionEnabled: false,
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
  /** v0.7.17 及以前的主对话长期勾选状态；v0.7.18 起按本轮明确意图自动读取。 */
  attachNoteDefault?: boolean
  cleanChatDefaultsV1?: boolean
}

const DEFAULT_TOKEN_SECRET_ID = 'ai-linzi-api-token'
const DEFAULT_WECHAT_SECRET_ID = 'ai-linzi-wechat-app-secret'
const OFFICIAL_SERVER_URL = 'https://chat.alinalinzi.com'

const VIEW_TYPE_CHAT = 'ai-linzi-chat'
const CHAT_SEND_SHORTCUT_HINT = 'Enter 换行 · Mac / Windows：Control + Enter 发送'
const CHAT_INPUT_PLACEHOLDER = '问 AI霖子任何事…'
const INTERVIEW_INPUT_PLACEHOLDER = '先告诉 AI 你想写什么方向（一句话），它会开始采访你…'

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
      vaultAgent?: {
        available?: boolean
        maxRounds?: number
        maxCallsPerRound?: number
        tools?: string[]
        persistsToolResultsInHistory?: boolean
        modelRoutingMinPluginVersion?: string
        modelDecidesToolUse?: boolean
        keywordRoutingRequired?: boolean
        noPreScanBeforeToolCall?: boolean
      }
      vaultManagement?: {
        available?: boolean
        planFirst?: boolean
        requiresConfirmation?: boolean
        deletesFiles?: boolean
        overwritesExistingFiles?: boolean
        supportsUndo?: boolean
      }
      localSkills?: {
        available?: boolean
        localOnly?: boolean
        maxContentChars?: number
        requiresExplicitInvocation?: boolean
        persistsInHistory?: boolean
        localExecution?: {
          status?: string
          minPluginVersion?: string
          requiresConfirmation?: boolean
          programs?: string[]
        }
      }
      customerCrmSync?: {
        available?: boolean
        minPluginVersion?: string
        matchingPriority?: string[]
        requiresSeparateConfirmation?: boolean
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
  /** 主对话自然生图的本地图片卡片；图片已自动落到用户 Vault，不上传本地路径。 */
  aiImageResult?: ChatAiImageResult
  /** 整篇配图完成后的本地操作卡片；只保存目标笔记路径，不同步到云端。 */
  articleIllustrationEditOffer?: ArticleIllustrationEditOffer
  /** 本地 Vault 检索来源；只保存在插件本机历史，messagesForApi 会剥离。 */
  vaultSources?: VaultMessageSource[]
  /** 只保留用户本轮上传的图片名称；图片数据不写本机或云端历史。 */
  imageAttachmentNames?: string[]
  /** 本地整理方案的执行日志 ID；方案正文仍在 parts 的本机副本中。 */
  vaultActionId?: string
  /** 跨文件写入方案生成时锁定的文件版本；只保存路径/mtime/size，不含正文。 */
  vaultWriteSnapshots?: VaultWriteSnapshot[]
  /** 本地 Skill 动作日志只保存元数据，不保存命令输出、系统路径或正文。 */
  localSkillRunIds?: string[]
  /** 本轮实际调用的本地 Skill 入口；只用于同一对话续跑，不上传到服务端。 */
  localSkillPath?: string
  /** 成功写入后识别到的本地客户档案；只存 Vault 路径，不存正文。 */
  customerCrmSyncPath?: string
  /** 用户二次确认后完成的 CRM 同步回执。 */
  customerCrmSynced?: { id: number; label: string; syncedAt: number }
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
  /** 同一轮多图生成的本地标识，用于“修改第 2 张”精确选图。 */
  batchId?: string
  batchIndex?: number
  batchTotal?: number
  label?: string
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
  vaultActionHistory?: VaultActionRecord[]
  localSkillRunHistory?: LocalSkillRunRecord[]
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

class LocalSkillActionConfirmModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private readonly skillName: string,
    private readonly action: LocalSkillActionProposal,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.setTitle('允许“我的 Skills”执行这一步？')
    this.contentEl.addClass('ai-linzi-local-action-modal')
    this.contentEl.createEl('p', {
      text: `Skill《${this.skillName}》申请：${localSkillActionSummary(this.action)}`,
    })
    const details = this.contentEl.createEl('dl', { cls: 'ai-linzi-local-action-details' })
    details.createEl('dt', { text: '工作目录' })
    details.createEl('dd', { text: this.action.cwd })
    details.createEl('dt', { text: '参数' })
    details.createEl('dd', {
      text: this.action.args.length > 0 ? this.action.args.join('  ') : '（无）',
      cls: 'ai-linzi-local-action-code',
    })
    details.createEl('dt', { text: '预计生成' })
    details.createEl('dd', {
      text: this.action.writes.length > 0 ? this.action.writes.join('、') : '不生成 Vault 文件',
    })
    details.createEl('dt', { text: '联网' })
    details.createEl('dd', {
      text: this.action.usesNetwork ? '这个脚本可能联网' : '本动作未声明联网',
    })
    details.createEl('dt', { text: '交给 AI' })
    details.createEl('dd', {
      text: this.action.shareOutputWithAi
        ? '会把这一步最多 4,000 字的终端输出临时交给 AI 判断（不写入对话历史）'
        : '不会把终端输出交给 AI',
    })
    this.contentEl.createEl('p', {
      text: '插件不会通过 Shell 解释这些参数，也会拒绝声明输出位置的同名文件。但脚本不是系统沙箱，仍拥有 Obsidian 当前用户权限；只允许你信任的 Skill。你可以取消，仅跳过这一步。',
      cls: 'ai-linzi-local-action-warning',
    })
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
    const cancel = actions.createEl('button', { text: '取消这一步' })
    cancel.onclick = () => this.finish(false)
    const confirm = actions.createEl('button', { text: '允许执行', cls: 'mod-cta' })
    confirm.onclick = () => this.finish(true)
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

function confirmLocalSkillAction(
  app: App,
  skillName: string,
  action: LocalSkillActionProposal,
): Promise<boolean> {
  return new Promise((resolve) => {
    new LocalSkillActionConfirmModal(app, skillName, action, resolve).open()
  })
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

const BUTTON_PRESS_FEEDBACK_MS = 180
const buttonFeedbackContainers = new WeakSet<HTMLElement>()
const buttonFeedbackTimers = new WeakMap<HTMLButtonElement, number>()

/**
 * 给 AI霖子界面里的按钮统一增加轻微按下/回弹反馈。
 * 使用事件委托，后续动态渲染出来的历史行和消息按钮也自动生效；
 * 只改变本地视觉状态，不介入任何按钮原有业务逻辑。
 */
function installButtonPressFeedback(container: HTMLElement): void {
  if (buttonFeedbackContainers.has(container)) return
  buttonFeedbackContainers.add(container)

  const replay = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return
    const button = target.closest('button')
    if (!(button instanceof HTMLButtonElement) || !container.contains(button) || button.disabled) return

    const previousTimer = buttonFeedbackTimers.get(button)
    if (previousTimer !== undefined) window.clearTimeout(previousTimer)
    button.removeClass('is-ai-linzi-pressed')
    void button.offsetWidth
    button.addClass('is-ai-linzi-pressed')
    const timer = window.setTimeout(() => {
      button.removeClass('is-ai-linzi-pressed')
      buttonFeedbackTimers.delete(button)
    }, BUTTON_PRESS_FEEDBACK_MS)
    buttonFeedbackTimers.set(button, timer)
  }

  container.addEventListener('pointerdown', (event) => replay(event.target))
  container.addEventListener('keydown', (event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
    replay(event.target)
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
    installButtonPressFeedback(this.modalEl)
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
  readonly vaultAgent = new LocalVaultAgent(
    this.app,
    this.vaultSearch,
    () => this.settings.localSkillsFolder,
  )
  readonly localSkillExecutor = new LocalSkillExecutor(
    this.app,
    () => this.settings.outputFolder,
  )
  private capabilitiesCache: { data: PluginCapabilities; loadedAt: number } | null = null
  private savedConversations: SavedConvo[] = []
  private savedIllustrationJobs: unknown[] = []
  private vaultActionHistory: VaultActionRecord[] = []
  private localSkillRunHistory: LocalSkillRunRecord[] = []
  /**
   * 最近一次激活且仍然打开的笔记。它只用于侧边面板获得焦点后的界面衔接，
   * 不能把已经关闭的标签页或 Obsidian“最近打开记录”重新解释为读取授权。
   */
  lastActiveFile: TFile | null = null
  async onload() {
    await this.loadSettings()

    // 插件重载时 active leaf 可能正好是右侧对话面板；先从仍打开的 Markdown
    // 标签页恢复“用户刚才在看的笔记”，避免勾选成功却拿不到正文。
    this.rememberCurrentMarkdownFile()
    this.app.workspace.onLayoutReady(() => this.rememberCurrentMarkdownFile())

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.rememberCurrentMarkdownFile()
      }),
    )
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file?.extension.toLowerCase() === 'md') this.lastActiveFile = file
        else this.rememberCurrentMarkdownFile()
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

    this.addCommand({
      id: 'undo-last-vault-organization',
      name: '撤销上一次 AI Vault 整理',
      callback: () => void this.undoLastVaultAction(),
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

  openMarkdownFile(path: string): TFile | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
        return leaf.view.file
      }
    }
    return null
  }

  rememberCurrentMarkdownFile(): TFile | null {
    const openFiles = this.app.workspace
      .getLeavesOfType('markdown')
      .map((leaf) => (leaf.view instanceof MarkdownView ? leaf.view.file : null))
      .filter((file): file is TFile => Boolean(file))
    const active = this.app.workspace.getActiveFile()
    const recentRootLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
    const selectedPath = selectCurrentOpenMarkdownPath({
      activePath: active?.extension.toLowerCase() === 'md' ? active.path : undefined,
      recentRootPath:
        recentRootLeaf?.view instanceof MarkdownView
          ? recentRootLeaf.view.file?.path
          : undefined,
      lastActivePath: this.lastActiveFile?.path,
      openPaths: openFiles.map((file) => file.path),
    })
    const selected = selectedPath
      ? openFiles.find((file) => file.path === selectedPath) ?? null
      : null
    this.lastActiveFile = selected
    return selected
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
      attachNoteDefault: legacyAttachNoteDefault,
      cleanChatDefaultsV1: legacyCleanChatDefaultsV1,
      conversations,
      illustrationJobs,
      vaultActionHistory,
      localSkillRunHistory,
      ...safeSettings
    } = raw
    this.savedConversations = Array.isArray(conversations) ? conversations : []
    this.savedIllustrationJobs = Array.isArray(illustrationJobs) ? illustrationJobs : []
    this.vaultActionHistory = Array.isArray(vaultActionHistory)
      ? (vaultActionHistory as VaultActionRecord[]).slice(0, 20)
      : []
    this.localSkillRunHistory = Array.isArray(localSkillRunHistory)
      ? (localSkillRunHistory as LocalSkillRunRecord[]).slice(0, 50)
      : []
    this.settings = Object.assign({}, DEFAULT_SETTINGS, safeSettings)
    let migrated =
      legacyVaultSearchExcludedFolders !== undefined ||
      legacyLastUpdateCheckAt !== undefined ||
      legacyAttachNoteDefault !== undefined ||
      legacyCleanChatDefaultsV1 !== undefined
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

  getVaultActionRecord(id?: string): VaultActionRecord | undefined {
    return id
      ? this.vaultActionHistory.find((record) => record.id === id)
      : this.vaultActionHistory.find((record) => !record.undoneAt && record.moves.length > 0)
  }

  captureVaultWriteSnapshots(plan: VaultOrganizePlan): VaultWriteSnapshot[] {
    return this.vaultAgent.captureWriteSnapshots(plan)
  }

  async applyVaultPlan(
    plan: VaultOrganizePlan,
    writeSnapshots: VaultWriteSnapshot[] = [],
  ): Promise<VaultActionRecord> {
    const record = await this.vaultAgent.applyPlan(plan, writeSnapshots)
    this.vaultActionHistory = [record, ...this.vaultActionHistory].slice(0, 20)
    await this.saveSettings()
    return record
  }

  async undoVaultAction(id?: string): Promise<VaultActionRecord> {
    const record = this.getVaultActionRecord(id)
    if (!record) throw new Error('没有找到可撤销的 AI Vault 整理记录')
    if (record.moves.length === 0) {
      throw new Error('这次操作只有回收站笔记，请从系统废纸篓/回收站恢复')
    }
    await this.vaultAgent.undo(record)
    record.undoneAt = Date.now()
    await this.saveSettings()
    return record
  }

  async recordLocalSkillRun(record: LocalSkillRunRecord): Promise<void> {
    this.localSkillRunHistory = [record, ...this.localSkillRunHistory].slice(0, 50)
    await this.saveSettings()
  }

  async undoLocalSkillRun(id: string): Promise<LocalSkillRunRecord> {
    const record = this.getLocalSkillRunRecord(id)
    if (!record) throw new Error('没有找到这次 Skill 执行记录')
    await this.localSkillExecutor.undoCreatedOutputs(record)
    await this.saveSettings()
    return record
  }

  getLocalSkillRunRecord(id: string): LocalSkillRunRecord | undefined {
    return this.localSkillRunHistory.find((record) => record.id === id)
  }

  private async undoLastVaultAction(): Promise<void> {
    const record = this.getVaultActionRecord()
    if (!record) {
      new Notice('没有可撤销的 AI Vault 整理记录')
      return
    }
    const ok = await confirmAction(this.app, {
      title: '撤销上一次 AI Vault 整理',
      message: `将把「${record.planTitle}」移动/重命名的 ${record.moves.length} 项恢复到原位置。整理时新建的空文件夹会保留，不删除任何文件。`,
      confirmLabel: '确认撤销',
    })
    if (!ok) return
    await this.undoVaultAction(record.id)
    new Notice(`✅ 已撤销「${record.planTitle}」`)
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
      vaultActionHistory: this.vaultActionHistory,
      localSkillRunHistory: this.localSkillRunHistory,
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
  private localSkills: LocalSkillRegistry
  /** 普通主对话下一轮要识别的图片；压缩数据只驻留当前进程，发送后立即释放。 */
  private chatImageAttachments: LocalImageReference[] = []
  private activeImageMessageId = ''
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
  private authorizedContentBtn!: HTMLButtonElement
  private authorizedContentStatusEl!: HTMLElement

  constructor(leaf: WorkspaceLeaf, plugin: AiLinziPlugin) {
    super(leaf)
    this.plugin = plugin
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
    installButtonPressFeedback(root)

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
      this.clearAuthorizedContent()
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

    // 动作按钮行：只放导航类入口。保存笔记、更新笔记和沉淀知识都由用户
    // 直接在对话中说明，真正写入时再显示针对性的确认卡，避免常驻按钮混淆。
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
    const dashboardBtn = actionsRow.createEl('button', { text: '内容看板', cls: 'ai-linzi-action-btn' })
    dashboardBtn.onclick = () => void this.plugin.activateContentDashboard()
    const cockpitBtn = actionsRow.createEl('button', {
      text: 'CEO驾驶舱',
      cls: 'ai-linzi-action-btn',
      attr: { title: '打开一人公司驾驶舱' },
    })
    cockpitBtn.onclick = () => void this.plugin.activateCockpit()
    const localSkillsBtn = actionsRow.createEl('button', {
      text: '我的 Skills',
      cls: 'ai-linzi-action-btn',
      attr: { title: `查看保存在 ${this.localSkills.root()}/ 中的自建 Skill` },
    })
    localSkillsBtn.onclick = (event: MouseEvent) => void this.showLocalSkillsMenu(event)

    this.authorizedContentStatusEl = footer.createDiv({
      cls: 'ai-linzi-authorized-content-status',
    })
    // 初始必须显式隐藏:📎 按钮此时未创建,refreshAuthorizedContentUi 会因守卫早退,
    // 不隐藏就会在输入框上方留一个空的蓝框(0.6.32 Alina 实测反馈)
    this.authorizedContentStatusEl.toggle(false)
    this.refreshAuthorizedContentUi()

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

    this.renderMessages()
    // 恢复最近一次会话(升级/重启后不丢)
    void this.restoreLatest()
  }

  private async showLocalSkillsMenu(event: MouseEvent): Promise<void> {
    const skills = await this.localSkills.list()
    if (skills.length === 0) {
      new Notice('“我的 Skills”中还没有 Skill。你可以直接在主对话中让我创建。', 5000)
      return
    }
    const menu = new Menu()
    for (const skill of skills) {
      menu.addItem((item) =>
        item
          .setTitle(localSkillMenuTitle(skill))
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
    this.renderMessages()
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

  private recentCurrentNotePath(): string | undefined {
    for (let index = this.messages.length - 1; index >= Math.max(0, this.messages.length - 6); index--) {
      const source = this.messages[index].vaultSources?.find((item) =>
        item.sourceId.startsWith('current-note:'),
      )
      if (source?.path) return source.path
    }
    return undefined
  }

  private async currentNoteContext(
    lockedPath?: string,
  ): Promise<{ filename: string; text: string; path: string } | undefined> {
    // 连续对话必须保持上一轮锁定的同一篇。若文件已移动或删除就停止，绝不能
    // 悄悄换成用户此刻打开的另一篇笔记；若标签页已关闭，也视为撤销授权。
    const file = lockedPath
      ? this.plugin.openMarkdownFile(lockedPath) ?? undefined
      : this.plugin.rememberCurrentMarkdownFile()
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

  /** 本地候选图片元数据绝不传给主对话；云端只收到标准 UIMessage。 */
  private messagesForApi(): WireMessage[] {
    return this.messages.map(({ id, role, parts }) => ({ id, role, parts }))
  }

  private recentLocalSkillPath(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const path = this.messages[index].localSkillPath
      if (path) return path
    }
    return undefined
  }

  /** 取得上一条可直接写入 Markdown 的 AI 正文；所有本机协议块都先剥离。 */
  private lastAssistantContentForReplace(): string | undefined {
    for (let index = this.messages.length - 2; index >= 0; index--) {
      const message = this.messages[index]
      if (message.role !== 'assistant' || message.imageResult || message.aiImageResult) continue
      const raw = message.parts.map((part) => part.text).join('')
      const vault = extractVaultOrganizePlan(raw)
      const skill = extractPluginSkillSuggestions(vault.cleanText, '')
      const localSkill = extractCreateLocalSkillBlocks(skill.cleanText)
      const note = extractCreateNoteBlocks(localSkill.cleanText)
      const folders = extractCreateFolderBlocks(note.cleanText)
      const patch = parseNotePatch(folders.cleanText)
      const clean = (patch?.displayText ?? folders.cleanText).trim()
      if (clean && !clean.startsWith('⚠️')) return prepareWechatArticle(clean).body.trim()
    }
    return undefined
  }

  private async rememberExplicitFact(content: string): Promise<string> {
    const data = (await this.plugin.api('/api/plugin/v1/memories/remember', {
      method: 'POST',
      body: { content },
    })) as {
      status?: 'inserted' | 'updated' | 'skipped' | 'failed'
      content?: string
      reason?: string
    }
    if (data.status === 'inserted') return `✅ 已存入事实记忆：${data.content ?? content}`
    if (data.status === 'updated') return `✅ 已更新已有事实记忆：${data.content ?? content}`
    if (data.status === 'skipped') {
      return `没有写入事实记忆：${data.reason ?? '这段内容没有被确认是关于你本人的新事实'}。你可以把“关于我本人的事实”说得更明确后再试。`
    }
    throw new Error(data.reason ?? '事实记忆没有保存成功，请稍后再试')
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
      const requestedImageIndex = requestedAiImageIndex(text)
      if (isDirectAiImageEditRequest(text) && requestedImageIndex) {
        const target = this.directAiImageEditTarget(text)
        if (!target) {
          throw new Error('没有找到你点名的那张图片；请确认是当前对话最近一组中的第几张')
        }
        this.activeImageMessageId = target.message.id
      }
      if (isDirectAiImageEditRequest(text)) {
        const target = this.directAiImageEditTarget(text)
        if (target) {
          this.activeImageMessageId = target.message.id
        }
      }
      if (isCurrentNoteKnowledgeSaveIntent(text)) {
        // 发送瞬间锁定当前真正打开的 Markdown 标签页；等待 AI 推荐章节期间即使
        // 用户切到别的笔记，也不会把来源换掉。
        const lockedFile = this.plugin.rememberCurrentMarkdownFile()
        if (!lockedFile) {
          throw new Error('没有找到当前打开的笔记。请先打开要沉淀的笔记再发送。')
        }
        const result = await feedKnowledgeWithResult(this.plugin, lockedFile)
        const reply = result.status === 'saved'
          ? `✅ 已把「${lockedFile.path}」存入 AI霖子知识库的「${result.sectionTitle ?? '对应章节'}」。`
          : result.status === 'cancelled'
            ? `已取消，没有把「${lockedFile.path}」存入 AI霖子知识库。`
            : `⚠️ 没有存入 AI霖子知识库：${result.message ?? '操作未完成'}`
        this.messages.push({ id: uid(), role: 'assistant', parts: [{ type: 'text', text: reply }] })
        await this.persistNow()
        return
      }
      const memoryContent = explicitMemoryContent(text)
      if (memoryContent) {
        const reply = await this.rememberExplicitFact(memoryContent)
        this.messages.push({ id: uid(), role: 'assistant', parts: [{ type: 'text', text: reply }] })
        await this.persistNow()
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
      let localSkillMatch = await this.localSkills.resolve(text, { allowAutomatic: true })
      if (
        localSkillMatch.kind === 'none' &&
        /(?:继续|接着|下一步|上一份|下一份|最新一份|刚才|按照?(?:这个|刚才)|处理(?:这|它|最新)|更新已处理|写入客户档案)/u.test(text)
      ) {
        const previousPath = this.recentLocalSkillPath()
        const continuedSkill = previousPath
          ? await this.localSkills.resolvePath(previousPath)
          : undefined
        if (continuedSkill) localSkillMatch = { kind: 'matched', skill: continuedSkill }
      }
      if (localSkillMatch.kind === 'missing') {
        throw new Error(
          `没有找到你点名的 Skill。可以说「查看我的 Skills」，` +
            `或检查文件是否在 ${this.localSkills.root()}/。`,
        )
      }
      if (localSkillMatch.kind === 'ambiguous') {
        throw new Error(
          `有多个 Skill 同时匹配：${localSkillMatch.skills
            .map((skill) => skill.displayName)
            .join('、')}。请说出完整技能名后重试。`,
        )
      }
      const localSkill =
        localSkillMatch.kind === 'matched' ? localSkillMatch.skill : undefined
      const automaticLocalSkill =
        localSkillMatch.kind === 'matched' && localSkillMatch.automatic === true
      const illustrationEdit = isArticleIllustrationEditIntent(text)
      const singleIllustrationIntent = isSingleArticleIllustrationIntent(text)
      const recentCurrentNotePath = this.recentCurrentNotePath()
      const explicitCurrentNote = isExplicitCurrentNoteIntent(text)
      const continuingCurrentNote =
        !explicitCurrentNote &&
        Boolean(recentCurrentNotePath) &&
        shouldUseCurrentNote(text, true)
      const currentNoteRequested =
        explicitCurrentNote ||
        continuingCurrentNote ||
        singleIllustrationIntent ||
        localSkill?.output === 'update-current-note'
      const noteContext = currentNoteRequested
        ? await this.currentNoteContext(continuingCurrentNote ? recentCurrentNotePath : undefined)
        : undefined
      if (currentNoteRequested && !noteContext) {
        throw new Error('没有读取到目标笔记。请先点开要处理的笔记，再重新发送这条要求。')
      }
      if (localSkill?.output === 'update-current-note' && !noteContext) {
        throw new Error(
          `Skill《${localSkill.name}》需要修改当前笔记。请先打开目标笔记后重试。`,
        )
      }
      if (noteContext) new Notice(`本轮只读取当前笔记：${noteContext.filename}`, 3500)
      if (isFullCurrentNoteReplaceIntent(text)) {
        if (!noteContext) throw new Error('没有读取到要覆盖的当前笔记')
        const replacement = this.lastAssistantContentForReplace()
        if (!replacement) {
          throw new Error('没有找到可用于覆盖的上一条 AI 正文，请先让 AI 生成完整成稿')
        }
        const plan: VaultOrganizePlan = {
          title: `更新当前笔记「${noteContext.filename}」`,
          summary: '用上一条 AI 正文替换发送瞬间锁定的当前笔记正文；原有 frontmatter 会保留。',
          operations: [{
            type: 'replace_note',
            path: noteContext.path,
            content: replacement,
            reason: '用户明确要求用上一条 AI 回复整篇覆盖当前笔记',
          }],
          notes: ['确认前若目标笔记发生变化，插件会停止写入；可通过 Obsidian 文件恢复回滚。'],
        }
        const answer = [
          '已锁定发送时打开的当前笔记，并准备好完整正文预览。确认前不会写入。',
          '<<<VAULT_ORGANIZE_PLAN>>>',
          JSON.stringify(plan),
          '<<<VAULT_ORGANIZE_PLAN_END>>>',
        ].join('\n')
        this.messages.push({
          id: uid(),
          role: 'assistant',
          parts: [{ type: 'text', text: answer }],
          vaultSources: [{
            sourceId: `current-note:${noteContext.path}`,
            filename: noteContext.filename,
            path: noteContext.path,
          }],
          vaultWriteSnapshots: this.plugin.captureVaultWriteSnapshots(plan),
        })
        await this.persistNow()
        return
      }
      const authorizedContent = await this.authorizedContentContext(noteContext?.path)
      // “修改第一张图片/封面”属于配图修改，不得误送进正文局部补丁协议。
      // 图片修改会在 AI 回复下方显示专用入口，先预览候选图再由用户确认替换。
      const singleIllustration = Boolean(noteContext && singleIllustrationIntent)
      const directNoteEdit = Boolean(
        noteContext &&
          !illustrationEdit &&
          !singleIllustration &&
          !automaticLocalSkill &&
          !isStructuredNoteWriteIntent(text) &&
          isNoteEditIntent(text),
      )
      const noteEdit =
        directNoteEdit ||
        Boolean(
          noteContext &&
            !illustrationEdit &&
            !singleIllustration &&
            localSkill?.output === 'update-current-note',
        )
      // v0.7.30：不再由客户端关键词决定“这句话像不像 Vault 请求”。所有适合
      // Luna 判断的纯文字主对话都提供本机工具能力；在模型真正发起 tool call 前，
      // 插件不会扫描、读取或上传任何 Vault 内容。图片理解、当前笔记旧补丁协议、
      // 长文专用任务继续走各自已验证的独立通道。
      const modelDecidesVaultUse =
        !noteEdit &&
        this.authorizedContentPaths.length === 0 &&
        !this.longDocumentPath &&
        !singleIllustration &&
        !illustrationEdit &&
        imageAttachments.length === 0
      const useVaultAgent = modelDecidesVaultUse
      // 没有手动搜索开关，也没有关键词预扫描。普通闲聊会在首轮直接回答；只有
      // Luna 判断本轮确实依赖本地资料时，才进入后续本机工具循环。
      const vaultSearch: {
        context: undefined
        sources: VaultMessageSource[]
      } = { context: undefined, sources: [] }
      const localSkillRequest = localSkill
        ? {
            name: localSkill.name,
            description: localSkill.description,
            output: localSkill.output,
            content: localSkill.content,
            entryChars: localSkill.entryChars,
            entryTruncated: localSkill.entryTruncated,
          }
        : undefined
      if (localSkill) {
        new Notice(
          automaticLocalSkill
            ? `已按你的自动触发规则调用 Skill：${localSkill.name}`
            : `正在调用我的 Skill：${localSkill.name}`,
          4000,
        )
      }
      let answer: string
      let answerSources = [
        ...(noteContext
          ? [{
              sourceId: `current-note:${noteContext.path}`,
              filename: noteContext.filename,
              path: noteContext.path,
            }]
          : []),
        ...vaultSearch.sources,
      ]

      if (useVaultAgent) {
        const agentResult = await this.runVaultAgentLoop({
          question: text,
          noteContext,
          authorizedContent,
          localSkill: localSkillRequest,
          localSkillContext: localSkill ? this.localSkills.context(localSkill) : undefined,
          vaultAccess: true,
          vaultSearch: vaultSearch.context,
          noteEdit,
          noteImageIntent: singleIllustration,
          intent: 'auto',
        })
        answer = agentResult.text
        var localSkillRunIds = agentResult.localSkillRunIds
        answerSources = [
          ...new Map(
            [...answerSources, ...agentResult.sources].map((source) => [source.path, source]),
          ).values(),
        ]
      } else {
        // 普通对话继续优先流式；Vault 工具循环使用非流式 JSON，避免把内部协议闪给用户。
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
      }
      const aiImageRequest = extractChatAiImageRequests(answer)
      if (!answer.startsWith('⚠️')) this.clearChatImageAttachments()
      const imageProtocolWarning = aiImageRequest.invalid
        ? aiImageRequest.requests.length > 0
          ? `部分图片请求超出上限或格式不完整，本次只执行可安全识别的 ${aiImageRequest.requests.length} 张。`
          : '图片生成请求格式不完整，本次没有自动扣积分或生成图片，请重新说一次要求。'
        : ''
      const visibleAnswer = [aiImageRequest.cleanText, imageProtocolWarning]
        .filter(Boolean)
        .join('\n\n') || '我已经理解图片要求，正在准备生成。'
      const pendingVaultPlan = extractVaultOrganizePlan(visibleAnswer).plan
      this.messages.push({
        id: uid(),
        role: 'assistant',
        parts: [{ type: 'text', text: visibleAnswer }],
        vaultSources: answerSources,
        vaultWriteSnapshots: pendingVaultPlan
          ? this.plugin.captureVaultWriteSnapshots(pendingVaultPlan)
          : undefined,
        localSkillRunIds,
        localSkillPath: localSkill?.path,
      })
      await this.persistNow()
      if (aiImageRequest.requests.length > 0 && !answer.startsWith('⚠️')) {
        await this.executeChatAiImageRequests(aiImageRequest.requests, imageAttachments)
      }
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

  private latestAiImageResult(): { message: WireMessage; result: ChatAiImageResult } | null {
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

  private directAiImageEditTarget(
    instruction: string,
  ): { message: WireMessage; result: ChatAiImageResult } | null {
    const requestedIndex = requestedAiImageIndex(instruction)
    if (requestedIndex) {
      let latestBatchId = ''
      for (let index = this.messages.length - 1; index >= 0; index--) {
        const result = this.messages[index].aiImageResult
        if (result?.batchId) {
          latestBatchId = result.batchId
          break
        }
      }
      if (latestBatchId) {
        const message = this.messages.find(
          (candidate) =>
            candidate.aiImageResult?.batchId === latestBatchId &&
            candidate.aiImageResult.batchIndex === requestedIndex,
        )
        if (message?.aiImageResult) return { message, result: message.aiImageResult }
        return null
      }
      return null
    }
    return this.latestAiImageResult()
  }

  private async executeChatAiImageRequests(
    requests: ChatAiImageRequest[],
    userReferences: LocalImageReference[],
  ): Promise<void> {
    if (!(await this.plugin.requireProAccess('AI 生图'))) {
      this.messages.push({
        id: uid(),
        role: 'assistant',
        parts: [{ type: 'text', text: '这轮没有生成图片：AI 生图是 Pro 及以上会员功能。' }],
      })
      await this.persistNow()
      return
    }

    const batchId = uid()
    let styleReference = ''
    let completed = 0
    for (const [index, request] of requests.entries()) {
      const displayIndex = index + 1
      const progress: WireMessage = {
        id: uid(),
        role: 'assistant',
        parts: [{
          type: 'text',
          text: requests.length > 1
            ? `正在生成第 ${displayIndex}/${requests.length} 张：${request.label}…`
            : `正在生成：${request.label}…`,
        }],
      }
      this.messages.push(progress)
      this.renderMessages()

      try {
        const editTarget = request.editPreviousImage
          ? this.directAiImageEditTarget(`上一张图，${request.instruction}`)
          : null
        const editReference = editTarget
          ? await vaultImageToReferenceDataUrl(this.plugin, editTarget.result.savedPath)
          : ''
        const references = [
          ...(editReference ? [editReference] : []),
          ...userReferences.map((reference) => reference.dataUrl),
          ...(!editReference && styleReference ? [styleReference] : []),
        ].slice(0, 3)
        const ratio = editTarget && request.preserveOriginalRatio
          ? editTarget.result.ratio
          : request.ratio
        const generated = await generateAiImage(
          this.plugin,
          request.instruction,
          ratio,
          references,
          undefined,
          Boolean(editReference),
          request.preserveOriginalRatio,
        )
        const savedPath = await saveAiImageToVault(
          this.plugin,
          generated.imageUrl,
          `${request.label}_${request.instruction}`,
        )
        progress.aiImageResult = {
          kind: 'ai-image',
          imageUrl: generated.imageUrl,
          savedPath,
          instruction: request.instruction,
          ratio: generated.ratio,
          batchId,
          batchIndex: displayIndex,
          batchTotal: requests.length,
          label: request.label,
        }
        progress.parts = [{
          type: 'text',
          text: requests.length > 1
            ? `第 ${displayIndex}/${requests.length} 张“${request.label}”已生成并保存。`
            : `“${request.label}”已生成并保存。`,
        }]
        this.activeImageMessageId = progress.id
        completed += 1
        if (!styleReference && requests.length > 1 && !editReference) {
          styleReference = await vaultImageToReferenceDataUrl(this.plugin, savedPath)
        }
      } catch (error) {
        progress.parts = [{
          type: 'text',
          text: `⚠️ ${request.label}生成失败：${error instanceof Error ? error.message : String(error)}`,
        }]
      }
      await this.persistNow()
      this.renderMessages()
    }
    new Notice(
      completed === requests.length
        ? requests.length > 1
          ? `✅ 已完成 ${completed} 张图片生成；可直接说“修改第 2 张……”`
          : '✅ 图片已生成；可继续说怎么修改'
        : `图片任务完成 ${completed}/${requests.length} 张；失败项没有扣图片积分，可稍后重试`,
      7000,
    )
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
   * 模型无关的 Vault 工具循环：服务端只提出只读调用，本机校验并执行；
   * 工具协议与结果不会加入插件消息，也不会写入云端历史。
   */
  private async runVaultAgentLoop(input: {
    question: string
    noteContext: { filename: string; text: string; path: string } | undefined
    authorizedContent:
      | { items: { filename: string; path: string; text: string }[] }
      | undefined
    localSkill:
      | {
          name: string
          description: string
          output: LocalSkillOutput
          content: string
          entryChars: number
          entryTruncated: boolean
        }
      | undefined
    localSkillContext: ActiveLocalSkillContext | undefined
    vaultAccess: boolean
    vaultSearch:
      | {
          query: string
          items: { sourceId: string; filename: string; excerpt: string }[]
        }
      | undefined
    noteEdit: boolean
    noteImageIntent: boolean
    intent: VaultAgentIntent
  }): Promise<{
    text: string
    sources: VaultMessageSource[]
    localSkillRunIds?: string[]
  }> {
    const toolResults: VaultAgentToolResult[] = []
    const sources: VaultMessageSource[] = []
    const localSkillRunIds: string[] = []
    const verifiedWritePaths = new Set<string>()
    let lastText = ''
    let pendingRetryReason: VaultAnswerRetryReason | undefined

    // 删除当前笔记不需要模型搜索：noteContext 已在发送瞬间锁定了准确路径。
    // 本机仍只生成待确认卡，真正移入回收站前还会再次弹窗确认。
    if (
      input.noteContext &&
      isExplicitCurrentNoteTrashRequest(input.question)
    ) {
      const plan: VaultOrganizePlan = {
        title: '删除当前笔记',
        summary: '只移入废纸篓/回收站，不会永久删除。',
        operations: [{
          type: 'trash_note',
          path: input.noteContext.path,
          reason: '用户明确要求删除发送瞬间锁定的当前笔记',
        }],
        notes: ['确认后插件才会移入废纸篓/回收站；需要恢复时请到系统废纸篓或 Obsidian .trash。'],
      }
      return {
        text: [
          `已锁定当前笔记「${input.noteContext.filename}」，下面只生成待确认方案。`,
          '<<<VAULT_ORGANIZE_PLAN>>>',
          JSON.stringify(plan),
          '<<<VAULT_ORGANIZE_PLAN_END>>>',
        ].join('\n'),
        sources,
        localSkillRunIds,
      }
    }

    for (let round = 0; round < VAULT_AGENT_MAX_ROUNDS; round++) {
      new Notice(
        round === 0 && input.intent === 'auto'
          ? 'AI霖子正在理解你的要求，需要时会自行查找知识库…'
          : round === 0
            ? 'AI霖子正在查看 Vault，需要时会继续翻阅相关文件…'
          : `AI霖子正在继续翻阅 Vault（第 ${round + 1}/${VAULT_AGENT_MAX_ROUNDS} 轮）…`,
        2500,
      )
      const vaultAgentRequest = {
        enabled: true as const,
        vaultAccess: input.vaultAccess,
        intent: input.intent,
        round,
        canRequestTools: round < VAULT_AGENT_MAX_ROUNDS - 1,
        retryReason: pendingRetryReason,
        toolResults,
      }
      if (round === 0 && input.intent === 'auto') {
        const streamed = await this.sendStreaming(
          input.noteContext,
          input.authorizedContent,
          input.localSkill,
          input.vaultSearch,
          [],
          input.noteEdit,
          input.noteImageIntent,
          vaultAgentRequest,
        )
        if (streamed.kind === 'bizError') throw new Error(streamed.message)
        lastText = streamed.text
      } else {
        const data = await this.plugin.api('/api/plugin/v1/chat', {
          method: 'POST',
          body: {
            messages: this.messagesForApi(),
            sessionId: this.sessionId,
            stream: false,
            noteContext: input.noteContext,
            authorizedContent: input.authorizedContent,
            vaultSearch: input.vaultSearch,
            noteEdit: input.noteEdit,
            noteImageIntent: input.noteImageIntent,
            localSkill: input.localSkill,
            vaultAgent: vaultAgentRequest,
          },
        })
        lastText = typeof data.text === 'string' ? data.text : ''
      }
      if (!lastText.trim()) {
        if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
          throw new Error('Vault 工具循环连续没有返回可见内容，请重试')
        }
        pendingRetryReason = 'empty_response'
        continue
      }

      const toolRequest = extractVaultToolCalls(lastText)
      if (toolRequest.invalid) throw new Error('AI 返回的 Vault 工具请求格式不安全，请重试')
      if (toolRequest.calls.length === 0) {
        const plan = extractVaultOrganizePlan(lastText)
        if (plan.invalid) {
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            throw new Error('AI 没有在安全轮次内生成可执行的 Vault 方案，请缩小范围后重试')
          }
          pendingRetryReason = 'invalid_plan'
          continue
        }
        if (input.intent === 'answer' && plan.plan) {
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            if (plan.cleanText.trim()) {
              return { text: plan.cleanText.trim(), sources, localSkillRunIds }
            }
            throw new Error('AI 没有在安全轮次内遵守只读要求，请重试')
          }
          pendingRetryReason = 'unexpected_plan'
          continue
        }
        if (
          input.intent === 'auto' &&
          plan.plan &&
          (isVaultMutationExplicitlyDenied(input.question) ||
            (plan.plan.operations.some((operation) => operation.type === 'trash_note') &&
              !isExplicitVaultTrashIntent(input.question)))
        ) {
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            if (plan.cleanText.trim()) {
              return { text: plan.cleanText.trim(), sources, localSkillRunIds }
            }
            throw new Error('AI 没有遵守本轮只读或删除授权边界，请重试')
          }
          pendingRetryReason = 'unexpected_plan'
          continue
        }
        // 明确的 Vault 文件任务至少必须有一条本机工具结果。没有真实结果时，
        // “我现在扫描”或直接猜出的方案都只是口头承诺/幻觉，绝不能结束本轮。
        if (
          input.vaultAccess &&
          toolResults.length === 0 &&
          (input.intent !== 'auto' || Boolean(plan.plan))
        ) {
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            throw new Error('AI 没有实际调用 Vault 工具，已停止这次任务；请重试')
          }
          pendingRetryReason = 'missing_tool_use'
          continue
        }
        const writeOperation = plan.plan?.operations.length === 1
          ? plan.plan.operations[0]
          : undefined
        if (
          writeOperation &&
          (writeOperation.type === 'append_note' ||
            writeOperation.type === 'replace_note' ||
            writeOperation.type === 'update_note') &&
          !verifiedWritePaths.has(writeOperation.path)
        ) {
          // 模型不能仅凭搜索片段就修改现有档案。客户端自动把模型点名的准确目标
          // 做一次只读核验，再把结果交回下一轮；失败时模型只能改为新建或说明找不到。
          const verification = await this.plugin.vaultAgent.executeReadCalls([{
            id: `verify-write-target-${round}`,
            name: 'read_note',
            arguments: { path: writeOperation.path, offset: 0, maxChars: 16_000 },
          }])
          toolResults.push(...verification.results)
          sources.push(...verification.sources)
          if (verification.results[0]?.ok) verifiedWritePaths.add(writeOperation.path)
          pendingRetryReason = undefined
          continue
        }
        if (plan.plan) {
          try {
            await this.plugin.vaultAgent.preflightPlan(plan.plan, input.localSkillContext)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
              throw new Error(`写入方案未通过本机预检：${message}`)
            }
            toolResults.push({
              callId: `preflight-write-plan-${round + 1}`,
              name: 'read_note',
              ok: false,
              output: `写入方案未通过本机预检：${message}。请依据已经读取的目标原文和 Skill 模板重新生成，不要重复原方案。`,
            })
            pendingRetryReason = 'invalid_plan'
            continue
          }
        }
        if (input.intent === 'organize' && !plan.plan) {
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            throw new Error('AI 没有生成可确认的 Vault 整理方案，请缩小范围后重试')
          }
          // Luna 偶尔只说“接下来检查”却不调用工具；下一轮由后端注入协议纠正。
          continue
        }
        if (input.intent === 'answer' || input.intent === 'auto') {
          const retryReason =
            vaultAutoAnswerRetryReason(lastText, toolResults.length > 0) ??
            vaultAnswerRetryReason(input.question, lastText)
          if (retryReason) {
            if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
              throw new Error(
                retryReason === 'deferred_answer'
                  ? 'AI 只承诺稍后处理，没有在安全轮次内给出最终答案，请重试'
                  : retryReason === 'missing_count'
                    ? 'AI 没有在安全轮次内给出明确数量或可信的不足说明，请重试'
                    : retryReason === 'missing_tool_use'
                      ? 'AI 没有实际调用 Vault 工具，请重试'
                      : retryReason === 'empty_response'
                        ? 'AI 没有返回可见内容，请重试'
                        : retryReason === 'unexpected_plan'
                          ? 'AI 没有遵守本轮只读要求，请重试'
                          : 'AI 没有在安全轮次内生成可执行的 Vault 方案，请缩小范围后重试',
              )
            }
            pendingRetryReason = retryReason
            continue
          }
        }
        return { text: lastText, sources, localSkillRunIds }
      }
      if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
        throw new Error('本次翻阅已达到安全轮次上限，请缩小范围后再试')
      }
      const forbidden = toolRequest.calls.find((call) =>
        !isVaultAgentToolAllowed(call.name, {
          vault: input.vaultAccess,
          localSkill: Boolean(input.localSkillContext),
        }),
      )
      if (forbidden) {
        throw new Error(`本轮未授权工具：${forbidden.name}`)
      }
      const namespacedCalls = namespaceVaultToolCalls(toolRequest.calls, round)
      const actionCalls = namespacedCalls.filter((call) => call.name === 'propose_skill_action')
      const readCalls = namespacedCalls.filter((call) => call.name !== 'propose_skill_action')
      if (actionCalls.length > 0 && !input.localSkillContext) {
        throw new Error('本轮没有正在执行的 Skill，不能运行本地动作')
      }
      if (actionCalls.length > 1) {
        throw new Error('每轮最多确认一个本地动作，请让 AI 拆分步骤')
      }
      if (actionCalls.length > 0 && readCalls.length > 0) {
        throw new Error('读取资料与运行本地动作必须分轮进行')
      }
      if (actionCalls.length > 0) {
        const call = actionCalls[0]
        if (!this.plugin.settings.localSkillExecutionEnabled) {
          toolResults.push({
            callId: call.id,
            name: call.name,
            ok: false,
            output: JSON.stringify({
              status: 'disabled',
              message: '用户未在 AI霖子设置中开启“允许我的 Skills 运行程序”',
            }),
          })
          pendingRetryReason = undefined
          continue
        }
        const prepared = this.plugin.localSkillExecutor.prepare(call.arguments)
        if (!prepared.ok) throw new Error(`AI 提出的本地动作不安全：${prepared.error}`)
        const action = prepared.action
        const ok = await confirmLocalSkillAction(
          this.app,
          input.localSkill?.name ?? '我的 Skill',
          action,
        )
        if (!ok) {
          const record = this.plugin.localSkillExecutor.cancelledRecord(
            input.localSkill?.name ?? '我的 Skill',
            action,
          )
          await this.plugin.recordLocalSkillRun(record)
          localSkillRunIds.push(record.id)
          toolResults.push({
            callId: call.id,
            name: call.name,
            ok: false,
            output: JSON.stringify({ status: 'cancelled', message: '用户取消了这一步' }),
          })
          pendingRetryReason = undefined
          continue
        }
        const notice = new Notice(`正在本机执行：${action.label}…`, 0)
        try {
          try {
            const executed = await this.plugin.localSkillExecutor.run(
              input.localSkill?.name ?? '我的 Skill',
              action,
              input.localSkillContext as ActiveLocalSkillContext,
            )
            this.plugin.vaultSearch.clear()
            await this.plugin.recordLocalSkillRun(executed.record)
            localSkillRunIds.push(executed.record.id)
            toolResults.push({
              callId: call.id,
              name: call.name,
              ok: executed.record.status === 'success',
              output: executed.output,
            })
            new Notice(
              executed.record.status === 'success'
                ? `✅ 本地动作完成：${action.label}`
                : `⚠️ 本地动作未完成：${action.label}`,
              6000,
            )
          } catch (error) {
            const failed = this.plugin.localSkillExecutor.failedRecord(
              input.localSkill?.name ?? '我的 Skill',
              action,
            )
            await this.plugin.recordLocalSkillRun(failed)
            localSkillRunIds.push(failed.id)
            const safeError = this.plugin.localSkillExecutor.safeError(
              error,
              input.localSkillContext as ActiveLocalSkillContext,
            )
            toolResults.push({
              callId: call.id,
              name: call.name,
              ok: false,
              output: JSON.stringify({ status: 'failed', message: safeError }),
            })
            new Notice(`本地动作失败：${safeError}`, 9000)
          }
        } finally {
          notice.hide()
        }
        pendingRetryReason = undefined
        continue
      }
      const executed = await this.plugin.vaultAgent.executeCalls(
        readCalls,
        input.localSkillContext,
      )
      for (const call of readCalls) {
        if (call.name !== 'read_note') continue
        const result = executed.results.find((item) => item.callId === call.id)
        if (result?.ok && typeof call.arguments.path === 'string') {
          verifiedWritePaths.add(call.arguments.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
        }
      }
      pendingRetryReason = undefined
      toolResults.push(...executed.results)
      sources.push(...executed.sources)
    }
    return { text: lastText, sources, localSkillRunIds }
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
          entryChars?: number
          entryTruncated?: boolean
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
    vaultAgent?: {
      enabled: true
      vaultAccess: boolean
      intent: VaultAgentIntent
      round: number
      canRequestTools: boolean
      retryReason?: VaultAnswerRetryReason
      toolResults: VaultAgentToolResult[]
    },
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
        vaultAgent,
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
        const imageRequestAt = full.indexOf('<<<AI_LINZI_IMAGE_REQUEST>>>')
        const vaultProtocolAt = vaultAgent ? full.indexOf('<<<') : -1
        const vaultStatus = full.includes('<<<VAULT_ORGANIZE_PLAN>>>')
          ? '正在准备安全确认方案…'
          : '正在本机查找需要的资料…'
        body.setText(
          patchAt >= 0
            ? `${full.slice(0, patchAt).trim()}\n\n正在整理可一键应用的修改…`
            : imageRequestAt >= 0
              ? `${full.slice(0, imageRequestAt).trim()}\n\n正在准备 AI 生图任务…`
              : vaultProtocolAt >= 0
                ? `${full.slice(0, vaultProtocolAt).trim()}\n\n${vaultStatus}`
                : vaultAgent
                  ? full.slice(0, Math.max(0, full.length - 2))
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
   * - v0.7.28 起可新建 SKILL.md + references/scripts/assets 文本文件；
   * - 所有路径均被解析器限制在 Skill 自己的目录内，只新建、不覆盖。
   */
  private renderCreateLocalSkillOffers(row: HTMLElement, blocks: CreateLocalSkillBlock[]) {
    for (const block of blocks) {
      const root = this.localSkills.root()
      const skillRoot = normalizePath(`${root}/${block.name}`)
      const files = block.files.map((file) => ({
        ...file,
        vaultPath: normalizePath(`${skillRoot}/${file.path}`),
      }))
      const filePath = normalizePath(`${skillRoot}/SKILL.md`)
      const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
      card.createDiv({
        text: `🧩 待创建 AI 工作流:${block.name}`,
        cls: 'ai-linzi-create-note-title',
      })
      card.createDiv({ text: block.description, cls: 'ai-linzi-create-note-preview' })
      card.createDiv({
        text: `保存位置:${skillRoot}/（共 ${files.length} 个文件）`,
        cls: 'ai-linzi-create-note-preview',
      })
      for (const file of files) {
        const details = card.createEl('details')
        details.createEl('summary', { text: `查看 ${file.path}` })
        details.createEl('pre', { text: file.content, cls: 'ai-linzi-vault-write-preview' })
      }
      const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
      const createBtn = actionsRow.createEl('button', {
        text: files.length === 1 ? '创建 SKILL.md' : `创建完整 Skill（${files.length} 个文件）`,
      })
      createBtn.onclick = () => {
        createBtn.disabled = true
        void (async () => {
          try {
            if (this.app.vault.getAbstractFileByPath(skillRoot)) {
              throw new Error(`已存在 ${skillRoot}/，为避免混入旧文件请让 AI 换一个 Skill 名称`)
            }
            const conflicts = files.filter((file) => this.app.vault.getAbstractFileByPath(file.vaultPath))
            if (conflicts.length > 0) {
              throw new Error(`已存在 ${conflicts[0].vaultPath}，为避免覆盖请让 AI 换一个 Skill 名称`)
            }
            for (const file of files) {
              const parent = file.vaultPath.split('/').slice(0, -1)
              let current = ''
              for (const segment of parent) {
                current = current ? `${current}/${segment}` : segment
                if (this.app.vault.getAbstractFileByPath(current)) continue
                await this.app.vault.createFolder(current)
              }
            }
            const created = []
            for (const file of files) {
              created.push(await this.app.vault.create(file.vaultPath, file.content))
            }
            const entry = created.find((file) => file.path === filePath) ?? created[0]
            card.empty()
            const done = card.createDiv({ cls: 'ai-linzi-create-note-done' })
            done.createSpan({ text: `✅ 已创建完整 Skill（${created.length} 个文件）:` })
            const link = done.createEl('a', { text: entry.path, href: '#' })
            link.onclick = (event) => {
              event.preventDefault()
              void this.app.workspace.openLinkText(entry.path, '', false)
            }
            new Notice(`已创建到“我的 Skills”：${skillRoot}/`, 6000)
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

  /**
   * 动态知识库目录确认卡：Luna 负责规划，插件只做已展示路径的机械创建与设置绑定。
   * “创建并应用”只修改插件目录设置，不重命名/移动/删除任何已有内容。
   */
  private renderCreateFolderOffer(
    row: HTMLElement,
    folders: string[],
    plan?: VaultStructurePlan,
    isLatestPlan = true,
  ) {
    const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
    card.createDiv({
      text: `📁 待确认：${plan?.title ?? `创建 ${folders.length} 个文件夹`}`,
      cls: 'ai-linzi-create-note-title',
    })
    for (const path of folders) {
      card.createDiv({ text: `· ${path}`, cls: 'ai-linzi-create-note-preview' })
    }
    const bindingEntries = plan
      ? (Object.entries(plan.bindings) as [VaultStructureBindingKey, string][])
      : []
    if (bindingEntries.length > 0) {
      card.createDiv({ text: '同时更新 AI霖子目录设置：', cls: 'ai-linzi-create-note-title' })
      for (const [key, path] of bindingEntries) {
        card.createDiv({
          text: `· ${VAULT_STRUCTURE_BINDING_LABELS[key]} → ${path}`,
          cls: 'ai-linzi-create-note-preview',
        })
      }
    }
    if (!isLatestPlan) {
      card.createDiv({
        text: '此方案已被后续修改替代，请使用下方最新方案。',
        cls: 'ai-linzi-create-note-preview',
      })
      return
    }
    const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
    const applyBtn = bindingEntries.length > 0
      ? actionsRow.createEl('button', { text: '创建并应用到 AI霖子（推荐）' })
      : null
    const createOnlyBtn = actionsRow.createEl('button', { text: '仅创建文件夹' })
    const execute = (applySettings: boolean) => {
      if (applyBtn) applyBtn.disabled = true
      createOnlyBtn.disabled = true
      void (async () => {
        let created = 0
        let skipped = 0
        const previousSettings = {
          cockpitInboxFolder: this.plugin.settings.cockpitInboxFolder,
          cockpitSourcesFolder: this.plugin.settings.cockpitSourcesFolder,
          cockpitKnowledgeFolder: this.plugin.settings.cockpitKnowledgeFolder,
          cockpitOutputFolder: this.plugin.settings.cockpitOutputFolder,
          localSkillsFolder: this.plugin.settings.localSkillsFolder,
        }
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
          if (applySettings && plan) {
            Object.assign(this.plugin.settings, vaultStructureSettingPatch(plan))
            try {
              await this.plugin.saveSettings()
            } catch (error) {
              Object.assign(this.plugin.settings, previousSettings)
              throw error
            }
          }
          card.empty()
          card.createDiv({
            cls: 'ai-linzi-create-note-done',
            text:
              `✅ 已创建 ${created} 个文件夹${skipped > 0 ? `（${skipped} 个已存在，跳过）` : ''}` +
              (applySettings ? '，并已更新驾驶舱与“我的 Skills”目录设置' : ''),
          })
          new Notice(
            `已创建 ${created} 个文件夹${skipped > 0 ? `，${skipped} 个已存在` : ''}` +
              (applySettings ? '，目录设置已更新' : ''),
          )
        } catch (e) {
          if (applyBtn) applyBtn.disabled = false
          createOnlyBtn.disabled = false
          new Notice(`创建失败：${(e as Error).message}。目录设置未更改。`, 6000)
        }
      })()
    }
    if (applyBtn) applyBtn.onclick = () => execute(true)
    createOnlyBtn.onclick = () => execute(false)
  }

  /** Vault 方案：预览 → 二次确认 → 本机执行；永久删除禁止，移动可撤销。 */
  private renderVaultPlanOffer(
    row: HTMLElement,
    plan: VaultOrganizePlan,
    message: WireMessage,
  ): void {
    const card = row.createDiv({ cls: 'ai-linzi-create-note-card ai-linzi-vault-plan-card' })
    const trashOperation = plan.operations.length === 1 && plan.operations[0].type === 'trash_note'
      ? plan.operations[0]
      : null
    const onlyOperation = plan.operations.length === 1 ? plan.operations[0] : null
    const noteWriteOperation = onlyOperation &&
      (onlyOperation.type === 'create_note' ||
        onlyOperation.type === 'append_note' ||
        onlyOperation.type === 'replace_note' ||
        onlyOperation.type === 'update_note')
      ? onlyOperation
      : null
    card.createDiv({
      text: `${trashOperation ? '🗑️' : noteWriteOperation ? '📝' : '🗂️'} 待确认：${plan.title}`,
      cls: 'ai-linzi-create-note-title',
    })
    if (plan.summary) {
      card.createDiv({ text: plan.summary, cls: 'ai-linzi-create-note-preview' })
    }
    const operations = card.createEl('ol', { cls: 'ai-linzi-vault-plan-operations' })
    for (const operation of plan.operations) {
      const item = operations.createEl('li')
      item.createDiv({ text: operationLabel(operation) })
      if (operation.reason) item.createEl('small', { text: operation.reason })
      if (
        operation.type === 'create_note' ||
        operation.type === 'append_note' ||
        operation.type === 'replace_note'
      ) {
        const details = item.createEl('details')
        details.createEl('summary', {
          text: operation.type === 'append_note' ? '查看待追加全文' : '查看待写入全文',
        })
        details.createEl('pre', {
          text: operation.content,
          cls: 'ai-linzi-vault-write-preview',
        })
      } else if (operation.type === 'update_note') {
        const details = item.createEl('details')
        const replacementCount = operation.replacements?.length ?? 0
        details.createEl('summary', {
          text: operation.frontmatter
            ? `查看 YAML 属性${replacementCount > 0 ? `和 ${replacementCount} 处正文` : ''}修改`
            : `查看 ${replacementCount} 处局部修改`,
        })
        if (operation.frontmatter) {
          const block = details.createDiv({ cls: 'ai-linzi-vault-write-preview' })
          block.createEl('strong', { text: 'YAML 属性' })
          block.createEl('pre', {
            text: `原文：\n${operation.frontmatter.old}\n\n改为：\n${operation.frontmatter.new}`,
          })
        }
        for (const [index, replacement] of (operation.replacements ?? []).entries()) {
          const block = details.createDiv({ cls: 'ai-linzi-vault-write-preview' })
          block.createEl('strong', { text: `修改 ${index + 1}` })
          block.createEl('pre', { text: `原文：\n${replacement.old}\n\n改为：\n${replacement.new}` })
        }
      }
    }
    for (const note of plan.notes) {
      card.createDiv({ text: `注意：${note}`, cls: 'ai-linzi-vault-plan-note' })
    }

    // getVaultActionRecord(undefined) 的历史语义是“最近一条可撤销记录”，只供全局
    // 撤销命令使用。新方案消息没有 vaultActionId 时绝不能借用旧记录，否则会把
    // 尚未执行的确认卡误显示成已执行，并隐藏真正的确认按钮。
    const record = message.vaultActionId
      ? this.plugin.getVaultActionRecord(message.vaultActionId)
      : undefined
    if (record?.undoneAt) {
      card.createDiv({ text: '↩️ 本次移动/重命名已经撤销。', cls: 'ai-linzi-create-note-done' })
      return
    }
    const actions = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
    if (record) {
      const trashedCount = record.trashedNotes?.length ?? 0
      const createdNote = record.createdNotes?.[0]
      const updatedNote = record.updatedNotes?.[0]
      actions.createSpan({
        text: trashedCount > 0
          ? `✅ 已移入回收站：${record.trashedNotes?.[0]}`
          : createdNote
            ? `✅ 已新建笔记：${createdNote}`
            : updatedNote
              ? `✅ 已更新笔记：${updatedNote}`
          : `✅ 已执行：移动/重命名 ${record.moves.length} 项，新建文件夹 ${record.createdFolders.length} 个`,
        cls: 'ai-linzi-create-note-done',
      })
      if (record.moves.length > 0) {
        const undoBtn = actions.createEl('button', { text: '撤销本次移动/重命名' })
        undoBtn.onclick = () => {
          undoBtn.disabled = true
          void (async () => {
            try {
              const ok = await confirmAction(this.app, {
                title: '撤销这次 Vault 整理',
                message: `将把 ${record.moves.length} 项移动/重命名恢复到原位置。新建的空文件夹会保留，不删除任何文件。`,
                confirmLabel: '确认撤销',
              })
              if (!ok) {
                undoBtn.disabled = false
                return
              }
              await this.plugin.undoVaultAction(record.id)
              await this.persistNow()
              this.renderMessages()
              new Notice(`✅ 已撤销「${record.planTitle}」`)
            } catch (error) {
              undoBtn.disabled = false
              new Notice(`撤销失败：${(error as Error).message}`, 8000)
            }
          })()
        }
      }
      if (message.customerCrmSynced) {
        actions.createSpan({
          text: `☁️ 已同步 AI霖子 CRM：${message.customerCrmSynced.label}`,
          cls: 'ai-linzi-create-note-done',
        })
      } else if (message.customerCrmSyncPath) {
        const syncBtn = actions.createEl('button', { text: '查看 CRM 同步差异' })
        syncBtn.onclick = () => {
          syncBtn.disabled = true
          void (async () => {
            try {
              const profile = await readLocalCustomerProfile(this.app, message.customerCrmSyncPath ?? '')
              if (!profile) throw new Error('这篇笔记已不再符合客户档案格式，请先补充客户称呼等基础字段')
              openCustomerCrmSyncModal(this.app, this.plugin, profile, async (customer) => {
                message.customerCrmSynced = {
                  id: customer.id,
                  label: `${customer.customerCode || `${customer.seq}号`} · ${customer.name}`,
                  syncedAt: Date.now(),
                }
                await this.persistNow()
                this.renderMessages()
              })
            } catch (error) {
              new Notice(`无法准备 CRM 同步：${(error as Error).message}`, 8000)
            } finally {
              syncBtn.disabled = false
            }
          })()
        }
      }
      return
    }

    const executeBtn = actions.createEl('button', {
      text: trashOperation
        ? '移入回收站'
        : noteWriteOperation
          ? noteWriteOperation.type === 'create_note' ? '确认新建笔记' : '确认写入笔记'
          : `确认执行 ${plan.operations.length} 项`,
      cls: 'mod-cta',
    })
    executeBtn.onclick = () => {
      executeBtn.disabled = true
      void (async () => {
        try {
          const ok = await confirmAction(this.app, trashOperation
            ? {
                title: '再次确认移入回收站',
                message:
                  `即将把「${trashOperation.path}」移入废纸篓/回收站。` +
                  '插件不会永久删除；需要恢复时请到系统废纸篓/回收站（或 Obsidian .trash）操作。',
                confirmLabel: '确认移入回收站',
              }
            : noteWriteOperation
              ? {
                  title: noteWriteOperation.type === 'create_note' ? '再次确认新建笔记' : '再次确认写入笔记',
                  message:
                    `目标路径：${noteWriteOperation.path}\n\n` +
                    (noteWriteOperation.type === 'create_note'
                      ? '只会新建这一篇 Markdown；缺少的父目录会同时创建。如果目标已存在就停止，绝不覆盖。'
                      : noteWriteOperation.type === 'update_note' && noteWriteOperation.frontmatter
                        ? '只会更新这一篇 Markdown；YAML 原文、格式与目标版本已在本机预检，确认前发生变化就停止。'
                        : '只会更新这一篇 Markdown；如果它在方案生成后有变化就停止。整篇替换会保留 frontmatter。') +
                    '\n需要回滚时可使用 Obsidian 撤销或“文件恢复”。',
                  confirmLabel: noteWriteOperation.type === 'create_note' ? '确认新建' : '确认写入',
                }
              : {
                title: '执行 Vault 整理方案',
                message:
                  `即将执行 ${plan.operations.length} 项操作。插件只会新建文件夹、移动或重命名；` +
                  '不会覆盖同名文件。移动/重命名会记录在本机，可撤销。',
                confirmLabel: '确认执行',
              })
          if (!ok) {
            executeBtn.disabled = false
            return
          }
          const applied = await this.plugin.applyVaultPlan(plan, message.vaultWriteSnapshots)
          message.vaultActionId = applied.id
          const writtenPath = applied.createdNotes?.[0] ?? applied.updatedNotes?.[0]
          if (writtenPath) {
            const profile = await readLocalCustomerProfile(this.app, writtenPath)
            if (profile) message.customerCrmSyncPath = writtenPath
          }
          await this.persistNow()
          this.renderMessages()
          new Notice(
            (applied.trashedNotes?.length ?? 0) > 0
              ? `✅ 已把「${applied.trashedNotes?.[0]}」移入回收站`
              : (applied.createdNotes?.length ?? 0) > 0
                ? `✅ 已新建笔记「${applied.createdNotes?.[0]}」`
                : (applied.updatedNotes?.length ?? 0) > 0
                  ? `✅ 已更新笔记「${applied.updatedNotes?.[0]}」`
              : `✅ 已完成「${plan.title}」：移动/重命名 ${applied.moves.length} 项，新建文件夹 ${applied.createdFolders.length} 个`,
            7000,
          )
        } catch (error) {
          executeBtn.disabled = false
          new Notice(`执行失败：${(error as Error).message}`, 9000)
        }
      })()
    }
  }

  private renderLocalSkillRunOffer(row: HTMLElement, message: WireMessage): void {
    const records = (message.localSkillRunIds ?? [])
      .map((id) => this.plugin.getLocalSkillRunRecord(id))
      .filter((record): record is LocalSkillRunRecord => Boolean(record))
    if (records.length === 0) return
    const card = row.createDiv({ cls: 'ai-linzi-local-run-card' })
    card.createDiv({ text: '本机执行记录', cls: 'ai-linzi-create-note-title' })
    for (const record of records) {
      const item = card.createDiv({ cls: 'ai-linzi-local-run-item' })
      const status = record.status === 'success'
        ? '✅ 已完成'
        : record.status === 'cancelled'
          ? '已取消'
          : record.status === 'timed_out'
            ? '⏱️ 已超时'
            : '⚠️ 执行失败'
      item.createDiv({
        text: `${status} · ${record.label} · ${(record.durationMs / 1000).toFixed(1)} 秒`,
      })
      if (record.createdOutputs.length > 0) {
        const outputs = item.createDiv({ cls: 'ai-linzi-local-run-outputs' })
        outputs.createSpan({ text: '生成：' })
        for (const output of record.createdOutputs) {
          const open = outputs.createEl('button', { text: output.path })
          open.onclick = () => void this.app.workspace.openLinkText(output.path, '', false)
        }
      }
      if (record.createdOutputs.length > 0 && !record.undoneAt) {
        const undo = item.createEl('button', { text: '移到系统废纸篓' })
        undo.onclick = () => {
          undo.disabled = true
          void (async () => {
            try {
              const ok = await confirmAction(this.app, {
                title: '撤销这次生成文件',
                message:
                  `将把本次新生成的 ${record.createdOutputs.length} 个文件移到系统废纸篓/回收站。` +
                  '如果文件生成后被修改过，插件会停止撤销，避免误删。',
                confirmLabel: '移到废纸篓',
                destructive: true,
              })
              if (!ok) {
                undo.disabled = false
                return
              }
              await this.plugin.undoLocalSkillRun(record.id)
              await this.persistNow()
              this.renderMessages()
              new Notice('✅ 本次生成文件已移到系统废纸篓，可恢复')
            } catch (error) {
              undo.disabled = false
              new Notice(`撤销失败：${(error as Error).message}`, 9000)
            }
          })()
        }
      } else if (record.undoneAt) {
        item.createDiv({ text: '↩️ 生成文件已移到系统废纸篓', cls: 'ai-linzi-create-note-done' })
      }
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
        ul.createEl('li', { text: '直接说“总结当前笔记”或“润色这篇文章”,我会只读取当前这一篇' })
        ul.createEl('li', { text: '点「调用技能」→ 选题雷达,把素材笔记变成 10 个选题' })
        ul.createEl('li', { text: '直接说“把当前笔记存入 AI霖子知识库”，沉淀长期定位和方法论' })
      }
      const link = body.createDiv({ cls: 'ai-linzi-empty-link' })
      link.createSpan({ text: '进入网页版 ' })
      link.createEl('a', { text: 'chat.alinalinzi.com', href: 'https://chat.alinalinzi.com' })
      link.createSpan({ text: ' 可注册账号、查看和充值积分' })
      return
    }
    let latestFolderOfferIndex = -1
    for (let index = 0; index < this.messages.length; index++) {
      const candidate = this.messages[index]
      if (candidate.role !== 'assistant') continue
      const candidateText = candidate.parts.map((part) => part.text).join('')
      const candidateVaultPlan = extractVaultOrganizePlan(candidateText)
      const candidateSkill = extractPluginSkillSuggestions(candidateVaultPlan.cleanText, '')
      const candidateLocalSkill = extractCreateLocalSkillBlocks(candidateSkill.cleanText)
      const candidateNote = extractCreateNoteBlocks(candidateLocalSkill.cleanText)
      const candidateFolders = extractCreateFolderBlocks(candidateNote.cleanText)
      if (candidateFolders.folders.length > 0) latestFolderOfferIndex = index
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
        const vaultPlanResult = extractVaultOrganizePlan(text)
        const skillResult = extractPluginSkillSuggestions(vaultPlanResult.cleanText, previousUserText)
        // 对话创建本地 Skill(v0.6.47)：先剥整个 Skill 块，避免其中的协议示例
        // 被后续“新建笔记/文件夹”解析器误当成独立写入动作。
        const localSkillCreateResult = extractCreateLocalSkillBlocks(skillResult.cleanText)
        // 对话直接创建笔记(v0.6.34):先剥标记块,确认卡在正文渲染后追加
        const createResult = extractCreateNoteBlocks(localSkillCreateResult.cleanText)
        const folderResult = extractCreateFolderBlocks(createResult.cleanText)
        const cleanText = folderResult.cleanText
        const patch = parseNotePatch(cleanText)
        const illustrationEdit = isArticleIllustrationEditIntent(previousUserText)
        void MarkdownRenderer.render(this.app, patch?.displayText ?? cleanText, body, '', this)
        if ((m.vaultSources?.length ?? 0) > 0) this.renderVaultSources(row, m.vaultSources ?? [])
        if ((m.localSkillRunIds?.length ?? 0) > 0) this.renderLocalSkillRunOffer(row, m)
        if (localSkillCreateResult.blocks.length > 0) {
          this.renderCreateLocalSkillOffers(row, localSkillCreateResult.blocks)
        }
        if (createResult.blocks.length > 0) this.renderCreateNoteOffers(row, createResult.blocks)
        if (folderResult.invalidStructurePlan) {
          const invalidCard = row.createDiv({ cls: 'ai-linzi-create-note-card' })
          invalidCard.createDiv({
            text: '⚠️ 目录方案格式不完整，本次没有创建或修改任何内容。请让 AI霖子重新生成完整方案。',
            cls: 'ai-linzi-create-note-preview',
          })
        }
        if (folderResult.plans.length > 0) {
          for (const plan of folderResult.plans) {
            this.renderCreateFolderOffer(row, plan.folders, plan, mi === latestFolderOfferIndex)
          }
        } else if (folderResult.folders.length > 0) {
          this.renderCreateFolderOffer(row, folderResult.folders, undefined, mi === latestFolderOfferIndex)
        }
        if (vaultPlanResult.plan) {
          this.renderVaultPlanOffer(row, vaultPlanResult.plan, m)
        }
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
        // 只显示本轮真正需要的动作。普通回复不再固定挂“存为笔记/更新当前笔记”；
        // 用户用自然语言提出写入要求后，插件会显示锁定目标的专用确认卡。
        if (!vaultPlanResult.plan && text.trim().length > 0 && !text.startsWith('⚠️')) {
          const hasMessageActions = Boolean(patch) || skillResult.suggestions.length > 0
          const bar = hasMessageActions
            ? row.createDiv({ cls: 'ai-linzi-msg-actions' })
            : null
          if (patch) {
            const applyBtn = bar?.createEl('button', {
              text: `✅ 一键应用 ${patch.operations.length} 处修改`,
              cls: 'ai-linzi-apply-patch',
            })
            if (applyBtn) applyBtn.onclick = () => void this.applyPatchToCurrentNote(patch, applyBtn)
          }
          for (const suggestion of skillResult.suggestions) {
            const skillBtn = bar?.createEl('button', {
              text:
                suggestion.actionId === 'illustration' && isArticleIllustrationEditIntent(previousUserText)
                  ? '🖼️ 修改当前文章配图'
                  : `⚡ ${suggestion.label}`,
              cls: 'ai-linzi-suggested-skill',
            })
            if (skillBtn) skillBtn.onclick = () => void this.runSuggestedSkill(suggestion, previousUserText)
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
      const active = this.plugin.rememberCurrentMarkdownFile()
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
    const batchLabel = result.batchIndex && result.batchTotal
      ? `第 ${result.batchIndex}/${result.batchTotal} 张${result.label ? ` · ${result.label}` : ''}`
      : result.label ?? ''
    meta.createEl('strong', {
      text: [batchLabel, result.ratio, '已自动保存'].filter(Boolean).join(' · '),
    })
    meta.createSpan({ text: result.savedPath })
    if (result.articleCandidate) {
      meta.createSpan({ text: `建议放在「${result.articleCandidate.anchor}」之后` })
    }
    const actions = card.createDiv({ cls: 'ai-linzi-chat-image-actions' })
    const continueBtn = actions.createEl('button', { text: '继续修改这张' })
    continueBtn.onclick = () => {
      this.activeImageMessageId = message.id
      if (!this.inputEl.value.trim()) this.inputEl.value = '修改这张图：'
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
          result.insertedNotePath = this.plugin.rememberCurrentMarkdownFile()?.path || '已插入'
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
    const file = this.plugin.rememberCurrentMarkdownFile()
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
    cockpitFolderSetting('收件箱 Inbox 文件夹', '随手记、待整理的内容先进这里;驾驶舱会提醒积压', 'cockpitInboxFolder', '000_Inbox')
    cockpitFolderSetting('原始素材 Raw 文件夹', '录音转写、聊天记录、灵感等原始输入', 'cockpitSourcesFolder', '01_Raw')
    cockpitFolderSetting('知识库 Wiki 文件夹', '整理后的方法论、案例、洞察', 'cockpitKnowledgeFolder', '02_Wiki')
    cockpitFolderSetting('对外输出 Output 文件夹', '发出去的文章、笔记、交付物', 'cockpitOutputFolder', '04_Output')
    new Setting(containerEl)
      .setName('我的 Skills 文件夹')
      .setDesc('存放你自己创建、可被 AI霖子调用的 Skills；支持「技能名.md」或标准「技能名/SKILL.md」，也可以直接在主对话中让 AI 创建')
      .addText((text) =>
        text
          .setPlaceholder('05_System/Skills')
          .setValue(this.plugin.settings.localSkillsFolder)
          .onChange(async (value) => {
            this.plugin.settings.localSkillsFolder = normalizeLocalSkillRoot(value)
            this.plugin.vaultSearch.clear()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('允许“我的 Skills”运行程序')
      .setDesc('默认关闭。开启后，Skill 可以申请运行 Node.js、Python、FFmpeg 或 FFprobe；每一步仍会展示程序、参数、联网声明和输出文件，由你单独确认。只应运行你信任的 Skill，脚本本身可能读取或修改电脑上的数据。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.localSkillExecutionEnabled)
          .onChange(async (value) => {
            if (value) {
              try {
                const capabilities = await this.plugin.getCapabilities(true)
                const execution = capabilities.features?.chat?.localSkills?.localExecution
                const minVersion = execution?.minPluginVersion
                if (
                  execution?.status !== 'available' ||
                  (minVersion && compareVersions(this.plugin.manifest.version, minVersion) < 0)
                ) {
                  toggle.setValue(false)
                  new Notice(
                    minVersion
                      ? `“我的 Skills”运行程序需要插件 ${minVersion} 或更高版本，请先更新插件`
                      : '当前 AI霖子服务还未开放“我的 Skills”程序运行，请稍后更新后再试',
                    8000,
                  )
                  return
                }
              } catch (error) {
                toggle.setValue(false)
                new Notice(`暂时无法确认“我的 Skills”运行能力：${(error as Error).message}`, 8000)
                return
              }
            }
            this.plugin.settings.localSkillExecutionEnabled = value
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

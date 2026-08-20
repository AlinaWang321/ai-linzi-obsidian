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
  FileSystemAdapter,
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
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
} from 'obsidian'
import { copyWechatFormatted, sendToWechatDraft } from './publish'
import { WECHAT_THEMES, getWechatTheme } from './wechat-themes'
import { XHS_CARD_STYLES, getXhsCardStyle } from './xhs-card-styles'
import { chooseXhsAvatarFile, saveXhsAvatarToVault } from './xhs-style-picker'
import { VaultImageBrowserModal } from './vault-image-browser'
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
  imageMediaTypeFromDataUrl,
  fileToReferenceDataUrl,
} from './actions'
import { ActivityFeed } from './activity-feed-core'
import { dropSummary, planDroppedFiles, type DropCandidate } from './chat-drop-core'
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
  formatCreateLocalSkillBlock,
  type CreateLocalSkillBlock,
} from './create-local-skill'
import { createLocalSkillBundleAtomically } from './create-local-skill-vault'
import { exportSkillBundle, SkillStudioModal } from './skill-studio'
import {
  isExplicitLocalSkillCreationIntent,
  skillBlockManifest,
} from './skill-studio-core'
import {
  extractVaultQuestion,
  formatVaultQuestionMarker,
  type PendingVaultQuestion,
} from './vault-question-core'
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
import { extractXlsxText, LOCAL_SEARCH_FILE_LIMITS } from './local-document-text'
import { LocalVaultSearch } from './vault-search'
import { LocalVaultAgent, type VaultActionRecord } from './vault-agent'
import {
  VAULT_AGENT_MAX_CALLS_PER_ROUND,
  VAULT_AGENT_MAX_ROUNDS,
  advanceVaultTask,
  appendToolResultsWithinBudget,
  buildVaultExecuteFailureToolResult,
  detectVaultAgentIntent,
  extractVaultOrganizePlan,
  extractVaultToolCalls,
  isCloudToolsTurnRequest,
  isVaultNativeTurnRequest,
  isExplicitCurrentNoteTrashRequest,
  isExplicitVaultTrashIntent,
  isStructuredNoteWriteIntent,
  isVaultMutationExplicitlyDenied,
  isVaultAgentToolAllowed,
  isVaultTaskContinuation,
  isVaultTaskExpired,
  namespaceVaultToolCalls,
  operationLabel,
  upgradeVaultIntent,
  vaultAutoAnswerRetryReason,
  vaultAnswerRetryReason,
  vaultWriteFlowRetryReason,
  type PendingVaultTask,
  type VaultAnswerRetryReason,
  type VaultAgentToolCall,
  type VaultAgentToolResult,
  type VaultAgentIntent,
  type VaultOrganizePlan,
  type VaultTaskEvent,
  type VaultWriteSnapshot,
} from './vault-agent-core'
import {
  artifactFormatLabel,
  estimateArtifactUnits,
  resolveArtifactPath,
} from './artifact-renderer-core'
import {
  LEGACY_LOCAL_SKILL_ROOT,
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
import type { LocalSkillExecutor, LocalSkillRunRecord } from './local-skill-executor'
import {
  localSkillActionSummary,
  type LocalSkillActionProposal,
} from './local-skill-execution-core'
import {
  isExplicitCurrentNoteIntent,
  selectCurrentOpenMarkdownPath,
  shouldUseCurrentNote,
} from './current-note-intent'
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
  {
    id: 'customer-consultation-brief',
    name: '客户咨询简报:选择逐字稿 → 客户版 PNG 长图',
    fn: async (p) => {
      const { runCustomerConsultationBrief } = await import('./customer-consultation-brief')
      return runCustomerConsultationBrief(p)
    },
  },
  { id: 'sales-review', name: '销售复盘:选择逐字稿 → 销售诊断', fn: runSalesReview },
  {
    id: 'deck-builder',
    name: '课件PPT:选择文档 → 网页课件(放映·⌘P存PDF)',
    fn: async (p) => {
      const { runDeckBuilder } = await import('./deck-builder')
      return runDeckBuilder(p)
    },
  },
  { id: 'feed-knowledge', name: '存入 AI霖子知识库:当前笔记', fn: feedKnowledge },
]

// ── 设置 ──────────────────────────────────────────────

interface AiLinziSettings {
  serverUrl: string
  /** SecretStorage 的内部条目名，仅用于兼容旧设置；不得在学员界面中暴露 */
  tokenSecretId: string
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
  /** 公众号排版主题(一键复制/发草稿箱共用;选择卡确认时记住) */
  wechatThemeId: string
  /** 小红书卡片风格(卡片技能/多平台分发共用;选择卡确认时记住) */
  xhsCardStyleId: string
  /** X 推文风卡片的昵称与 @账号(不含@);头像为 Vault 内图片路径,可留空 */
  xhsCardNickname: string
  xhsCardHandle: string
  xhsCardAvatarPath: string
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
  /** 课件PPT:讲者名/品牌名/主题色(跑一次后自动记住) */
  deckPresenter: string
  deckBrand: string
  deckTheme: string
}

const DEFAULT_SETTINGS: AiLinziSettings = {
  serverUrl: 'https://chat.alinalinzi.com',
  tokenSecretId: '',
  outputFolder: 'AI霖子输出',
  illustrationCharacterReferencePath: '',
  defaultNiche: '',
  wechatAppId: '',
  wechatAppSecretId: '',
  brandFooter: true,
  wechatThemeId: 'classic-blue',
  xhsCardStyleId: 'classic',
  xhsCardNickname: '',
  xhsCardHandle: '',
  xhsCardAvatarPath: '',
  cockpitInboxFolder: '000_Inbox',
  cockpitSourcesFolder: '01_Raw',
  cockpitKnowledgeFolder: '02_Wiki',
  cockpitOutputFolder: '04_Output',
  localSkillsFolder: '05_System/Skills',
  localSkillExecutionEnabled: false,
  cockpitJudgmentDate: '',
  cockpitJudgmentText: '',
  cockpitPartnerSteps: [],
  deckPresenter: '',
  deckBrand: '',
  deckTheme: '深蓝',
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
  /** v0.6.19 短暂存在过的工作流目录（当日回滚）；不列进来会永久滞留在老用户 data.json。 */
  workflowFolder?: string
  /** v0.7.x 早期的搜索默认开关；已无任何读取点，停止写盘。 */
  vaultSearchDefault?: boolean
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
  /** 调用技能的进度状态条（锁定/生成中/完成/失败）；只存本机历史，不发给主对话 API。 */
  localSkillStatus?: boolean
  /** 只保留用户本轮上传的图片名称；图片数据不写本机或云端历史。 */
  imageAttachmentNames?: string[]
  /** 本地整理方案的执行日志 ID；方案正文仍在 parts 的本机副本中。 */
  vaultActionId?: string
  /** 确认执行整理方案失败的本机错误；只存本机历史，用于卡片提示与下一轮纠错。 */
  vaultExecuteError?: { message: string; at: number }
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
  /** 原生 Vault 引擎的结构化澄清问题；只保存在插件本机，不进入云端普通消息。 */
  vaultQuestion?: PendingVaultQuestion
  /** Skill Studio 创建完成后的课堂试运行输入；只用于本机按钮。 */
  skillStudioTestInput?: string
  /** Skill Creator 正在等待用户补充；下一轮继续走专用创建路由，不进入 Vault agent。 */
  skillCreatorPending?: boolean
  /** 该回复由 Skill Creator/Studio 生成；本机必须验证版本、权限与引用闭环后才可安装。 */
  skillCreatorResult?: boolean
  /** 对话确认后已落盘的 Skill；只保存本机相对路径。 */
  createdLocalSkill?: { root: string; entry: string }
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

/** 确认卡里提示整夹删除的体量；只数文件，不含子文件夹本身。 */
function countFilesInside(folder: TFolder): number {
  let count = 0
  const stack: TFolder[] = [folder]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    for (const child of current.children) {
      if (child instanceof TFolder) stack.push(child)
      else count += 1
    }
  }
  return count
}

function uid(): string {
  return window.activeWindow.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStoredVaultActionRecord(value: unknown): value is VaultActionRecord {
  if (!isUnknownRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.planTitle === 'string' &&
    Array.isArray(value.moves) &&
    Array.isArray(value.createdFolders)
}

function isStoredLocalSkillRunRecord(value: unknown): value is LocalSkillRunRecord {
  if (!isUnknownRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.skillName === 'string' &&
    typeof value.label === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.durationMs === 'number' &&
    Array.isArray(value.declaredOutputs) &&
    Array.isArray(value.createdOutputs)
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
    () => this.settings.outputFolder,
  )
  private localSkillExecutorPromise: Promise<LocalSkillExecutor> | null = null
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
  /**
   * 旧默认目录孤儿检查(0.7.53)：早期版本"我的 Skills"默认目录是 system/skills，
   * 默认值改为 05_System/Skills 后，旧目录里创建的技能被静默遗弃、列表里看不到
   * (Alina 主库 d5-local-skill-test 实锤)。启动时旧目录仍有技能且不等于当前
   * 设置 → 提醒用户迁移；只提醒不代动文件。
   */
  private warnOrphanLocalSkills() {
    // 启动性提示绝不允许影响插件加载：任何异常静默吞掉。
    try {
      const configured = normalizeLocalSkillRoot(this.settings.localSkillsFolder)
      if (configured === LEGACY_LOCAL_SKILL_ROOT) return
      const legacy = this.app.vault.getAbstractFileByPath(LEGACY_LOCAL_SKILL_ROOT)
      if (!(legacy instanceof TFolder)) return
      let count = 0
      const stack: TFolder[] = [legacy]
      while (stack.length > 0) {
        const folder = stack.pop() as TFolder
        for (const child of folder.children) {
          if (child instanceof TFolder) stack.push(child)
          else if (child.name.toLowerCase() === 'skill.md') count += 1
        }
      }
      if (count === 0) return
      new Notice(
        `发现旧目录 ${LEGACY_LOCAL_SKILL_ROOT}/ 里还有 ${count} 个技能，当前“我的 Skills”目录是 ${configured}/，` +
          '旧技能不会被读取。把技能文件夹整体移动过去即可继续使用（可直接拖拽，或让 AI霖子帮你移动）。',
        12_000,
      )
    } catch {
      // 静默：孤儿提醒是锦上添花，不能变成启动风险。
    }
  }

  async onload() {
    await this.loadSettings()

    // 插件重载时 active leaf 可能正好是右侧对话面板；先从仍打开的 Markdown
    // 标签页恢复“用户刚才在看的笔记”，避免勾选成功却拿不到正文。
    this.rememberCurrentMarkdownFile()
    this.app.workspace.onLayoutReady(() => {
      this.rememberCurrentMarkdownFile()
      this.warnOrphanLocalSkills()
    })

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
      ? vaultActionHistory.filter(isStoredVaultActionRecord).slice(0, 20)
      : []
    this.localSkillRunHistory = Array.isArray(localSkillRunHistory)
      ? localSkillRunHistory.filter(isStoredLocalSkillRunRecord).slice(0, 50)
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
    // ⚠️ Obsidian 1.13 起 secretStorage 对不合规条目名会抛错（写入必抛，读取
    // 目前不抛但不担保，旧版插件的自定义条目名可能是中文/大写）；整段迁移
    // 逐条兜底，绝不能让存储异常炸掉 loadSettings（2026-08-18 AppSecret 事故）。
    const safeGetSecret = (id: string): string => {
      try {
        return this.app.secretStorage.getSecret(id)?.trim() ?? ''
      } catch {
        return ''
      }
    }
    const safeSetSecret = (id: string, value: string): void => {
      try {
        this.app.secretStorage.setSecret(id, value)
      } catch (error) {
        console.error('[ai-linzi] secret migration write failed:', error)
      }
    }
    const previousTokenId = this.settings.tokenSecretId.trim()
    const fixedToken = safeGetSecret(DEFAULT_TOKEN_SECRET_ID)
    const previousToken =
      previousTokenId && previousTokenId !== DEFAULT_TOKEN_SECRET_ID
        ? safeGetSecret(previousTokenId)
        : ''
    const tokenToKeep = fixedToken || legacyToken?.trim() || previousToken
    if (tokenToKeep && tokenToKeep !== fixedToken) {
      safeSetSecret(DEFAULT_TOKEN_SECRET_ID, tokenToKeep)
    }
    if (legacyToken !== undefined) migrated = true
    // 0.7.54：一个值都没取到时绝不覆盖旧条目名指针——0.6.0~0.6.17 的用户条目名是自己填的
    // （可能含中文/大写，Obsidian 1.13 读取不担保）；抹掉指针后原值永远找不回、也无法诊断。
    if (this.settings.tokenSecretId !== DEFAULT_TOKEN_SECRET_ID) {
      if (tokenToKeep) {
        this.settings.tokenSecretId = DEFAULT_TOKEN_SECRET_ID
        migrated = true
      } else {
        console.warn(
          `[ai-linzi] 旧密钥条目「${previousTokenId}」当前读不到值，保留指针不覆盖，等下次启动重试`,
        )
      }
    }

    const previousWechatId = this.settings.wechatAppSecretId.trim()
    const fixedWechat = safeGetSecret(DEFAULT_WECHAT_SECRET_ID)
    const previousWechat =
      previousWechatId && previousWechatId !== DEFAULT_WECHAT_SECRET_ID
        ? safeGetSecret(previousWechatId)
        : ''
    const wechatToKeep = fixedWechat || legacyWechatSecret?.trim() || previousWechat
    if (wechatToKeep && wechatToKeep !== fixedWechat) {
      safeSetSecret(DEFAULT_WECHAT_SECRET_ID, wechatToKeep)
    }
    if (legacyWechatSecret !== undefined) migrated = true
    if (this.settings.wechatAppSecretId !== DEFAULT_WECHAT_SECRET_ID) {
      if (wechatToKeep) {
        this.settings.wechatAppSecretId = DEFAULT_WECHAT_SECRET_ID
        migrated = true
      } else {
        console.warn(
          `[ai-linzi] 旧 AppSecret 条目「${previousWechatId}」当前读不到值，保留指针不覆盖，等下次启动重试`,
        )
      }
    }
    // 驾驶舱目录默认名历史上改过两跳：0.6.36 中文名→inbox/raw/wiki/output（打卡营模板），
    // 0.7.14 再→000_Inbox/01_Raw/02_Wiki/04_Output。0.7.54 修复：旧实现只迁第一跳、且漏了
    // output，导致 0.6.36~0.7.13 的老用户四张「第二大脑」卡永久显示 0 且没有任何提示
    // （空状态要四项全空才提示，有默认值就永不触发）。现在把每个历史默认值都直接迁到当前默认，
    // 用户自定义过的一律不动。
    const cockpitFolderKeys = [
      'cockpitInboxFolder',
      'cockpitSourcesFolder',
      'cockpitKnowledgeFolder',
      'cockpitOutputFolder',
    ] as const
    const cockpitLegacyDefaults: Record<(typeof cockpitFolderKeys)[number], string[]> = {
      cockpitInboxFolder: ['收件箱', 'inbox'],
      cockpitSourcesFolder: ['原始素材', 'raw'],
      cockpitKnowledgeFolder: ['知识库', 'wiki'],
      cockpitOutputFolder: ['对外输出', 'output'],
    }
    for (const key of cockpitFolderKeys) {
      const current = this.settings[key]
      if (cockpitLegacyDefaults[key].includes(current) && current !== DEFAULT_SETTINGS[key]) {
        this.settings[key] = DEFAULT_SETTINGS[key]
        migrated = true
      }
    }
    if (migrated) await this.saveSettings()
  }

  /** 0.7.54：与 loadSettings 同款兜底。存储异常在 9 个调用点会抛英文原始异常给用户，
   *  这里统一吞成空值，由上层显示「还没连接 AI霖子」的中文引导。 */
  getApiToken(): string {
    try {
      return this.app.secretStorage.getSecret(DEFAULT_TOKEN_SECRET_ID)?.trim() ?? ''
    } catch {
      return ''
    }
  }

  async setApiToken(value: string): Promise<void> {
    this.writeSecretOrExplain(DEFAULT_TOKEN_SECRET_ID, value.trim(), '连接密钥')
    this.settings.tokenSecretId = DEFAULT_TOKEN_SECRET_ID
    this.capabilitiesCache = null // 换密钥=换账号,旧权益缓存立即作废
    await this.saveSettings()
  }

  /**
   * 密钥写入 + 回读自检（Obsidian 1.13 起 setSecret 会对不合规条目名抛错；
   * 2026-08-18 公众号 AppSecret「填了也存不上、一直提示」事故：旧版插件的
   * 自定义条目名在 1.13 上写入抛错且无任何提示。固定条目名本身合法，此处
   * 兜底任何未来的存储异常，保证失败一定可见、绝不静默。）
   */
  private writeSecretOrExplain(id: string, value: string, label: string): void {
    try {
      this.app.secretStorage.setSecret(id, value)
    } catch (error) {
      new Notice(
        `${label}保存失败：${error instanceof Error ? error.message : String(error)}。请重启 Obsidian 后重试。`,
        10000,
      )
      return
    }
    let readBack = ''
    try {
      readBack = this.app.secretStorage.getSecret(id)?.trim() ?? ''
    } catch {
      readBack = ''
    }
    if (value && readBack !== value) {
      new Notice(`${label}保存后校验失败（存储未生效）。请重启 Obsidian 后重新填写。`, 10000)
    }
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
    try {
      return this.app.secretStorage.getSecret(DEFAULT_WECHAT_SECRET_ID)?.trim() ?? ''
    } catch {
      return ''
    }
  }

  async setWechatAppSecret(value: string): Promise<void> {
    this.writeSecretOrExplain(DEFAULT_WECHAT_SECRET_ID, value.trim(), '公众号 AppSecret')
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
    if (id) return this.vaultActionHistory.find((record) => record.id === id)
    // 0.7.54：「撤销上一次」必须真的指向最近一次整理。旧实现跳过所有无移动记录的
    // 操作去捞更早的一条，用户刚删完文件夹按撤销，撤掉的却是几天前的改名。
    return this.vaultActionHistory.find((record) => !record.undoneAt)
  }

  captureVaultWriteSnapshots(plan: VaultOrganizePlan): VaultWriteSnapshot[] {
    return this.vaultAgent.captureWriteSnapshots(plan)
  }

  /** 供跨轮任务状态记录文件版本快照；文件不存在时返回 null。 */
  vaultFileStat(path: string): VaultWriteSnapshot | null {
    const file = this.app.vault.getAbstractFileByPath(path)
    return file instanceof TFile
      ? { path: file.path, mtime: file.stat.mtime, size: file.stat.size }
      : null
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
      // 0.7.54：按记录真实内容说明去哪儿找，旧文案一律说"只有回收站笔记"会把
      // 新建/覆盖/生成成品的用户骗去翻废纸篓（那里什么都没有）。
      if ((record.trashedNotes ?? []).length > 0) {
        throw new Error('这次操作是移入回收站，请到系统废纸篓 / Obsidian 回收站恢复')
      }
      const created = [...(record.createdNotes ?? []), ...(record.createdArtifacts ?? [])]
      if (created.length > 0) {
        throw new Error(
          `这次操作是新建文件，插件不会自动删除；如需撤销请手动把这些文件移入回收站：${created.slice(0, 3).join('、')}${created.length > 3 ? ` 等 ${created.length} 项` : ''}`,
        )
      }
      const updated = record.updatedNotes ?? []
      if (updated.length > 0) {
        throw new Error(
          `这次操作直接改写了笔记正文，插件没有保存改写前的版本，无法自动还原：${updated.join('、')}。请用 Obsidian 的「文件恢复」查看历史版本`,
        )
      }
      if ((record.createdFolders ?? []).length > 0) {
        throw new Error('这次操作只新建了文件夹（不含任何文件改动），如需清理请在文件树中手动删除')
      }
      throw new Error('这次操作没有可自动还原的移动/重命名记录')
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
    const executor = await this.getLocalSkillExecutor()
    await executor.undoCreatedOutputs(record)
    await this.saveSettings()
    return record
  }

  async getLocalSkillExecutor(): Promise<LocalSkillExecutor> {
    if (!this.localSkillExecutorPromise) {
      this.localSkillExecutorPromise = import('./local-skill-executor').then(
        ({ LocalSkillExecutor }) => new LocalSkillExecutor(
          this.app,
          () => this.settings.outputFolder,
        ),
      )
    }
    return this.localSkillExecutorPromise
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
    const rows: Record<string, unknown>[] = Array.isArray(data.messages)
      ? data.messages.filter(isUnknownRecord)
      : []
    if (!id || rows.length === 0) return null
    const messages: WireMessage[] = rows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        id: typeof row.id === 'string' ? row.id : uid(),
        role: row.role === 'user' ? 'user' as const : 'assistant' as const,
        parts: [{ type: 'text' as const, text: typeof row.content === 'string' ? row.content : '' }],
      }))
    const firstUser = messages.find((message) => message.role === 'user')
    const rawCreatedAt = rows.at(-1)?.createdAt
    const lastCreatedAt = typeof rawCreatedAt === 'string' || typeof rawCreatedAt === 'number'
      ? String(rawCreatedAt)
      : ''
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

  /**
   * 技能进度桥：聊天面板打开时把技能状态写进对话区（仅本机历史），
   * 面板没开时退回 Notice。返回消息 id，供后续原地更新同一条状态。
   */
  reportSkillStatus(text: string, replaceId?: string): string | undefined {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0]
    const view = leaf?.view
    if (view instanceof ChatView) return view.postSkillStatus(text, replaceId)
    new Notice(text, 8000)
    return undefined
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
  /** 从电脑选择的 .xlsx：原文件本机解析后只保留文字在内存，不写 Vault/历史/设置。 */
  private uploadedSpreadsheetAttachments: Array<{
    id: string
    filename: string
    text: string
  }> = []
  private authorizedContentChars = 0
  /** 长文原文与分段只驻留在当前 Obsidian 进程内，不写 data.json 或会话历史。 */
  private longDocumentPath = ''
  private longDocumentChars = 0
  private longDocumentTask: LongDocumentTaskState | null = null
  private sending = false
  /**
   * 跨用户轮次的 Vault 任务状态（阶段 A）。只存任务元数据与路径快照，正文与
   * 工具输出只驻留进程内存；确认卡被执行/取消、任务正常收尾或超时后清空。
   */
  private pendingVaultTask: PendingVaultTask | null = null
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
    const skillStudioBtn = actionsRow.createEl('button', {
      text: '创建 Skill',
      cls: 'ai-linzi-action-btn ai-linzi-skill-studio-btn',
      attr: { title: '打开 Skill Studio：官方模板、定制创建、试运行与导入分享' },
    })
    skillStudioBtn.onclick = () => this.openSkillStudio()

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
    this.registerAttachmentDropAndPaste(footer)

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
    const menu = new Menu()
    menu.addItem((item) => item
      .setTitle('＋ 打开 Skill Studio')
      .setIcon('wand-sparkles')
      .onClick(() => this.openSkillStudio()))
    if (skills.length === 0) {
      menu.addItem((item) => item
        .setTitle('还没有 Skill，先从官方模板开始')
        .setIcon('info')
        .setDisabled(true))
    }
    for (const skill of skills) {
      menu.addItem((item) =>
        item
          .setTitle(localSkillMenuTitle(skill))
          .setIcon('sparkles')
          .onClick(() => {
            // Skill 在正文「AI霖子自动调用」里声明过短语就直接用它——不同技能的处理对象
            // 天差地别(当前笔记 / 整个知识库 / 某份逐字稿),统一填「处理当前笔记」会误导。
            this.inputEl.value = skill.autoTriggers[0]?.trim()
              || `用${skill.displayName}技能处理当前笔记`
            this.inputEl.focus()
          }),
      )
    }
    menu.showAtMouseEvent(event)
  }

  private openSkillStudio(): void {
    new SkillStudioModal(this.app, {
      onCreateWithAi: (prompt, sampleInput) => {
        this.inputEl.value = prompt
        this.inputEl.focus()
        void this.send({ skillCreator: true, skillStudioTestInput: sampleInput })
      },
      onOfferBundle: (block, sampleInput) => {
        this.messages.push({
          id: uid(),
          role: 'user',
          parts: [{ type: 'text', text: `从 Skill Studio 安装「${block.name}」` }],
        })
        this.messages.push({
          id: uid(),
          role: 'assistant',
          parts: [{ type: 'text', text: formatCreateLocalSkillBlock(block) }],
          skillStudioTestInput: sampleInput,
          skillCreatorResult: true,
        })
        void this.persistNow()
        this.renderMessages()
      },
    }).open()
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
      this.uploadedSpreadsheetAttachments = []
      this.authorizedContentChars = 0
      this.longDocumentPath = selection.path
      this.longDocumentChars = selection.totalChars
      new Notice('已进入长文任务：请在对话框写清楚要完成什么工作，然后发送')
    } else {
      this.longDocumentPath = ''
      this.longDocumentChars = 0
      this.authorizedContentPaths = selection.paths
      this.authorizedContentChars =
        selection.totalChars +
        this.uploadedSpreadsheetAttachments.reduce((sum, item) => sum + item.text.length, 0)
    }
    this.refreshAuthorizedContentUi()
  }

  private clearAuthorizedContent(): void {
    this.authorizedContentPaths = []
    this.uploadedSpreadsheetAttachments = []
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
    menu.addItem((item) =>
      item
        .setTitle('从电脑上传 Excel（.xlsx）')
        .setIcon('sheet')
        .onClick(() => void this.addComputerSpreadsheets()),
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

  private async addComputerSpreadsheets(): Promise<void> {
    if (this.longDocumentPath) {
      new Notice('长文任务不能同时带附件，请先清除长文任务')
      return
    }
    if (!(await this.plugin.requireProAccess('主对话 Excel 附件'))) return
    const input = this.containerEl.ownerDocument.createElement('input')
    input.type = 'file'
    input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    input.multiple = true
    input.hidden = true
    this.containerEl.ownerDocument.body.appendChild(input)
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      if (files.length > 0) void this.acceptDroppedFiles(files, [])
    }, { once: true })
    input.addEventListener('cancel', () => input.remove(), { once: true })
    input.click()
  }

  private clearChatImageAttachments(): void {
    if (this.chatImageAttachments.length === 0) return
    this.chatImageAttachments = []
    this.refreshAuthorizedContentUi()
  }

  /**
   * 拖拽与粘贴附件（0.7.57）：截图后直接粘贴、文件直接拖进对话框，
   * 不必再走「📎 → 选来源 → 弹窗挑文件」。
   *
   * **Mac 与 Windows 都覆盖**，因为走的都是浏览器原生事件而非平台快捷键：
   * - 粘贴：监听 `paste` 事件，Cmd+V（Mac）与 Ctrl+V（Windows）由系统派发同一个事件；
   *   Mac 的 Ctrl+Shift+Cmd+4、Windows 的 Win+Shift+S 截图都进剪贴板，同样接得住。
   * - 拖文件：`dataTransfer.files`，Finder 与资源管理器行为一致；Mac 的 Shift+Cmd+4、
   *   Windows 的 Win+PrtScn 截到文件后拖进来也走这条。
   * - Obsidian 文件树拖拽：负载是内部相对路径（两平台都用 `/`，不受 Windows `\` 影响）。
   *
   * 图片进图片附件（视觉输入），MD/TXT/PDF/DOCX/HTML/PPTX/XLSX 进精确授权资料。
   * 一般文档仍只读 Vault 内文件；电脑 .xlsx 在本机解析后只把文字作为授权内容使用。
   * 分类与校验逻辑在 chat-drop-core.ts，可单测。
   */
  private registerAttachmentDropAndPaste(zone: HTMLElement): void {
    this.registerDomEvent(this.inputEl, 'paste', (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items ?? []).filter((item) => item.kind === 'file')
      if (items.length === 0) return
      const files = items.map((item) => item.getAsFile()).filter((file): file is File => file !== null)
      if (files.length === 0) return
      // 只有确实拿到文件才拦截默认粘贴，纯文本粘贴一律不受影响。
      event.preventDefault()
      void this.acceptDroppedFiles(files, [])
    })

    let dragDepth = 0
    const setActive = (active: boolean) => zone.toggleClass('ai-linzi-drop-active', active)
    this.registerDomEvent(zone, 'dragenter', (event: DragEvent) => {
      if (!this.dragCarriesAttachment(event)) return
      event.preventDefault()
      dragDepth += 1
      setActive(true)
    })
    this.registerDomEvent(zone, 'dragover', (event: DragEvent) => {
      if (!this.dragCarriesAttachment(event)) return
      // 不 preventDefault 浏览器就不会触发 drop。
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    })
    this.registerDomEvent(zone, 'dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setActive(false)
    })
    this.registerDomEvent(zone, 'drop', (event: DragEvent) => {
      if (!this.dragCarriesAttachment(event)) return
      event.preventDefault()
      dragDepth = 0
      setActive(false)
      const dropped = Array.from(event.dataTransfer?.files ?? [])
      const vaultFiles = this.vaultFilesFromDrag(event)
      // 0.7.63 修复:从 Finder/资源管理器拖入「已经在库里」的文件时,此前只拿到
      // File 对象、从不回查 vault 路径,PDF/DOCX 一律被误判「不在知识库里」。
      const { external: files, vaultResolved } = this.resolveDiskDropsAgainstVault(dropped)
      for (const resolved of vaultResolved) {
        if (!vaultFiles.some((existing) => existing.path === resolved.path)) vaultFiles.push(resolved)
      }
      if (files.length === 0 && vaultFiles.length === 0) {
        // 从网页里直接拖图片（Mac / Windows 都常见）只带 URL 不带文件，
        // 静默失败会让用户以为插件坏了。
        const raw = event.dataTransfer?.getData('text/uri-list')?.trim() ??
          event.dataTransfer?.getData('text/plain')?.trim() ?? ''
        if (/^https?:/i.test(raw)) {
          new Notice('网页上的图片请先保存到电脑或知识库，再拖进来', 6000)
        }
        return
      }
      void this.acceptDroppedFiles(files, vaultFiles)
    })
  }

  private dragCarriesAttachment(event: DragEvent): boolean {
    const transfer = event.dataTransfer
    if (!transfer) return false
    if ([...transfer.types].includes('Files')) return true
    // Obsidian 文件树拖拽走的是文本负载（路径或 wikilink），没有 Files 类型。
    return [...transfer.types].some((type) => type === 'text/plain' || type === 'text/uri-list')
  }

  /**
   * 从 Finder/资源管理器拖进来的文件若实际位于当前 Vault 内，映射回 TFile 按库内
   * 文件处理（0.7.63）。绝对路径经 Electron webUtils 获取（新版 Electron 已移除
   * File.path），中文文件名必须做 NFC 归一化——macOS Finder 给出的是 NFD。
   */
  private resolveDiskDropsAgainstVault(files: File[]): { external: File[]; vaultResolved: TFile[] } {
    const external: File[] = []
    const vaultResolved: TFile[] = []
    const adapter = this.app.vault.adapter
    const basePath = adapter instanceof FileSystemAdapter
      ? adapter.getBasePath().replace(/\\/g, '/').normalize('NFC')
      : ''
    for (const file of files) {
      const absolute = this.absolutePathOfDroppedFile(file).replace(/\\/g, '/').normalize('NFC')
      if (!basePath || !absolute || !absolute.startsWith(`${basePath}/`)) {
        external.push(file)
        continue
      }
      const relative = normalizePath(absolute.slice(basePath.length + 1))
      const target = this.app.vault.getAbstractFileByPath(relative)
      if (target instanceof TFile) vaultResolved.push(target)
      else external.push(file)
    }
    return { external, vaultResolved }
  }

  private absolutePathOfDroppedFile(file: File): string {
    try {
      const electron = (window as { require?: (id: string) => unknown }).require?.('electron') as
        | { webUtils?: { getPathForFile?: (file: File) => string } }
        | undefined
      const viaWebUtils = electron?.webUtils?.getPathForFile?.(file)
      if (typeof viaWebUtils === 'string' && viaWebUtils) return viaWebUtils
    } catch {
      // 旧版 Electron 没有 webUtils，落到 File.path 兜底。
    }
    const legacy = (file as File & { path?: string }).path
    return typeof legacy === 'string' ? legacy : ''
  }

  /** 从 Obsidian 文件树拖进来的项：负载是 Vault 相对路径或 [[wikilink]]。 */
  private vaultFilesFromDrag(event: DragEvent): TFile[] {
    const raw = event.dataTransfer?.getData('text/plain')?.trim()
    if (!raw) return []
    const files: TFile[] = []
    for (const line of raw.split(/\r?\n/)) {
      const cleaned = line.trim().replace(/^!?\[\[|\]\]$/g, '').split('|')[0].trim()
      if (!cleaned) continue
      const direct = this.app.vault.getAbstractFileByPath(cleaned)
      const file = direct instanceof TFile
        ? direct
        : this.app.metadataCache.getFirstLinkpathDest(cleaned, '')
      if (file instanceof TFile) files.push(file)
    }
    return files
  }

  /** 统一入口：外部文件（File）与 Vault 文件（TFile）走同一套分类、校验与落地。 */
  private async acceptDroppedFiles(files: File[], vaultFiles: TFile[]): Promise<void> {
    if (files.length === 0 && vaultFiles.length === 0) return
    if (this.longDocumentPath) {
      new Notice('长文任务不能同时带附件，请先清除长文任务')
      return
    }
    const candidates: DropCandidate[] = [
      ...files.map((file, sourceIndex) => ({
        name: file.name || '剪贴板图片.png',
        mimeType: file.type,
        size: file.size,
        sourceIndex,
      })),
      ...vaultFiles.map((file) => ({ name: file.name, size: file.stat.size, vaultPath: file.path })),
    ]
    const plan = planDroppedFiles(candidates, this.chatImageAttachments.length)
    if (
      plan.images.length + plan.documents.length > 0 &&
      !(await this.plugin.requireProAccess(plan.documents.length > 0 ? '主对话文件附件' : '主对话图片附件'))
    ) return

    let added = 0
    for (const candidate of plan.images) {
      try {
        const sourceFile = candidate.sourceIndex === undefined
          ? undefined
          : files[candidate.sourceIndex]
        const dataUrl = candidate.vaultPath
          ? await vaultImageToReferenceDataUrl(this.plugin, candidate.vaultPath)
          : sourceFile
            ? await fileToReferenceDataUrl(sourceFile)
            : (() => { throw new Error('没有找到原始图片') })()
        this.chatImageAttachments.push({ name: candidate.name, dataUrl })
        added += 1
      } catch (error) {
        plan.rejections.push(`${candidate.name} 读取失败：${(error as Error).message}`)
      }
    }
    const documentPaths = plan.documents
      .map((candidate) => candidate.vaultPath as string)
      .filter(Boolean)
      .filter((path) => !this.authorizedContentPaths.includes(path))
    if (documentPaths.length > 0) {
      this.authorizedContentPaths = [...this.authorizedContentPaths, ...documentPaths]
      added += documentPaths.length
    }
    let addedComputerSpreadsheets = 0
    if (plan.documents.some((candidate) => !candidate.vaultPath)) {
      let capabilities: PluginCapabilities | undefined
      try {
        capabilities = await this.plugin.getCapabilities()
      } catch {
        // requireProAccess 已完成真实权限校验；旧能力接口时沿用保守默认值。
      }
      const limits = this.authorizedContentLimits(capabilities)
      for (const candidate of plan.documents.filter((item) => !item.vaultPath)) {
        try {
          const sourceFile = candidate.sourceIndex === undefined
            ? undefined
            : files[candidate.sourceIndex]
          if (!sourceFile) throw new Error('没有找到原始 Excel 文件')
          const maxBytes = LOCAL_SEARCH_FILE_LIMITS.xlsx
          if (sourceFile.size > maxBytes) {
            throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
          }
          if (
            this.authorizedContentPaths.length +
            this.uploadedSpreadsheetAttachments.length +
            1 > limits.maxFiles
          ) {
            throw new Error(`主对话单次最多带上 ${limits.maxFiles} 份资料`)
          }
          const text = extractXlsxText(
            new Uint8Array(await sourceFile.arrayBuffer()),
            limits.maxPerFileChars + 1,
          )
          if (!text.trim()) throw new Error('工作簿里没有可读取的单元格内容')
          if (text.length > limits.maxPerFileChars) {
            throw new Error(
              `解析后超过单份 ${limits.maxPerFileChars.toLocaleString('zh-CN')} 字上限，请拆分工作簿`,
            )
          }
          const nextTotal = this.authorizedContentChars + text.length
          if (nextTotal > limits.maxTotalChars) {
            throw new Error(
              `已授权内容超过 ${limits.maxTotalChars.toLocaleString('zh-CN')} 字上限，请减少文件`,
            )
          }
          this.uploadedSpreadsheetAttachments.push({
            id: uid(),
            filename: candidate.name,
            text,
          })
          this.authorizedContentChars = nextTotal
          addedComputerSpreadsheets += 1
          added += 1
        } catch (error) {
          plan.rejections.push(`${candidate.name} 解析失败：${(error as Error).message}`)
        }
      }
    }
    if (added > 0) {
      this.refreshAuthorizedContentUi()
      this.inputEl.focus()
      const acceptedDocumentCount = documentPaths.length + addedComputerSpreadsheets
      const summary = dropSummary({
        ...plan,
        documents: plan.documents.slice(0, acceptedDocumentCount),
      })
      if (summary) new Notice(summary, 3000)
    }
    for (const reason of plan.rejections.slice(0, 3)) new Notice(reason, 6000)
  }

  private refreshAuthorizedContentUi(): void {
    if (!this.authorizedContentBtn || !this.authorizedContentStatusEl) return
    const vaultDocumentCount = this.authorizedContentPaths.length
    const spreadsheetCount = this.uploadedSpreadsheetAttachments.length
    const count = vaultDocumentCount + spreadsheetCount
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
      if (spreadsheetCount > 0) {
        statusParts.push(
          `电脑 Excel（仅本机解析）：${this.uploadedSpreadsheetAttachments
            .map((item) => item.filename)
            .join('、')}`,
        )
      }
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
    if (
      this.authorizedContentPaths.length === 0 &&
      this.uploadedSpreadsheetAttachments.length === 0
    ) return undefined
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
    for (const attachment of this.uploadedSpreadsheetAttachments) {
      if (!attachment.text.trim()) continue
      if (attachment.text.length > limits.maxPerFileChars) {
        throw new Error(
          `《${attachment.filename}》超过单份 ${limits.maxPerFileChars.toLocaleString('zh-CN')} 字上限，` +
          '请拆分工作簿后再使用',
        )
      }
      totalChars += attachment.text.length
      if (totalChars > limits.maxTotalChars) {
        throw new Error(
          `已授权内容超过 ${limits.maxTotalChars.toLocaleString('zh-CN')} 字上限，请减少文件后重试`,
        )
      }
      items.push({
        filename: attachment.filename,
        path: `computer-upload/${attachment.id}/${attachment.filename}`,
        text: attachment.text,
      })
    }
    if (items.length > limits.maxFiles) {
      throw new Error(`单次最多带上 ${limits.maxFiles} 份资料`)
    }
    this.authorizedContentChars = totalChars
    this.refreshAuthorizedContentUi()
    return items.length > 0 ? { items } : undefined
  }

  /** 本地候选图片元数据绝不传给主对话；云端只收到标准 UIMessage。 */
  private messagesForApi(): WireMessage[] {
    // 技能进度状态条是本机 UI，不属于对话上下文；发给 API 前整条剥离。
    return this.messages
      .filter((message) => !message.localSkillStatus)
      .map(({ id, role, parts }) => ({ id, role, parts }))
  }

  /**
   * 技能进度状态条：调用技能的每一步（已锁定/生成中/完成/失败原因）都落进
   * 对话区，错误不再只靠 9 秒 Notice（2026-08-18 Alina 反馈：销售复盘选完
   * 文件后“毫无反应”——实为本机报错只闪了一条 toast）。传 replaceId 原地更新。
   */
  postSkillStatus(text: string, replaceId?: string, thinking = false): string {
    const existing = replaceId
      ? this.messages.find((message) => message.id === replaceId && message.localSkillStatus)
      : undefined
    if (existing) {
      existing.parts = [{ type: 'text', text }]
    } else {
      this.messages.push({
        id: uid(),
        role: 'assistant',
        parts: [{ type: 'text', text }],
        localSkillStatus: true,
      })
    }
    void this.persistNow()
    this.renderMessages(thinking)
    return existing?.id ?? this.messages[this.messages.length - 1].id
  }

  /**
   * 对话内活动流(0.7.53)：Vault 工具循环的轮数与每步动作实时滚动显示在对话区，
   * 替代只闪 2.5 秒的右上角 Notice(2026-08-18 Alina 反馈：过程要像工作记录一样
   * 留在对话里，工作中要有持续的动态效果)。
   * - begin 只登记不渲染：纯问答回合永远不出现状态条，零打扰；
   * - 第一条真实动作(step/强 current)才落进对话，复用 postSkillStatus 原地更新；
   * - end 时定格为 ✅/⚠️ 摘要留在对话里；从未有动作则悄悄丢弃。
   */
  /** 逻辑在 activity-feed-core.ts（纯模块，可真跑单测）；这里只接线渲染与滚动。 */
  private readonly activityFeed = new ActivityFeed({
    render: (text, id, thinking) => {
      const nextId = this.postSkillStatus(text, id, thinking)
      this.listEl.scrollTop = this.listEl.scrollHeight
      return nextId
    },
    now: () => Date.now(),
  })

  private activityBegin(current: string) {
    this.activityFeed.begin(current)
  }

  private activityStep(line: string, current?: string | null) {
    this.activityFeed.step(line, current)
  }

  private activityCurrent(current: string) {
    this.activityFeed.setCurrent(current)
  }

  private activityEnd(outcome: 'ok' | 'error', summary?: string) {
    this.activityFeed.end(outcome, summary)
  }

  private recentLocalSkillPath(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const path = this.messages[index].localSkillPath
      if (path) return path
    }
    return undefined
  }

  private recentPendingVaultQuestion(): { message: WireMessage; question: PendingVaultQuestion } | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index]
      const question = message.vaultQuestion
      if (!question || question.answeredAt) continue
      if (Date.now() - question.createdAt > 30 * 60 * 1000) return undefined
      return { message, question }
    }
    return undefined
  }

  private hasPendingSkillCreatorInterview(): boolean {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index]
      if (message.role !== 'assistant' || message.localSkillStatus) continue
      // 只看最近一条可见 AI 回复。新一轮已经生成 Skill 包后，
      // 不能继续捡到更早的“访谈未完成”状态，否则之后的普通对话都会被劫持。
      return message.skillCreatorPending === true
    }
    return false
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

  private async send(
    options: { skillCreator?: boolean; skillStudioTestInput?: string } = {},
  ) {
    const text = this.inputEl.value.trim()
    if (!text || this.sending) return
    const pendingVaultQuestion = this.recentPendingVaultQuestion()
    const pendingSkillCreatorInterview = this.hasPendingSkillCreatorInterview()
    const skillCreatorTurn =
      options.skillCreator === true ||
      pendingSkillCreatorInterview ||
      isExplicitLocalSkillCreationIntent(text)

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
      if (pendingVaultQuestion) localSkillMatch = { kind: 'none' }
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
        !this.longDocumentPath &&
        !singleIllustration &&
        !illustrationEdit &&
        imageAttachments.length === 0 &&
        !skillCreatorTurn
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
      let localSkillRunIds: string[] | undefined
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
        let agentResult: {
          text: string
          sources: VaultMessageSource[]
          localSkillRunIds?: string[]
        }
        try {
          agentResult = await this.runVaultAgentLoop({
            question: text,
            noteContext,
            authorizedContent,
            localSkill: localSkillRequest,
            localSkillContext: localSkill ? this.localSkills.context(localSkill) : undefined,
            // 已由用户精确勾选的整篇资料可以直接用于回答或生成成品，但这一轮不再
            // 额外开放整个 Vault 工具，避免“精确授权”被扩大成未选择文件的读取。
            vaultAccess:
              this.authorizedContentPaths.length === 0 &&
              this.uploadedSpreadsheetAttachments.length === 0,
            vaultSearch: vaultSearch.context,
            noteEdit,
            noteImageIntent: singleIllustration,
            intent: 'auto',
            resumeQuestion: pendingVaultQuestion?.question,
          })
        } catch (error) {
          // 活动流定格为中断原因后再抛出，交由统一错误气泡处理。
          this.activityEnd('error', error instanceof Error ? error.message : String(error))
          throw error
        }
        this.activityEnd('ok')
        answer = agentResult.text
        if (pendingVaultQuestion) pendingVaultQuestion.message.vaultQuestion = {
          ...pendingVaultQuestion.question,
          answeredAt: Date.now(),
        }
        localSkillRunIds = agentResult.localSkillRunIds
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
            undefined,
            skillCreatorTurn,
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
                mediaType: imageMediaTypeFromDataUrl(image.dataUrl),
              })),
              vaultSearch: vaultSearch.context,
              noteEdit,
              noteImageIntent: singleIllustration,
              localSkill: localSkillRequest,
              skillCreator: skillCreatorTurn ? { mode: 'create', source: options.skillCreator ? 'studio' : 'chat' } : undefined,
            },
          })
          answer = typeof data.text === 'string' ? data.text : '(空响应)'
        }
      }
      const vaultQuestion = extractVaultQuestion(answer)
      if (vaultQuestion.invalid) {
        throw new Error('AI 返回的澄清问题格式不完整，请重试')
      }
      answer = vaultQuestion.cleanText || vaultQuestion.question?.question || answer
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
      const skillCreatorPending = skillCreatorTurn &&
        !answer.startsWith('⚠️') &&
        extractCreateLocalSkillBlocks(answer).blocks.length === 0
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
        vaultQuestion: vaultQuestion.question,
        skillStudioTestInput: skillCreatorTurn ? options.skillStudioTestInput : undefined,
        skillCreatorPending,
        skillCreatorResult: skillCreatorTurn || undefined,
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
          skillCreatorPending: skillCreatorTurn || undefined,
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
    /** 上一轮原生 ask_user 的本机续接信息；回答作为同一个 Responses 调用继续。 */
    resumeQuestion?: PendingVaultQuestion
  }): Promise<{
    text: string
    sources: VaultMessageSource[]
    localSkillRunIds?: string[]
  }> {
    let toolResults: VaultAgentToolResult[] = []
    const sources: VaultMessageSource[] = []
    const localSkillRunIds: string[] = []
    const verifiedWritePaths = new Set<string>()
    let lastText = ''
    let pendingRetryReason: VaultAnswerRetryReason | undefined
    // 本机结果预算（2026-08-18 开放到 36 万字符）：满了不再报错断头，
    // 改为提示模型基于已读内容收尾，并关闭后续工具轮。
    let toolBudgetExhausted = false
    const appendToolResults = (incoming: VaultAgentToolResult[]) => {
      const merged = appendToolResultsWithinBudget(toolResults, incoming)
      toolResults = merged.results
      if (merged.exhausted && !toolBudgetExhausted) {
        toolBudgetExhausted = true
        this.activityStep('📦 本次读取量较大，将基于已读内容收尾')
        new Notice('本次任务读取量较大，AI霖子将基于已读内容收尾；更多材料建议分批处理。', 6000)
      }
    }
    // 阶段 A：intent 只允许 auto → organize 单向升级；跨轮任务状态在会话上保存。
    if (this.pendingVaultTask && isVaultTaskExpired(this.pendingVaultTask, Date.now())) {
      this.pendingVaultTask = null
    }
    // 「对/继续」这类短确认才完整承接旧任务；较长的新消息只携带元数据，
    // intent 不继承，避免旧写入任务把无关新话题拖进 organize 强制流程。
    const taskContinuation =
      Boolean(this.pendingVaultTask) && isVaultTaskContinuation(input.question)
    // 用户措辞本身就是整理/移动/删除/写入类请求（含否定与只读豁免判定）。
    // round 0 仍走 auto 保留自主反问空间，但这类请求：①任务标记为 organize，
    // 合法反问收尾后任务保留，「全部整理/继续」能承接升级；②绝不允许零工具、
    // 零方案的口头收尾（阿正 No.153 案，工单第七节 08-18 追记）。
    const mutationAsk = detectVaultAgentIntent(input.question) === 'organize'
    let intent: VaultAgentIntent = upgradeVaultIntent(input.intent, {
      question: input.question,
      sawPlan: false,
      pendingTask: taskContinuation ? this.pendingVaultTask : null,
    })
    // 承接上一轮未完成任务：按受控路径重新读取本地文件重建工具结果（不落盘正文）。
    if (this.pendingVaultTask && input.vaultAccess && taskContinuation) {
      const task = this.pendingVaultTask
      const rehydratePaths = [
        ...new Set([
          ...task.sourcePaths.map((item) => item.path),
          ...(task.targetPath ? [task.targetPath] : []),
        ]),
      ].slice(0, 6)
      if (rehydratePaths.length > 0) {
        const rehydrated = await this.plugin.vaultAgent.executeReadCalls(
          rehydratePaths.map((path, index) => ({
            id: `task-rehydrate-${index + 1}`,
            name: 'read_note' as const,
            arguments: { path, offset: 0, maxChars: 16_000 },
          })),
        )
        appendToolResults(rehydrated.results)
        sources.push(...rehydrated.sources)
        for (const [index, path] of rehydratePaths.entries()) {
          if (rehydrated.results[index]?.ok && path === task.targetPath) {
            verifiedWritePaths.add(path)
          }
        }
        new Notice(`AI霖子正在继续上一轮任务：${task.goal.slice(0, 24)}…`, 3500)
      }
    }
    // 上一份已确认的方案在本机执行失败过：开场把失败原因作为合成工具结果交回
    // 模型（一次性），让它核对真实路径后给出修正方案，而不是继续口头答应。
    if (this.pendingVaultTask?.lastExecuteError && input.vaultAccess) {
      const failure = this.pendingVaultTask.lastExecuteError
      toolResults.push(buildVaultExecuteFailureToolResult(failure.planTitle, failure.message))
      this.pendingVaultTask = { ...this.pendingVaultTask, lastExecuteError: undefined }
    }
    const updateTask = (event: VaultTaskEvent) => {
      const now = Date.now()
      if (!this.pendingVaultTask) {
        this.pendingVaultTask = {
          id: `vault-task-${now}-${Math.random().toString(36).slice(2, 8)}`,
          goal: input.question.slice(0, 300),
          intent: intent === 'organize' || mutationAsk ? 'organize' : 'answer',
          stage: 'searching',
          candidatePaths: [],
          sourcePaths: [],
          createdAt: now,
          updatedAt: now,
        }
      }
      this.pendingVaultTask = advanceVaultTask(this.pendingVaultTask, event, now)
      if (intent === 'organize' || mutationAsk) this.pendingVaultTask.intent = 'organize'
    }

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

    // ── P3/阶段B（0.7.49）：整理类回合优先走原生 function calling 通道 ──
    // Luna 在 Responses API 上推理与原生工具共存（2026-08-18 探针 4/4 实证），
    // 「调没调工具」从文本猜测变成硬信号，空承诺在结构上不可能。任何一步失败
    // 都静默退回下方散文协议循环——行为与 0.7.48 完全一致，这就是回滚保险丝。
    // 0.7.53：登记活动流(只登记不渲染；第一条真实动作才落进对话区)。
    this.activityBegin(
      input.intent === 'auto'
        ? '理解你的要求，需要时会自行查找知识库…'
        : '正在查看 Vault，需要时会继续翻阅相关文件…',
    )
    let pendingNativeText: string | null = null
    // 0.7.54：引擎失败通常是网络/服务端原因，短时间内重试大概率同样失败。
    // 记住失败，标记路径不再把同一个引擎整轮重跑一遍（白等一次超时+白扣积分）。
    let nativeChannelFailed = false
    const nativeEligible = Boolean(input.resumeQuestion) || (
      input.vaultAccess &&
      !input.localSkill &&
      !input.localSkillContext &&
      !input.noteEdit &&
      !input.noteImageIntent &&
      (mutationAsk || (taskContinuation && this.pendingVaultTask?.intent === 'organize'))
    )
    // 抽成闭包函数：词表命中的快路径与「模型自主切换标记」（0.7.52）共用同一引擎。
    const runNativeChannel = async (): Promise<string | null> => {
      try {
        let previousResponseId = input.resumeQuestion?.responseId ?? ''
        let nextBody: Record<string, unknown> | null = input.resumeQuestion
          ? {
              question: input.question,
              round: input.resumeQuestion.round,
              sessionId: this.sessionId,
              previousResponseId: input.resumeQuestion.responseId,
              toolOutputs: [{
                callId: input.resumeQuestion.callId,
                output: input.question.slice(0, 4_000),
              }],
            }
          : null
        let stalledRetried = false
        for (let step = 0; step < VAULT_AGENT_MAX_ROUNDS; step++) {
          this.activityCurrent(
            step === 0
              ? '文件操作引擎启动，正在核对相关文件…'
              : `文件引擎 第 ${step + 1}/${VAULT_AGENT_MAX_ROUNDS} 步 · 继续执行…`,
          )
          const requestBody = nextBody ?? {
            question: input.question,
            round: 0,
            sessionId: this.sessionId,
            pendingTaskGoal: taskContinuation ? this.pendingVaultTask?.goal : undefined,
          }
          const requestRound = typeof requestBody.round === 'number' ? requestBody.round : 0
          const data = await this.plugin.api('/api/plugin/v1/vault-native/step', {
            method: 'POST',
            body: requestBody,
          })
          const responseId = typeof data.responseId === 'string' ? data.responseId : ''
          const nativeCalls: Record<string, unknown>[] = Array.isArray(data.toolCalls)
            ? data.toolCalls.filter(isUnknownRecord)
            : []
          const text = typeof data.text === 'string' ? data.text.trim() : ''
          if (!responseId) throw new Error('native: missing responseId')
          previousResponseId = responseId
          if (nativeCalls.length > 0) {
            const askUser = nativeCalls.find(
              (item) => item.name === 'ask_user',
            )
            if (askUser) {
              if (nativeCalls.length !== 1) throw new Error('native: ask_user must be the only tool call')
              const record = askUser
              const args = isUnknownRecord(record.arguments)
                ? record.arguments
                : {}
              const callId = typeof record.callId === 'string' ? record.callId : ''
              const question = typeof args.question === 'string' ? args.question.trim().slice(0, 600) : ''
              if (!callId || !question) throw new Error('native: invalid ask_user')
              const pendingQuestion: PendingVaultQuestion = {
                callId,
                responseId,
                question,
                options: Array.isArray(args.options)
                  ? args.options.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 6)
                  : [],
                allowFreeText: args.allowFreeText !== false,
                round: Math.min(requestRound + 1, VAULT_AGENT_MAX_ROUNDS - 1),
                goal: this.pendingVaultTask?.goal ?? input.resumeQuestion?.goal ?? input.question.slice(0, 300),
                createdAt: Date.now(),
              }
              this.activityStep('❓ 需要你补充一个关键信息', null)
              return `${question}\n\n${formatVaultQuestionMarker(pendingQuestion)}`
            }
            // 方案作为原生工具提交（0.7.49 E2E 第二轮发现：只给只读工具时 Luna 会
            // 诚实地声称「缺少整理能力」——把方案提交纳入它的行动空间才符合原生
            // 工具心理学）。收到即合成方案块，走与散文协议同一套预检/确认卡。
            const propose = nativeCalls.find(
              (item) => item.name === 'propose_organize_plan',
            )
            if (propose) {
              this.activityStep('📋 已生成整理方案，等待你确认', null)
              const record = propose
              const args = isUnknownRecord(record.arguments) ? record.arguments : {}
              const planPayload = {
                title: typeof args.title === 'string' ? args.title : '整理方案',
                summary: typeof args.summary === 'string' ? args.summary : '',
                operations: Array.isArray(args.operations) ? args.operations : [],
                notes: Array.isArray(args.notes) ? args.notes : [],
              }
              return [
                '已按核实的结构生成待确认方案，点确认后插件才会执行：',
                '<<<VAULT_ORGANIZE_PLAN>>>',
                JSON.stringify(planPayload),
                '<<<VAULT_ORGANIZE_PLAN_END>>>',
              ].join('\n')
            }
            const calls: VaultAgentToolCall[] = []
            for (const item of nativeCalls.slice(0, VAULT_AGENT_MAX_CALLS_PER_ROUND)) {
              const record = item
              const name = record.name
              if (name !== 'vault_search' && name !== 'list_folder' && name !== 'read_note') {
                throw new Error(`native: unsupported tool ${String(name)}`)
              }
              const callId = typeof record.callId === 'string' ? record.callId : ''
              const args =
                record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
                  ? (record.arguments as Record<string, unknown>)
                  : {}
              if (!callId) throw new Error('native: missing callId')
              calls.push({ id: callId, name, arguments: args })
            }
            const executed = await this.plugin.vaultAgent.executeCalls(calls, undefined)
            for (const call of calls) {
              const result = executed.results.find((item) => item.callId === call.id)
              if (!result?.ok) continue
              if (call.name === 'read_note' && typeof call.arguments.path === 'string') {
                const path = call.arguments.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
                verifiedWritePaths.add(path)
                const stat = this.plugin.vaultFileStat(path)
                if (stat) {
                  updateTask({
                    type: 'read',
                    snapshot: stat,
                    isTarget: path === this.pendingVaultTask?.targetPath,
                  })
                }
                this.activityStep(`📄 读取 ${path.split('/').at(-1) ?? path}`)
              }
              if (call.name === 'vault_search') {
                const hitPaths = executed.sources
                  .filter((source) => source.sourceId === call.id)
                  .map((source) => source.path)
                if (hitPaths.length > 0) updateTask({ type: 'search', candidatePaths: hitPaths })
                const query = typeof call.arguments.query === 'string' ? call.arguments.query : ''
                this.activityStep(
                  `🔍 搜索「${query.slice(0, 24)}」→ ${hitPaths.length} 个相关文件`,
                )
              }
              // list_folder 也算真实探查：必须建立/推进任务，否则「收尾必须出方案」
              // 的结构化纠正因任务不存在而失效（0.7.49 真机 E2E 抓到的缺口：模型
              // 只用 list_folder 摸清结构后，把方案写成文字树而不出确认卡）。
              if (call.name === 'list_folder') {
                updateTask({ type: 'search', candidatePaths: [] })
                const folder =
                  typeof call.arguments.path === 'string' && call.arguments.path.trim()
                    ? call.arguments.path.trim()
                    : 'Vault 根目录'
                this.activityStep(`📁 查看 ${folder}`)
              }
            }
            sources.push(...executed.sources)
            const merged = appendToolResultsWithinBudget(toolResults, executed.results)
            toolBudgetExhausted ||= merged.exhausted
            toolResults.length = 0
            toolResults.push(...merged.results)
            nextBody = {
              question: input.question,
              round: Math.min(requestRound + 1, VAULT_AGENT_MAX_ROUNDS - 1),
              sessionId: this.sessionId,
              previousResponseId,
              toolOutputs: executed.results.map((result) => ({
                callId: result.callId,
                output: result.output.slice(0, 18_000),
              })),
              ...(toolBudgetExhausted ? { disableTools: true, retryHint: 'budget' } : {}),
            }
            continue
          }
          if (text) {
            // 整理任务收尾必须有方案或明确缺口：给一次结构化纠正机会，仍不产出则
            // 把文本交给下方共用收尾管线（方案预检/确认卡/任务状态与散文协议同款）。
            const planProbe = extractVaultOrganizePlan(text)
            const needsPlan =
              !planProbe.plan &&
              !stalledRetried &&
              this.pendingVaultTask !== null &&
              this.pendingVaultTask.stage !== 'previewed' &&
              vaultWriteFlowRetryReason(this.pendingVaultTask, 'organize', false, false) !== undefined
            if (needsPlan && step + 1 < VAULT_AGENT_MAX_ROUNDS) {
              stalledRetried = true
              nextBody = {
                question: input.question,
                round: Math.min(requestRound + 1, VAULT_AGENT_MAX_ROUNDS - 1),
                sessionId: this.sessionId,
                previousResponseId,
                toolOutputs: [],
                retryHint: 'stalled',
              }
              continue
            }
            return text
          }
          throw new Error('native: empty step')
        }
        throw new Error('native: no final text')
      } catch {
        // 静默回退散文协议；已获得的工具结果保留在 toolResults 里继续可用。
        nativeChannelFailed = true
        return null
      }
    }
    if (nativeEligible) {
      pendingNativeText = await runNativeChannel()
    }
    for (let round = 0; round < VAULT_AGENT_MAX_ROUNDS; round++) {
      if (round > 0) {
        // 纠正原因对用户可见：让"为什么又跑了一轮"不再是黑盒(0.7.53)。
        if (pendingRetryReason) {
          this.activityStep(
            `🧭 ${
              pendingRetryReason === 'empty_response'
                ? '上一轮没有内容，要求重新回答'
                : pendingRetryReason === 'missing_tool_use'
                  ? '要求 AI 实际调用本机工具，不接受口头承诺'
                  : pendingRetryReason === 'invalid_plan'
                    ? '方案未过本机检查，要求重新核对生成'
                    : pendingRetryReason === 'unexpected_plan'
                      ? '本轮只读，已退回越界的写入方案'
                      : pendingRetryReason === 'deferred_answer'
                        ? '拒绝「稍后处理」，要求当场完成'
                        : pendingRetryReason === 'stalled_write_flow'
                          ? '改档案必须先读原文，已退回重做'
                          : '要求补齐缺失信息后再收尾'
            }`,
            `第 ${round + 1}/${VAULT_AGENT_MAX_ROUNDS} 轮 · 继续翻阅 Vault…`,
          )
        } else {
          this.activityCurrent(`第 ${round + 1}/${VAULT_AGENT_MAX_ROUNDS} 轮 · 继续翻阅 Vault…`)
        }
      }
      const vaultAgentRequest = {
        enabled: true as const,
        vaultAccess: input.vaultAccess,
        intent,
        round,
        canRequestTools: round < VAULT_AGENT_MAX_ROUNDS - 1 && !toolBudgetExhausted,
        retryReason: pendingRetryReason,
        toolResults,
        // v0.7.35+：跨轮任务状态只传目标与阶段元数据；正文和片段绝不进请求。
        pendingTask: this.pendingVaultTask
          ? {
              goal: this.pendingVaultTask.goal,
              stage: this.pendingVaultTask.stage,
              targetFilename: this.pendingVaultTask.targetPath?.split('/').at(-1),
              candidateFilenames: this.pendingVaultTask.candidatePaths
                .map((path) => path.split('/').at(-1) ?? path)
                .slice(0, 8),
            }
          : undefined,
      }
      if (pendingNativeText !== null) {
        // 原生通道已拿到最终文本：跳过本轮模型调用，直接进入共用收尾管线。
        lastText = pendingNativeText
        pendingNativeText = null
      } else if (round === 0 && intent === 'auto') {
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

      // v0.7.35+：首轮不挂云端写工具（换回 Luna 完整推理）。Luna 判断本轮是
      // 任务/CRM 云端写入时单独输出标记，插件补一轮挂上工具执行——判断轮全
      // 推理、执行轮零推理，两边都拿到各自需要的能力。
      // 0.7.61：round 0 一律认云端标记，不再要求 intent==='auto'。实测(一条龙技能
      // E2E)：创建档案后用户说「继续」进入 CRM 登记，续跑轮继承 organize 意图，
      // 旧门禁把标记当普通文字→强制要 Vault 方案→模型在本地瞎搜「CRM」直到撞
      // 轮次上限。标记本身就是模型对「本轮目的=云端写入」的判断，与意图来源无关。
      if (round === 0 && isCloudToolsTurnRequest(lastText)) {
        this.activityStep('☁️ 判定为云端写入（任务清单 / 客户管理）', '正在执行云端写入…')
        const data = await this.plugin.api('/api/plugin/v1/chat', {
          method: 'POST',
          body: {
            messages: this.messagesForApi(),
            sessionId: this.sessionId,
            stream: false,
            noteContext: input.noteContext,
            authorizedContent: input.authorizedContent,
            noteEdit: input.noteEdit,
            noteImageIntent: input.noteImageIntent,
            localSkill: input.localSkill,
            vaultAgent: { ...vaultAgentRequest, cloudToolsTurn: true },
          },
        })
        const cloudText = typeof data.text === 'string' ? data.text.trim() : ''
        if (!cloudText) throw new Error('云端工具轮没有返回内容，请重试')
        // 0.7.59：只有服务端确认真的执行过写入工具，才算成功。此前仅凭「有文字返回」
        // 就显示「✅ 云端写入轮完成」，模型嘴上说「已登记在 CRM 里」却一个工具都没调时，
        // 用户以为客户录进去了、实际数据库里没有（Alina 2026-08-19 报障）。
        const successfulWriteTools = Array.isArray(data.successfulWriteTools)
          ? (data.successfulWriteTools as unknown[]).filter(
              (name): name is string => typeof name === 'string',
            )
          : []
        if (successfulWriteTools.length === 0) {
          this.activityStep('⚠️ 本轮没有真正写入，已拦下', null)
          return {
            text:
              `${cloudText}\n\n> ⚠️ **这一步没有真正保存。** 插件检查到本轮没有实际写入任务清单或客户管理。` +
              `请把要记的信息再说一次（客户称呼、渠道来源、加微信日期、精准度、意向产品），或到 AI霖子网页版手动录入确认。`,
            sources,
            localSkillRunIds,
          }
        }
        this.activityStep(`✅ 云端写入完成（${successfulWriteTools.length} 项）`, null)
        return { text: cloudText, sources, localSkillRunIds }
      }

      // 0.7.52：模型自主切换文件操作引擎——词表判不准的最终解。round 0 的 auto
      // 判断轮（全推理）认定本句要动文件时输出标记，插件立即转入原生引擎；
      // 引擎失败则回到散文协议并强制工具纠正，绝不接受口头承诺。
      if (round === 0 && intent === 'auto' && !nativeChannelFailed && isVaultNativeTurnRequest(lastText)) {
        this.activityStep('🔁 AI 判定要动文件，切换文件操作引擎', '文件操作引擎启动…')
        const nativeText = await runNativeChannel()
        if (nativeText !== null) {
          lastText = nativeText
        } else {
          this.activityStep('↩️ 文件引擎未完成，回到常规通道继续', null)
          pendingRetryReason = 'missing_tool_use'
          continue
        }
      }
      const toolRequest = extractVaultToolCalls(lastText)
      if (lastText.includes('<<<AI_LINZI_ASK_USER>>>')) {
        return { text: lastText, sources, localSkillRunIds }
      }
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
        // 模型产出方案即视为写入流程，intent 单向升级（用户明确只读除外，下面拦截）。
        if (plan.plan) {
          intent = upgradeVaultIntent(intent, {
            question: input.question,
            sawPlan: true,
            pendingTask: this.pendingVaultTask,
          })
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
        const directArtifactPlan = plan.plan?.operations.length === 1 &&
          plan.plan.operations[0].type === 'create_artifact'
        // 明确的 Vault 文件检索/修改任务至少必须有一条本机工具结果。由当前对话或
        // 已锁定当前笔记直接生成新成品时不强迫空搜 Vault；Luna 需要其他资料时会自行检索。
        // “我现在扫描”或直接猜出的方案都只是口头承诺/幻觉，绝不能结束本轮。
        if (
          input.vaultAccess &&
          toolResults.length === 0 &&
          !directArtifactPlan &&
          (input.intent !== 'auto' || Boolean(plan.plan) || mutationAsk)
        ) {
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            throw new Error('AI 没有实际调用 Vault 工具，已停止这次任务；请重试')
          }
          pendingRetryReason = 'missing_tool_use'
          continue
        }
        const writeOperations = (plan.plan?.operations ?? []).filter(
          (operation): operation is Extract<VaultOrganizePlan['operations'][number], {
            type: 'append_note' | 'replace_note' | 'update_note'
          }> =>
            operation.type === 'append_note' ||
            operation.type === 'replace_note' ||
            operation.type === 'update_note',
        )
        const unverifiedWriteOperations = writeOperations
          .filter((operation) => !verifiedWritePaths.has(operation.path))
          .slice(0, VAULT_AGENT_MAX_CALLS_PER_ROUND)
        if (unverifiedWriteOperations.length > 0) {
          // 模型不能仅凭搜索片段批量修改现有档案。客户端按准确目标分批做只读核验，
          // 全部目标都锁定后才展示一个变更集确认卡。
          const verification = await this.plugin.vaultAgent.executeReadCalls(
            unverifiedWriteOperations.map((operation, index) => ({
              id: `verify-write-target-${round}-${index + 1}`,
              name: 'read_note' as const,
              arguments: { path: operation.path, offset: 0, maxChars: 16_000 },
            })),
          )
          appendToolResults(verification.results)
          sources.push(...verification.sources)
          for (const [index, operation] of unverifiedWriteOperations.entries()) {
            if (!verification.results[index]?.ok) continue
            verifiedWritePaths.add(operation.path)
            const stat = this.plugin.vaultFileStat(operation.path)
            if (stat) updateTask({ type: 'read', snapshot: stat, isTarget: true })
            this.activityStep(`🔎 核对目标档案原文：${operation.path.split('/').at(-1)}`)
          }
          pendingRetryReason = undefined
          continue
        }
        if (plan.plan) {
          try {
            await this.plugin.vaultAgent.preflightPlan(plan.plan, input.localSkillContext)
            this.activityStep('📋 已生成整理方案，等待你确认', null)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
              throw new Error(`方案未通过本机预检：${message}`)
            }
            toolResults.push({
              callId: `preflight-write-plan-${round + 1}`,
              name: 'read_note',
              ok: false,
              output:
                `方案未通过本机预检：${message}。` +
                '请先用 list_folder/vault_search/read_note 核对真实路径、现状与目标原文，' +
                '再重新生成方案；不要原样重复上一份方案。',
            })
            pendingRetryReason = 'invalid_plan'
            continue
          }
        }
        if (intent === 'organize' && !plan.plan) {
          // 阶段 A：写入流程的结构化判定优先于文字匹配。已搜到目标却没读原文
          // 就收尾 → stalled_write_flow；完全没动工具 → missing_tool_use。
          const stalled = vaultWriteFlowRetryReason(
            this.pendingVaultTask,
            intent,
            false,
            false,
          )
          if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
            throw new Error(
              '这次没做成：AI 没能给出可确认的整理方案。请缩小范围（一次只处理一个文件夹或一份文件）后再试一次。',
            )
          }
          pendingRetryReason = stalled ?? pendingRetryReason
          continue
        }
        if (intent === 'answer' || intent === 'auto') {
          const retryReason =
            vaultAutoAnswerRetryReason(lastText, toolResults.length > 0) ??
            vaultAnswerRetryReason(input.question, lastText)
          if (retryReason) {
            if (round >= VAULT_AGENT_MAX_ROUNDS - 1) {
              throw new Error(
                retryReason === 'deferred_answer'
                  ? '这次没做成：AI 一直说「接下来去读/去写」，但始终没真的动文件。' +
                    '请把目标说得更具体（点名文件夹或文件名），或者分两步——先让它找到文件，再让它写。'
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
        // 合法终态：产出通过预检的方案卡 → 任务停在 previewed 等用户确认；
        // 纯问答正常收尾 → 任务结清。两种情况都不把中间状态带进下一轮新话题。
        if (plan.plan) {
          const planTarget = plan.plan.operations.length === 1 &&
            (plan.plan.operations[0].type === 'append_note' ||
              plan.plan.operations[0].type === 'replace_note' ||
              plan.plan.operations[0].type === 'update_note' ||
              plan.plan.operations[0].type === 'create_note')
            ? plan.plan.operations[0].path
            : undefined
          if (planTarget) updateTask({ type: 'previewed', targetPath: planTarget })
        } else {
          if (
            this.pendingVaultTask &&
            this.pendingVaultTask.intent === 'organize' &&
            this.pendingVaultTask.stage !== 'previewed'
          ) {
            // 整理类任务以「缺信息反问」等只读方式合法收尾：保留任务与已探明的
            // 候选/来源（30 分钟过期兜底），用户下一句「全部整理/继续」由承接机制
            // 补齐 intent 与上下文。此前这里无条件清空，导致续跑轮失忆、空承诺
            // 循环（阿正 No.153 案，工单第七节 08-18 追记）。
          } else {
            if (
              this.pendingVaultTask &&
              !taskContinuation &&
              this.pendingVaultTask.stage === 'previewed'
            ) {
              // 用户转向新话题：轻提示旧任务已放下，确认卡仍在对话里可点。
              new Notice(
                `上一项「${this.pendingVaultTask.goal.slice(0, 18)}…」还没确认写入；确认卡仍在对话中，需要继续时再说一声。`,
                6000,
              )
            }
            this.pendingVaultTask = null
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
        const localSkillExecutor = await this.plugin.getLocalSkillExecutor()
        const prepared = localSkillExecutor.prepare(call.arguments)
        if (!prepared.ok) throw new Error(`AI 提出的本地动作不安全：${prepared.error}`)
        const action = prepared.action
        const ok = await confirmLocalSkillAction(
          this.app,
          input.localSkill?.name ?? '我的 Skill',
          action,
        )
        if (!ok) {
          const record = localSkillExecutor.cancelledRecord(
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
        this.activityStep(`🧩 本地动作：${action.label}`, `正在本机执行：${action.label}…`)
        const notice = new Notice(`正在本机执行：${action.label}…`, 0)
        try {
          try {
            const executed = await localSkillExecutor.run(
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
            const failed = localSkillExecutor.failedRecord(
              input.localSkill?.name ?? '我的 Skill',
              action,
            )
            await this.plugin.recordLocalSkillRun(failed)
            localSkillRunIds.push(failed.id)
            const safeError = localSkillExecutor.safeError(
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
      // 用户可见的真实进度：每个动作实时滚动进对话区活动流(0.7.53)。
      for (const call of readCalls) {
        const result = executed.results.find((item) => item.callId === call.id)
        if (!result?.ok) continue
        if (call.name === 'read_note' && typeof call.arguments.path === 'string') {
          const path = call.arguments.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
          verifiedWritePaths.add(path)
          const stat = this.plugin.vaultFileStat(path)
          if (stat) {
            updateTask({
              type: 'read',
              snapshot: stat,
              isTarget: path === this.pendingVaultTask?.targetPath,
            })
          }
          this.activityStep(`📄 读取 ${path.split('/').at(-1) ?? path}`)
        }
        if (call.name === 'vault_search') {
          const hitPaths = executed.sources
            .filter((source) => source.sourceId === call.id)
            .map((source) => source.path)
          if (hitPaths.length > 0) updateTask({ type: 'search', candidatePaths: hitPaths })
          const query = typeof call.arguments.query === 'string' ? call.arguments.query : ''
          this.activityStep(`🔍 搜索「${query.slice(0, 24)}」→ ${hitPaths.length} 个相关文件`)
        }
        if (call.name === 'list_folder') {
          // 0.7.54：与原生引擎对齐——list_folder 也算真实探查，必须推进任务，
          // 否则「收尾必须出方案」的结构化纠正因任务不存在而失效。此前这条
          // 0.7.49 的修复只打在原生引擎上，散文回退引擎（网络异常时启用）仍会
          // 让模型把方案写成文字目录树而不出确认卡。
          updateTask({ type: 'search', candidatePaths: [] })
          const folder =
            typeof call.arguments.path === 'string' && call.arguments.path.trim()
              ? call.arguments.path.trim()
              : 'Vault 根目录'
          this.activityStep(`📁 查看 ${folder}`)
        }
        if (call.name === 'read_skill_file' && typeof call.arguments.path === 'string') {
          this.activityStep(`🧩 读取技能文件 ${call.arguments.path.split('/').at(-1)}`)
        }
      }
      pendingRetryReason = undefined
      appendToolResults(executed.results)
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
      /** v0.7.35+：跨轮任务元数据（不含正文与本地完整路径层级细节）。 */
      pendingTask?: {
        goal: string
        stage: PendingVaultTask['stage']
        targetFilename?: string
        candidateFilenames: string[]
      }
      /** v0.7.35+：云端任务/CRM 工具执行轮标记。 */
      cloudToolsTurn?: boolean
    },
    skillCreator = false,
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
          mediaType: imageMediaTypeFromDataUrl(image.dataUrl),
        })),
        vaultSearch,
        noteEdit,
        noteImageIntent,
        localSkill,
        vaultAgent,
        skillCreator: skillCreator ? { mode: 'create' } : undefined,
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
  private renderCreateLocalSkillOffers(
    row: HTMLElement,
    blocks: CreateLocalSkillBlock[],
    message: WireMessage,
  ) {
    for (const block of blocks) {
      const root = this.localSkills.root()
      const skillRoot = normalizePath(`${root}/${block.name}`)
      const files = block.files
      const filePath = normalizePath(`${skillRoot}/SKILL.md`)
      const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
      card.createDiv({
        text: `🧩 待创建 AI 工作流:${block.name}`,
        cls: 'ai-linzi-create-note-title',
      })
      card.createDiv({ text: block.description, cls: 'ai-linzi-create-note-preview' })
      const manifest = skillBlockManifest(block)
      card.createDiv({
        text: `保存位置:${skillRoot}/（版本 ${manifest.version} · 共 ${files.length} 个文件）`,
        cls: 'ai-linzi-create-note-preview',
      })
      const permissionCard = card.createDiv({ cls: 'ai-linzi-skill-permissions' })
      permissionCard.createEl('strong', { text: '权限清单' })
      const permissions = permissionCard.createEl('ul')
      for (const permission of manifest.permissions) permissions.createEl('li', { text: permission })
      if (message.skillCreatorResult && !manifest.valid) {
        const invalid = card.createDiv({ cls: 'ai-linzi-create-note-preview' })
        invalid.createEl('strong', { text: '⚠️ Skill 包未通过本机校验' })
        const problems = invalid.createEl('ul')
        for (const problem of manifest.problems) problems.createEl('li', { text: problem })
      }
      for (const file of files) {
        const details = card.createEl('details')
        details.createEl('summary', { text: `查看 ${file.path}` })
        details.createEl('pre', { text: file.content, cls: 'ai-linzi-vault-write-preview' })
      }
      const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
      if (message.skillCreatorResult && !manifest.valid) {
        actionsRow.createSpan({
          text: '本次不允许安装，请让 AI霖子重新生成完整 Skill 包。',
          cls: 'ai-linzi-create-note-done',
        })
        continue
      }
      if (message.createdLocalSkill?.root === skillRoot) {
        actionsRow.createSpan({ text: '✅ 已创建', cls: 'ai-linzi-create-note-done' })
        const open = actionsRow.createEl('button', { text: '打开 SKILL.md' })
        open.onclick = () => void this.app.workspace.openLinkText(message.createdLocalSkill?.entry ?? filePath, '', false)
        const test = actionsRow.createEl('button', { text: '立即试运行' })
        test.onclick = () => {
          this.inputEl.value = message.skillStudioTestInput?.trim() || `用 ${block.name} Skill 处理当前笔记`
          this.inputEl.focus()
        }
        const share = actionsRow.createEl('button', { text: '导出分享 ZIP' })
        share.onclick = () => {
          share.disabled = true
          void (async () => {
            try {
              const file = await exportSkillBundle(
                this.app,
                this.plugin.settings.outputFolder,
                block,
              )
              new Notice(`✅ 已导出可分享 Skill：${file.path}`, 7000)
              share.disabled = false
            } catch (error) {
              share.disabled = false
              new Notice(`导出失败：${error instanceof Error ? error.message : String(error)}`, 8000)
            }
          })()
        }
        continue
      }
      const createBtn = actionsRow.createEl('button', {
        text: files.length === 1 ? '创建 SKILL.md' : `创建完整 Skill（${files.length} 个文件）`,
      })
      createBtn.onclick = () => {
        createBtn.disabled = true
        void (async () => {
          try {
            const created = await createLocalSkillBundleAtomically(this.app, root, block)
            const entry = created.files.find((file) => file.path === filePath) ?? created.files[0]
            message.createdLocalSkill = { root: created.root, entry: entry.path }
            await this.persistNow()
            this.renderMessages()
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
    const trashOperations = plan.operations.filter(
      (operation): operation is Extract<(typeof plan.operations)[number], { type: 'trash_note' }> =>
        operation.type === 'trash_note',
    )
    // 全部操作都是移入回收站才算删除卡（v0.7.42 起支持批量）；混排方案预检就会被拒。
    const trashOnlyPlan = trashOperations.length > 0 &&
      trashOperations.length === plan.operations.length
    const onlyOperation = plan.operations.length === 1 ? plan.operations[0] : null
    const noteWriteOperations = plan.operations.filter(
      (operation): operation is Extract<
        (typeof plan.operations)[number],
        { type: 'create_note' | 'append_note' | 'replace_note' | 'update_note' }
      > =>
        operation.type === 'create_note' ||
        operation.type === 'append_note' ||
        operation.type === 'replace_note' ||
        operation.type === 'update_note',
    )
    const noteWritePlan = noteWriteOperations.length > 0
    const artifactOperation = onlyOperation?.type === 'create_artifact'
      ? onlyOperation
      : null
    const artifactPath = artifactOperation
      ? resolveArtifactPath(artifactOperation.path, this.plugin.settings.outputFolder)
      : null
    card.createDiv({
      text: `${trashOnlyPlan ? '🗑️' : noteWritePlan ? '📝' : artifactOperation ? '📦' : '🗂️'} 待确认：${plan.title}`,
      cls: 'ai-linzi-create-note-title',
    })
    if (plan.summary) {
      card.createDiv({ text: plan.summary, cls: 'ai-linzi-create-note-preview' })
    }
    const operations = card.createEl('ol', { cls: 'ai-linzi-vault-plan-operations' })
    for (const operation of plan.operations) {
      const item = operations.createEl('li')
      item.createDiv({
        text: operation.type === 'create_artifact'
          ? `生成 ${artifactFormatLabel(operation.format)}：${resolveArtifactPath(operation.path, this.plugin.settings.outputFolder)}`
          : operationLabel(operation),
      })
      if (operation.reason) item.createEl('small', { text: operation.reason })
      if (operation.type === 'trash_note') {
        const target = this.plugin.app.vault.getAbstractFileByPath(operation.path)
        if (target instanceof TFolder) {
          item.createEl('small', {
            text: `文件夹 · 含 ${countFilesInside(target)} 个文件，将整夹移入回收站`,
          })
        }
      }
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
      } else if (operation.type === 'create_artifact') {
        const estimate = estimateArtifactUnits(operation)
        item.createEl('small', {
          text: `格式：${artifactFormatLabel(operation.format)} · 主题：${operation.theme === 'clean' ? '简洁' : 'AI霖子品牌'} · 预计 ${estimate.count} ${estimate.label}`,
        })
        const details = item.createEl('details')
        details.createEl('summary', { text: '查看成品内容全文' })
        details.createEl('pre', {
          text: operation.content,
          cls: 'ai-linzi-vault-write-preview',
        })
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
    if (message.vaultExecuteError && !record) {
      card.createDiv({
        text:
          `⚠️ 上次执行失败：${message.vaultExecuteError.message}` +
          '（失败原因已反馈给 AI，直接说「重新生成方案」即可修正）',
        cls: 'ai-linzi-vault-plan-note',
      })
    }
    const actions = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
    if (record) {
      const trashedCount = record.trashedNotes?.length ?? 0
      const createdNoteCount = record.createdNotes?.length ?? 0
      const updatedNoteCount = record.updatedNotes?.length ?? 0
      const writtenNoteCount = createdNoteCount + updatedNoteCount
      const createdArtifact = record.createdArtifacts?.[0]
      actions.createSpan({
        text: trashedCount > 0
          ? trashedCount === 1
            ? `✅ 已移入回收站：${record.trashedNotes?.[0]}`
            : `✅ 已移入回收站 ${trashedCount} 项`
          : writtenNoteCount > 1
            ? `✅ 已完成 Markdown 变更集：新建 ${createdNoteCount} 篇，更新 ${updatedNoteCount} 篇`
            : createdNoteCount === 1
              ? `✅ 已新建笔记：${record.createdNotes?.[0]}`
              : updatedNoteCount === 1
                ? `✅ 已更新笔记：${record.updatedNotes?.[0]}`
              : createdArtifact
                ? `✅ 已生成成品：${createdArtifact}`
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
      text: trashOnlyPlan
        ? trashOperations.length > 1
          ? `移入回收站（${trashOperations.length} 项）`
          : '移入回收站'
        : noteWritePlan
          ? noteWriteOperations.length === 1 && noteWriteOperations[0].type === 'create_note'
            ? '确认新建笔记'
            : `确认写入 ${noteWriteOperations.length} 篇`
          : artifactOperation
            ? `确认生成 ${artifactFormatLabel(artifactOperation.format)}`
          : `确认执行 ${plan.operations.length} 项`,
      cls: 'mod-cta',
    })
    executeBtn.onclick = () => {
      executeBtn.disabled = true
      void (async () => {
        try {
          const ok = await confirmAction(this.app, trashOnlyPlan
            ? {
                title: '再次确认移入回收站',
                message:
                  (trashOperations.length === 1
                    ? `即将把「${trashOperations[0].path}」移入废纸篓/回收站。`
                    : `即将把以下 ${trashOperations.length} 项移入废纸篓/回收站：\n` +
                      trashOperations.slice(0, 10).map((operation) => `· ${operation.path}`).join('\n') +
                      (trashOperations.length > 10 ? `\n…等共 ${trashOperations.length} 项。` : '')) +
                  '\n插件不会永久删除；需要恢复时请到系统废纸篓/回收站（或 Obsidian .trash）操作。',
                confirmLabel: trashOperations.length > 1
                  ? `确认移入回收站（${trashOperations.length} 项）`
                  : '确认移入回收站',
              }
            : noteWritePlan
              ? {
                  title: noteWriteOperations.length === 1 && noteWriteOperations[0].type === 'create_note'
                    ? '再次确认新建笔记'
                    : '再次确认 Markdown 变更集',
                  message:
                    `即将写入以下 ${noteWriteOperations.length} 篇 Markdown：\n` +
                    noteWriteOperations.map((operation) => `· ${operation.path}`).join('\n') +
                    (plan.operations.length > noteWriteOperations.length
                      ? `\n\n同时执行另外 ${plan.operations.length - noteWriteOperations.length} 项文件夹或移动操作。`
                      : '') +
                    '\n\n每篇目标和修改前版本都已锁定，上方可逐篇展开查看完整内容或差异。' +
                    '缺少的父目录会同时创建；目标冲突或确认后文件发生变化就停止。' +
                    '\n执行中任意一步失败，插件会自动恢复本次已改内容并清理本次新建文件。',
                  confirmLabel: noteWriteOperations.length === 1 && noteWriteOperations[0].type === 'create_note'
                    ? '确认新建'
                    : `确认写入 ${noteWriteOperations.length} 篇`,
                }
              : artifactOperation
                ? {
                    title: `再次确认生成 ${artifactFormatLabel(artifactOperation.format)}`,
                    message:
                      `目标路径：${artifactPath}\n\n` +
                      `插件将在本机把上方预览内容渲染成 ${artifactFormatLabel(artifactOperation.format)} 文件。` +
                      '缺少的父目录会同时创建；如果目标已存在就停止，绝不覆盖。' +
                      '\n如需移除，请在 Obsidian 中把成品移入回收站。',
                    confirmLabel: '确认生成',
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
          message.vaultExecuteError = undefined
          // 确认卡已执行 → 跨轮任务结清；下一句「继续」不再重新进入旧写入流程。
          this.pendingVaultTask = null
          const writtenPaths = [
            ...(applied.createdNotes ?? []),
            ...(applied.updatedNotes ?? []),
          ]
          if (writtenPaths.length === 1) {
            const writtenPath = writtenPaths[0]
            const profile = await readLocalCustomerProfile(this.app, writtenPath)
            if (profile) message.customerCrmSyncPath = writtenPath
          }
          await this.persistNow()
          this.renderMessages()
          new Notice(
            (applied.trashedNotes?.length ?? 0) > 0
              ? (applied.trashedNotes?.length ?? 0) === 1
                ? `✅ 已把「${applied.trashedNotes?.[0]}」移入回收站`
                : `✅ 已把 ${applied.trashedNotes?.length} 项移入回收站`
              : writtenPaths.length > 1
                ? `✅ 已完成 Markdown 变更集：新建 ${applied.createdNotes?.length ?? 0} 篇，更新 ${applied.updatedNotes?.length ?? 0} 篇`
                : (applied.createdNotes?.length ?? 0) > 0
                  ? `✅ 已新建笔记「${applied.createdNotes?.[0]}」`
                  : (applied.updatedNotes?.length ?? 0) > 0
                    ? `✅ 已更新笔记「${applied.updatedNotes?.[0]}」`
                : (applied.createdArtifacts?.length ?? 0) > 0
                  ? `✅ 已生成成品「${applied.createdArtifacts?.[0]}」`
              : `✅ 已完成「${plan.title}」：移动/重命名 ${applied.moves.length} 项，新建文件夹 ${applied.createdFolders.length} 个`,
            7000,
          )
        } catch (error) {
          executeBtn.disabled = false
          const failureMessage = error instanceof Error ? error.message : String(error)
          // 失败必须让模型知道：写进本机消息卡片，并挂到跨轮任务上，
          // 下一轮开场作为合成工具结果交回（见 runVaultAgentLoop 开头）。
          const now = Date.now()
          message.vaultExecuteError = { message: failureMessage, at: now }
          const lastExecuteError = { planTitle: plan.title, message: failureMessage, at: now }
          this.pendingVaultTask = this.pendingVaultTask
            ? { ...this.pendingVaultTask, intent: 'organize', lastExecuteError, updatedAt: now }
            : {
                id: `vault-task-${now}-${Math.random().toString(36).slice(2, 8)}`,
                goal: `执行整理方案「${plan.title.slice(0, 60)}」`,
                intent: 'organize',
                stage: 'searched',
                candidatePaths: [],
                sourcePaths: [],
                lastExecuteError,
                createdAt: now,
                updatedAt: now,
              }
          await this.persistNow()
          this.renderMessages()
          new Notice(`执行失败：${failureMessage}`, 9000)
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

  private renderVaultQuestionOffer(row: HTMLElement, message: WireMessage): void {
    const question = message.vaultQuestion
    if (!question) return
    const card = row.createDiv({ cls: 'ai-linzi-vault-question-card' })
    card.createDiv({
      text: question.answeredAt ? '✅ 已补充信息，任务已继续' : '回答后会从刚才停下的位置继续',
      cls: 'ai-linzi-vault-question-hint',
    })
    if (question.answeredAt) return
    if (question.options.length > 0) {
      const actions = card.createDiv({ cls: 'ai-linzi-vault-question-options' })
      for (const option of question.options) {
        const button = actions.createEl('button', { text: option })
        button.onclick = () => {
          this.inputEl.value = option
          this.inputEl.focus()
        }
      }
    }
    if (question.allowFreeText) {
      card.createDiv({ text: '也可以直接在输入框补充你的答案。', cls: 'ai-linzi-vault-question-hint' })
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
      if (m.localSkillStatus) {
        // 活动流/技能状态条：区别于正文气泡的紧凑样式；进行中(⚙️开头)带持续动效。
        row.addClass('ai-linzi-status-row')
        if (text.startsWith('⚙️')) row.addClass('ai-linzi-status-working')
      }
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
        void MarkdownRenderer.render(this.app, patch?.displayText ?? cleanText, body, '', this)
        if (m.vaultQuestion) this.renderVaultQuestionOffer(row, m)
        if ((m.vaultSources?.length ?? 0) > 0) this.renderVaultSources(row, m.vaultSources ?? [])
        if ((m.localSkillRunIds?.length ?? 0) > 0) this.renderLocalSkillRunOffer(row, m)
        if (localSkillCreateResult.blocks.length > 0) {
          this.renderCreateLocalSkillOffers(row, localSkillCreateResult.blocks, m)
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

    new Setting(containerEl).setName('小红书卡片').setHeading()

    new Setting(containerEl)
      .setName('默认卡片风格')
      .setDesc('「小红书图文卡片」和「多平台分发」的卡片版式。每次生成时也会弹选择卡,可临时换,换了会记住。')
      .addDropdown((d) => {
        for (const style of XHS_CARD_STYLES) d.addOption(style.id, style.name)
        d.setValue(getXhsCardStyle(this.plugin.settings.xhsCardStyleId).id)
        d.onChange(async (v) => {
          this.plugin.settings.xhsCardStyleId = getXhsCardStyle(v).id
          await this.plugin.saveSettings()
        })
      })

    new Setting(containerEl)
      .setName('X 推文风 · 昵称')
      .setDesc('显示在卡片头像旁。生成时选择卡里也能填。')
      .addText((t) =>
        t.setValue(this.plugin.settings.xhsCardNickname).onChange(async (v) => {
          this.plugin.settings.xhsCardNickname = v.trim()
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('X 推文风 · @账号')
      .setDesc('昵称下方的账号标识,不用带 @。')
      .addText((t) =>
        t.setValue(this.plugin.settings.xhsCardHandle).onChange(async (v) => {
          this.plugin.settings.xhsCardHandle = v.trim().replace(/^@+/, '')
          await this.plugin.saveSettings()
        }),
      )

    const avatarSetting = new Setting(containerEl).setName('X 推文风 · 头像(可选)')
    avatarSetting.setDesc(
      this.plugin.settings.xhsCardAvatarPath
        ? `当前:${this.plugin.settings.xhsCardAvatarPath}`
        : '不设置则用昵称首字的蓝色圆标。图片只保存在你的 Vault,生成卡片时在本机绘制。',
    )
    avatarSetting.addButton((b) =>
      b.setButtonText('从 Vault 选择').onClick(() => {
        new VaultImageBrowserModal(this.app, async (file) => {
          this.plugin.settings.xhsCardAvatarPath = file.path
          await this.plugin.saveSettings()
          this.display()
        }).open()
      }),
    )
    avatarSetting.addButton((b) =>
      b.setButtonText('从电脑上传').onClick(() => {
        chooseXhsAvatarFile(async (file) => {
          try {
            this.plugin.settings.xhsCardAvatarPath = await saveXhsAvatarToVault(this.plugin, file)
            await this.plugin.saveSettings()
            this.display()
            new Notice('✅ 头像已保存到你的 Vault,生成卡片时在本机绘制,不会上传')
          } catch (error) {
            new Notice(`头像保存失败:${error instanceof Error ? error.message : String(error)}`, 8000)
          }
        })
      }),
    )
    avatarSetting.addButton((b) =>
      b.setButtonText('清除').onClick(async () => {
        this.plugin.settings.xhsCardAvatarPath = ''
        await this.plugin.saveSettings()
        this.display()
      }),
    )

    new Setting(containerEl).setName('公众号发布(选配)').setHeading()

    new Setting(containerEl)
      .setName('默认排版主题')
      .setDesc('「一键复制」和「发到草稿箱」的版式。每次排版时也会弹选择卡,可临时换,换了会记住。')
      .addDropdown((d) => {
        for (const theme of WECHAT_THEMES) d.addOption(theme.id, `${theme.name} · ${theme.tagline}`)
        d.setValue(getWechatTheme(this.plugin.settings.wechatThemeId).id)
        d.onChange(async (v) => {
          this.plugin.settings.wechatThemeId = getWechatTheme(v).id
          await this.plugin.saveSettings()
        })
      })

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

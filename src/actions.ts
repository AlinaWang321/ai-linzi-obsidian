/**
 * M2 · 四技能「笔记即输入」+ 一键喂库 + 落盘写入规则
 *
 * 写入铁律(整合定稿 §2.2):只写输出文件夹、只新建不覆盖、frontmatter 落标。
 * 输入上限与服务端 lib/input-limits.ts 对齐,超限先截断并明确告知(透明原则)。
 */
import { App, Modal, Notice, Setting, TFile, normalizePath, requestUrl } from 'obsidian'
import type AiLinziPlugin from './main'
import {
  insertCoverEmbed,
  insertEmbeds,
  prepareWechatArticle,
  stripFrontmatter,
} from './article-format'
import { extractExactTextHints } from './skill-suggest'
import { canonicalContentFields } from './content-state'

// ── 与服务端对齐的常量 ─────────────────────────────

const LIMITS = {
  TOPIC_RADAR_CONTEXT_MAX: 2_000,
  WECHAT_MATERIAL_MAX: 10_000,
  WECHAT_TOPIC_MAX: 5_000,
  SALES_REVIEW_TRANSCRIPT_MIN: 500,
  SALES_REVIEW_TRANSCRIPT_MAX: 50_000,
  DISTRIBUTE_ARTICLE_MIN: 100,
  DISTRIBUTE_ARTICLE_MAX: 20_000,
  KB_SUGGEST_TEXT_MAX: 8_000,
  KB_APPEND_CONTENT_MAX: 2_000,
}

/** 知识库 9 个可建议章节(writing_style 由专门技能生成,不进列表) */
const KB_SECTIONS: { key: string; title: string }[] = [
  { key: 'about', title: '关于我' },
  { key: 'positioning', title: '商业定位' },
  { key: 'offerings', title: '产品/服务' },
  { key: 'customers', title: '客户画像' },
  { key: 'methodology', title: '方法论' },
  { key: 'signature_phrases', title: '金句库' },
  { key: 'story', title: '我的故事' },
  { key: 'content_archive', title: '素材库' },
  { key: 'faq', title: 'FAQ' },
]

// ── 小工具 ─────────────────────────────────────────

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
}

function isoDate(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function contentId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `ailinzi-${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeTitle(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/** 超限截断 + 明确告知(输入限制透明原则) */
function clip(text: string, max: number, what: string): string {
  if (text.length <= max) return text
  new Notice(`⚠️ ${what}共 ${text.length} 字,超过上限 ${max} 字——已截取前 ${max} 字发送`, 6000)
  return text.slice(0, max)
}

async function getActiveNote(plugin: AiLinziPlugin): Promise<{ file: TFile; text: string } | null> {
  const app = plugin.app
  // 对话面板获得焦点时 getActiveFile() 为 null → 回落到最近激活的笔记
  const file = app.workspace.getActiveFile() ?? plugin.lastActiveFile
  if (!file) {
    new Notice('请先打开一篇笔记再运行技能')
    return null
  }
  const text = (await app.vault.cachedRead(file)).trim()
  if (!text) {
    new Notice('当前笔记是空的,没有可用的内容')
    return null
  }
  return { file, text }
}

// ── 落盘 ─────────────────────────────────────────

interface OutputSpec {
  /** frontmatter 来源技能 */
  skill: string
  /** frontmatter 平台:公众号/小红书/口播/朋友圈/通用/内部 */
  platform: string
  /** 文件名主体(不含日期前缀) */
  title: string
  /** 正文 */
  body: string
  /** 来源笔记(wikilink 关联) */
  sourceNote?: TFile
  /** 文章辅助信息写进 frontmatter，不混入可发布正文 */
  summary?: string
  titleCandidates?: string[]
}

export async function writeOutput(plugin: AiLinziPlugin, spec: OutputSpec): Promise<TFile> {
  const app = plugin.app
  const date = isoDate()
  const canonical = canonicalContentFields({
    skill: spec.skill,
    platform: spec.platform,
    date,
    contentId: contentId(),
  })
  const rootFolder = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
  const contentType = canonical?.['内容类型']
  const folder = normalizePath(
    contentType === '选题'
      ? `${rootFolder}/选题`
      : contentType === '公众号文章'
        ? `${rootFolder}/公众号文章`
        : rootFolder,
  )
  await ensureFolder(plugin, folder)

  const base = `${today()}_${sanitizeTitle(spec.title) || '未命名'}`
  let path = normalizePath(`${folder}/${base}.md`)
  // 只新建不覆盖:重名自动加序号
  for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
    path = normalizePath(`${folder}/${base}_${i}.md`)
  }

  const contentLines = canonical
    ? [
        ...Object.entries(canonical).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
        '公众号草稿箱时间: ',
        '公众号发布日期: ',
        '公众号链接: ',
        '视频生成时间: ',
        '视频发布日期: ',
        '视频链接: ',
        '小红书生成时间: ',
        '小红书发布日期: ',
        '小红书链接: ',
      ]
    : []
  const fm = [
    '---',
    `title: ${JSON.stringify(spec.title)}`,
    `来源技能: ${spec.skill}`,
    `状态: ${canonical?.['内容阶段'] ?? '草稿'}`,
    `平台: ${spec.platform}`,
    `日期: ${date}`,
    ...contentLines,
    spec.summary ? `摘要: ${JSON.stringify(spec.summary)}` : null,
    spec.titleCandidates?.length ? `候选标题: ${JSON.stringify(spec.titleCandidates.slice(0, 5))}` : null,
    spec.sourceNote ? `关联笔记: "[[${spec.sourceNote.basename}]]"` : null,
    `发布日期: `,
    `发布链接: `,
    '---',
    '',
  ]
    .filter((l): l is string => l !== null)
    .join('\n')

  const file = await app.vault.create(path, fm + spec.body.trim() + '\n')
  await app.workspace.getLeaf('tab').openFile(file)
  return file
}

// ── 通用输入弹窗 ────────────────────────────────────

interface PromptField {
  key: string
  label: string
  desc?: string
  initial?: string
  multiline?: boolean
  required?: boolean
}

class PromptModal extends Modal {
  private fields: PromptField[]
  private values: Record<string, string> = {}
  private submitted = false
  private resolve!: (v: Record<string, string> | null) => void
  readonly result: Promise<Record<string, string> | null>

  constructor(app: App, private title: string, private cta: string, fields: PromptField[]) {
    super(app)
    this.fields = fields
    for (const f of fields) this.values[f.key] = f.initial ?? ''
    this.result = new Promise((r) => (this.resolve = r))
    // 构造即打开:调用方 await .result 即可(2026-07-21 修「点技能没反应」——此前忘了 open())
    this.open()
  }

  onOpen() {
    this.titleEl.setText(this.title)
    for (const f of this.fields) {
      const s = new Setting(this.contentEl).setName(f.label)
      if (f.desc) s.setDesc(f.desc)
      if (f.multiline) {
        s.addTextArea((t) => {
          t.setValue(this.values[f.key]).onChange((v) => (this.values[f.key] = v))
          t.inputEl.rows = 4
          t.inputEl.addClass('ai-linzi-full-width')
        })
      } else {
        s.addText((t) => {
          t.setValue(this.values[f.key]).onChange((v) => (this.values[f.key] = v))
          t.inputEl.addClass('ai-linzi-full-width')
        })
      }
    }
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText(this.cta)
        .setCta()
        .onClick(() => {
          for (const f of this.fields) {
            if (f.required && !this.values[f.key].trim()) {
              new Notice(`请填写「${f.label}」`)
              return
            }
          }
          this.submitted = true
          this.resolve({ ...this.values })
          this.close()
        }),
    )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

/** 运行中提示(技能调用 30-120s,给个持续状态) */
function runningNotice(label: string): Notice {
  return new Notice(`🤖 AI霖子「${label}」生成中…(约 1-2 分钟,请勿关闭 Obsidian)`, 0)
}

// ── 四个技能动作 ────────────────────────────────────

export async function runTopicRadar(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return
  // 赛道/定位不再问——AI霖子服务端本来就带着用户档案和知识库(2026-07-21 Alina 反馈)。
  // 只问受众(选填):写给谁看,留空则按定位自动判断。
  const input = await new PromptModal(plugin.app, '选题雷达 · 从当前笔记提炼选题', '生成选题', [
    {
      key: 'audience',
      label: '这批选题主要写给谁看?(选填)',
      desc: '例:想做副业的职场女性。留空则 AI 按你的定位与知识库自动判断。',
      initial: plugin.settings.defaultNiche,
    },
  ]).result
  if (!input) return

  const audience = input.audience.trim()
  plugin.settings.defaultNiche = audience
  await plugin.saveSettings()

  const n = runningNotice('选题雷达')
  try {
    const material = stripFrontmatter(note.text)
    const context = audience ? `这批选题主要写给:${audience}。\n\n参考素材:\n${material}` : material
    const text = await plugin.apiText('/api/plugin/v1/skills/topic-radar', {
      method: 'gap',
      context: clip(context, LIMITS.TOPIC_RADAR_CONTEXT_MAX, '笔记素材'),
    })
    await writeOutput(plugin, {
      skill: '选题雷达',
      platform: '通用',
      title: `选题雷达_${note.file.basename}`,
      body: text,
      sourceNote: note.file,
    })
    new Notice('✅ 选题已生成并落盘')
  } catch (e) {
    new Notice(`❌ 选题雷达:${e instanceof Error ? e.message : String(e)}`, 8000)
  } finally {
    n.hide()
  }
}

export async function runWechatWriter(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return
  const input = await new PromptModal(plugin.app, '公众号写作 · 当前笔记作素材', '开始写作', [
    {
      key: 'topic',
      label: '选题方向',
      desc: '这篇文章要写什么?一句话或一个标题都行。',
      required: true,
    },
  ]).result
  if (!input) return

  const n = runningNotice('公众号写作')
  try {
    const text = await plugin.apiText('/api/plugin/v1/skills/wechat-writer', {
      topic: input.topic.trim().slice(0, LIMITS.WECHAT_TOPIC_MAX),
      material: clip(stripFrontmatter(note.text), LIMITS.WECHAT_MATERIAL_MAX, '笔记素材'),
    })
    const article = prepareWechatArticle(text)
    const articleFile = await writeOutput(plugin, {
      skill: '公众号写作',
      platform: '公众号',
      title: article.titleCandidates[0] || input.topic.trim(),
      body: article.body,
      summary: article.digest,
      titleCandidates: article.titleCandidates,
      sourceNote: note.file,
    })
    const sourceFm = plugin.app.metadataCache.getFileCache(note.file)?.frontmatter
    if (sourceFm?.['内容类型'] === '选题' || sourceFm?.['来源技能'] === '选题雷达') {
      await plugin.app.fileManager.processFrontMatter(note.file, (fm) => {
        fm['状态'] = '已生成草稿'
        fm['内容阶段'] = '已生成草稿'
        fm['关联文章'] = `[[${articleFile.basename}]]`
      })
    }
    new Notice('✅ 公众号文章已生成并落盘')
  } catch (e) {
    new Notice(`❌ 公众号写作:${e instanceof Error ? e.message : String(e)}`, 8000)
  } finally {
    n.hide()
  }
}

export async function runDistribute(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return
  const article = stripFrontmatter(note.text)
  if (article.length < LIMITS.DISTRIBUTE_ARTICLE_MIN) {
    new Notice(`当前笔记只有 ${article.length} 字——分发需要一篇写好的文章(≥100 字)`)
    return
  }

  const n = runningNotice('多平台分发')
  try {
    const data = (await plugin.api('/api/plugin/v1/skills/wechat-distribute', {
      method: 'POST',
      body: { article: clip(article, LIMITS.DISTRIBUTE_ARTICLE_MAX, '文章') },
    })) as {
      results?: { key: string; label: string; text: string }[]
      failed?: string[]
    }
    const platformOf: Record<string, string> = { xhs: '小红书', script: '口播', moments: '朋友圈' }
    for (const r of data.results ?? []) {
      await writeOutput(plugin, {
        skill: '多平台分发',
        platform: platformOf[r.key] ?? r.label,
        title: `${r.label}_${note.file.basename}`,
        body: r.text,
        sourceNote: note.file,
      })
    }
    const okN = data.results?.length ?? 0
    const failMsg = data.failed?.length ? `;失败:${data.failed.join('/')}` : ''
    new Notice(`✅ 分发完成:${okN} 个版本已落盘${failMsg}`, 8000)
  } catch (e) {
    new Notice(`❌ 多平台分发:${e instanceof Error ? e.message : String(e)}`, 8000)
  } finally {
    n.hide()
  }
}

export async function runSalesReview(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return
  const transcript = stripFrontmatter(note.text)
  if (transcript.length < LIMITS.SALES_REVIEW_TRANSCRIPT_MIN) {
    new Notice(`逐字稿只有 ${transcript.length} 字——谈单复盘需要 ≥500 字的完整逐字稿`)
    return
  }
  const input = await new PromptModal(
    plugin.app,
    '谈单复盘 · 诊断当前逐字稿',
    '开始诊断',
    [
      {
        key: 'background',
        label: '客户背景/产品说明(可选)',
        desc: '💡 隐私提醒:逐字稿传输不留存(不进 AI霖子 数据库),但建议先把客户实名换成化名。',
        multiline: true,
      },
    ],
  ).result
  if (input === null) return

  const n = runningNotice('谈单复盘')
  try {
    const text = await plugin.apiText('/api/plugin/v1/skills/sales-review', {
      transcript: clip(transcript, LIMITS.SALES_REVIEW_TRANSCRIPT_MAX, '逐字稿'),
      background: input.background.trim() || undefined,
    })
    await writeOutput(plugin, {
      skill: '谈单复盘',
      platform: '内部',
      title: `谈单复盘_${note.file.basename}`,
      body: text,
      sourceNote: note.file,
    })
    new Notice('✅ 谈单诊断报告已落盘')
  } catch (e) {
    new Notice(`❌ 谈单复盘:${e instanceof Error ? e.message : String(e)}`, 8000)
  } finally {
    n.hide()
  }
}

// ── 一键喂库 ────────────────────────────────────────

class KbConfirmModal extends Modal {
  private sectionKey: string
  private summary: string
  private submitted = false
  private resolve!: (v: { sectionKey: string; content: string } | null) => void
  readonly result: Promise<{ sectionKey: string; content: string } | null>

  constructor(app: App, suggestedKey: string, summary: string) {
    super(app)
    this.sectionKey = suggestedKey
    this.summary = summary
    this.result = new Promise((r) => (this.resolve = r))
    // 构造即打开(同 PromptModal,2026-07-21 修)
    this.open()
  }

  onOpen() {
    this.titleEl.setText('存入 AI霖子 知识库')
    new Setting(this.contentEl)
      .setName('章节')
      .setDesc('AI 已按内容推荐,可手动调整')
      .addDropdown((d) => {
        for (const s of KB_SECTIONS) d.addOption(s.key, s.title)
        d.setValue(this.sectionKey).onChange((v) => (this.sectionKey = v))
      })
    new Setting(this.contentEl)
      .setName('入库内容(AI 已浓缩成第一人称,可编辑)')
      .addTextArea((t) => {
        t.setValue(this.summary).onChange((v) => (this.summary = v))
        t.inputEl.rows = 10
        t.inputEl.addClass('ai-linzi-full-width')
      })
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('存入知识库')
        .setCta()
        .onClick(() => {
          if (!this.summary.trim()) {
            new Notice('入库内容不能为空')
            return
          }
          this.submitted = true
          this.resolve({ sectionKey: this.sectionKey, content: this.summary.trim() })
          this.close()
        }),
    )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

export async function feedKnowledge(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return

  const n = new Notice('🤖 AI 正在阅读笔记、推荐章节…', 0)
  let suggested: { sectionKey?: string; summary?: string }
  try {
    suggested = (await plugin.api('/api/plugin/v1/knowledge/suggest-section', {
      method: 'POST',
      body: {
        text: clip(stripFrontmatter(note.text), LIMITS.KB_SUGGEST_TEXT_MAX, '笔记内容'),
      },
    })) as { sectionKey?: string; summary?: string }
  } catch (e) {
    n.hide()
    new Notice(`❌ 喂库:${e instanceof Error ? e.message : String(e)}`, 8000)
    return
  }
  n.hide()

  const confirmed = await new KbConfirmModal(
    plugin.app,
    suggested.sectionKey ?? 'about',
    (suggested.summary ?? '').slice(0, LIMITS.KB_APPEND_CONTENT_MAX),
  ).result
  if (!confirmed) return

  try {
    const data = (await plugin.api(
      `/api/plugin/v1/knowledge/sections/${confirmed.sectionKey}/append`,
      { method: 'POST', body: { content: confirmed.content } },
    )) as { mode?: string; sectionTitle?: string; newChars?: number; mergedChars?: number }
    const title = data.sectionTitle ?? confirmed.sectionKey
    if (data.mode === 'ai-merge') {
      new Notice(`✅ 已存入「${title}」(AI 自动合并去重,现 ${data.mergedChars} 字)`, 8000)
    } else {
      new Notice(`✅ 已存入「${title}」(现 ${data.newChars} 字)`, 8000)
    }
  } catch (e) {
    // starter_wall(403)/kb_section_full/kb_total_full(422) 的 error 文案服务端已写得很友好,直接透传
    new Notice(`喂库:${e instanceof Error ? e.message : String(e)}`, 10000)
  }
}

// ── 文章配图(学员通用 · 极简小清新手绘人偶) ─────────

const ARTICLE_ILLUSTRATION_API = '/api/plugin/v1/article-illustration'

async function fetchImageBinary(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1)
    const s = atob(b64)
    const u = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
    return u.buffer
  }
  let lastStatus = 0
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await requestUrl({ url, throw: false })
    lastStatus = r.status
    if (r.status === 200 && r.arrayBuffer) return r.arrayBuffer
  }
  throw new Error(`图片下载失败(${lastStatus || '网络异常'})`)
}

async function ensureFolder(plugin: AiLinziPlugin, folder: string): Promise<void> {
  const parts = folder.split('/')
  let cur = ''
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p
    if (!plugin.app.vault.getAbstractFileByPath(cur)) {
      await plugin.app.vault.createFolder(cur).catch(() => {})
    }
  }
}

interface IllustrationPlanItem {
  anchor: string
  title: string
  layout: string
  labels: string[]
  coreIdea: string
  concept: string
}

interface IllustrationPlan {
  cover: { title: string; coreIdea: string; concept: string } | null
  images: IllustrationPlanItem[]
}

interface IllustrationGenerateResult {
  status?: 'complete' | 'partial'
  cover?: { title: string; imageUrl: string } | null
  images?: (IllustrationPlanItem & { imageUrl: string })[]
  failedCount?: number
  failedPlan?: IllustrationPlan | null
  failures?:
    | string[]
    | {
        cover?: string | null
        images?: { anchor?: string; title?: string; reason?: string }[]
      }
  requestId?: string
}

interface SavedIllustrationJob {
  notePath: string
  articleFingerprint: string
  articleTitle: string
  count: number
  pendingPlan: IllustrationPlan
  updatedAt: number
}

const ILLUSTRATION_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function illustrationJobsPath(plugin: AiLinziPlugin): string {
  return `${plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`}/illustration-jobs.json`
}

function illustrationArticleFingerprint(article: string): string {
  const normalized = article
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let hash = 2166136261
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${normalized.length}-${(hash >>> 0).toString(36)}`
}

async function loadIllustrationJobs(plugin: AiLinziPlugin): Promise<SavedIllustrationJob[]> {
  try {
    const raw = await plugin.app.vault.adapter.read(illustrationJobsPath(plugin))
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - ILLUSTRATION_JOB_MAX_AGE_MS
    return parsed.filter(
      (item): item is SavedIllustrationJob =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as SavedIllustrationJob).notePath === 'string' &&
        typeof (item as SavedIllustrationJob).articleFingerprint === 'string' &&
        typeof (item as SavedIllustrationJob).updatedAt === 'number' &&
        (item as SavedIllustrationJob).updatedAt >= cutoff,
    )
  } catch {
    return []
  }
}

async function writeIllustrationJobs(
  plugin: AiLinziPlugin,
  jobs: SavedIllustrationJob[],
): Promise<void> {
  try {
    await plugin.app.vault.adapter.write(illustrationJobsPath(plugin), JSON.stringify(jobs.slice(-20), null, 2))
  } catch (error) {
    console.warn('[ai-linzi] illustration resume state could not be saved', error)
  }
}

async function saveIllustrationJob(plugin: AiLinziPlugin, job: SavedIllustrationJob): Promise<void> {
  const jobs = (await loadIllustrationJobs(plugin)).filter((item) => item.notePath !== job.notePath)
  jobs.push({ ...job, updatedAt: Date.now() })
  await writeIllustrationJobs(plugin, jobs)
}

async function clearIllustrationJob(plugin: AiLinziPlugin, notePath: string): Promise<void> {
  const jobs = await loadIllustrationJobs(plugin)
  const next = jobs.filter((item) => item.notePath !== notePath)
  if (next.length !== jobs.length) await writeIllustrationJobs(plugin, next)
}

function illustrationFailureMessages(result: IllustrationGenerateResult | null): string[] {
  const failures = result?.failures
  if (!failures) return []
  if (Array.isArray(failures)) return failures.filter(Boolean)
  const messages: string[] = []
  if (failures.cover) messages.push(`封面：${failures.cover}`)
  for (const item of failures.images ?? []) {
    if (item.reason) messages.push(`${item.title || item.anchor || '正文插图'}：${item.reason}`)
  }
  return messages
}

class IllustrationPlanModal extends Modal {
  private submitted = false
  private resolve!: (value: IllustrationPlan | null) => void
  readonly result: Promise<IllustrationPlan | null>

  constructor(app: App, private plan: IllustrationPlan, private estimatedCredits?: number) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  onOpen() {
    this.titleEl.setText('确认配图方案')
    this.contentEl.createEl('p', {
      text: `先确认每张图讲什么、放哪里、写哪些原文词，再开始生图${this.estimatedCredits ? `（预计最多 ${this.estimatedCredits} 积分）` : ''}。取消不会生成图片。`,
      cls: 'ai-linzi-plan-intro',
    })
    if (this.plan.cover) {
      const card = this.contentEl.createDiv({ cls: 'ai-linzi-plan-card' })
      card.createEl('strong', { text: `封面 · ${this.plan.cover.title}` })
      card.createEl('p', { text: this.plan.cover.coreIdea })
    }
    this.plan.images.forEach((item, index) => {
      const card = this.contentEl.createDiv({ cls: 'ai-linzi-plan-card' })
      card.createEl('strong', { text: `${index + 1}. ${item.title}` })
      card.createEl('p', { text: `放在「${item.anchor}」之后` })
      card.createEl('p', { text: `核心意思：${item.coreIdea}` })
      card.createEl('p', { text: `画面大字：${item.labels.length ? item.labels.join(' / ') : '无文字，靠场景表达'}` })
    })
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('取消').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText('确认并开始生图')
          .setCta()
          .onClick(() => {
            this.submitted = true
            this.resolve(this.plan)
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

class IllustrationResumeModal extends Modal {
  private submitted = false
  private resolve!: (value: 'resume' | 'restart' | null) => void
  readonly result: Promise<'resume' | 'restart' | null>

  constructor(app: App, private remaining: number) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  onOpen() {
    this.titleEl.setText('继续上次未完成的配图?')
    this.contentEl.createEl('p', {
      text: `检测到这篇文章还有 ${this.remaining} 张图片未完成。继续补图不会重新生成方案，也不会重做已经成功的图片。`,
      cls: 'ai-linzi-plan-intro',
    })
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('重新规划').onClick(() => {
          this.submitted = true
          this.resolve('restart')
          this.close()
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('继续补图')
          .setCta()
          .onClick(() => {
            this.submitted = true
            this.resolve('resume')
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

function uniqueVaultPath(plugin: AiLinziPlugin, desired: string): string {
  if (!plugin.app.vault.getAbstractFileByPath(desired)) return desired
  const dot = desired.lastIndexOf('.')
  const base = dot >= 0 ? desired.slice(0, dot) : desired
  const ext = dot >= 0 ? desired.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}${ext}`
    if (!plugin.app.vault.getAbstractFileByPath(candidate)) return candidate
  }
}

export async function runArticleIllustration(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return
  const prepared = prepareWechatArticle(note.text)
  const article = prepared.body
  const articleTitle =
    prepared.titleCandidates[0]?.trim() ||
    note.file.basename.replace(/^\d{4}[.-]\d{1,2}[.-]\d{1,2}_?/, '').trim()
  if (article.length < 300) {
    new Notice(`文章只有 ${article.length} 字——配图需要至少 300 字的成稿`)
    return
  }
  const fingerprint = illustrationArticleFingerprint(article)
  const resumable = (await loadIllustrationJobs(plugin)).find(
    (job) => job.notePath === note.file.path && job.articleFingerprint === fingerprint,
  )
  let count = 3
  let confirmed: IllustrationPlan | null = null
  let planning: Notice | null = null

  try {
    if (resumable) {
      const remaining = resumable.pendingPlan.images.length + (resumable.pendingPlan.cover ? 1 : 0)
      const choice = await new IllustrationResumeModal(plugin.app, remaining).result
      if (!choice) return
      if (choice === 'resume') {
        count = resumable.count
        confirmed = resumable.pendingPlan
        new Notice(`继续补齐上次未完成的 ${remaining} 张图片，不重新生成方案`, 5000)
      } else {
        await clearIllustrationJob(plugin, note.file.path)
      }
    }

    if (!confirmed) {
      const input = await new PromptModal(plugin.app, '文章配图 · 极简小清新手绘', '先生成配图方案', [
        {
          key: 'count',
          label: '正文插图几张?(2-5)',
          desc: '会额外规划 1 张封面。先免费查看每张图的核心意思、放置位置和画面文字；确认后才生图并扣积分。',
          initial: '3',
        },
      ]).result
      if (!input) return
      count = Math.min(5, Math.max(2, parseInt(input.count) || 3))

      planning = new Notice('🤖 正在读文章并规划配图点…', 0)
      const planData = (await plugin.api(ARTICLE_ILLUSTRATION_API, {
        method: 'POST',
        body: { article: clip(article, 20_000, '文章'), articleTitle, count, mode: 'plan' },
      })) as {
        plan?: IllustrationPlan
        estimatedCredits?: number
      }
      planning.hide()
      planning = null
      if (!planData.plan || (!planData.plan.cover && planData.plan.images.length === 0)) {
        throw new Error('没有规划出有效配图点')
      }
      confirmed = await new IllustrationPlanModal(plugin.app, planData.plan, planData.estimatedCredits).result
      if (!confirmed) {
        new Notice('已取消，没有生成图片，也没有扣生图积分')
        return
      }
    }

    // 方案只存插件目录中的短期恢复状态，不写进用户正文或输出文件夹。
    // 生图连接波动后再次运行本技能，会直接续跑剩余图片，不重新规划。
    await saveIllustrationJob(plugin, {
      notePath: note.file.path,
      articleFingerprint: fingerprint,
      articleTitle,
      count,
      pendingPlan: confirmed,
      updatedAt: Date.now(),
    })

    const folder = normalizePath(
      `${plugin.settings.outputFolder || 'AI霖子输出'}/公众号文章/配图/${today()}_${sanitizeTitle(note.file.basename)}`,
    )
    await ensureFolder(plugin, folder)

    const generating = new Notice('🤖 AI霖子正在生成文章配图…（多张高清图约需 2—8 分钟，可继续使用 Obsidian，请勿退出）', 0)
    let pendingPlan: IllustrationPlan = confirmed
    let generatedCover: IllustrationGenerateResult['cover'] = null
    const generatedImages = new Map<string, NonNullable<IllustrationGenerateResult['images']>[number]>()
    let lastResult: IllustrationGenerateResult | null = null
    try {
      // 服务端会保留本轮成功图并返回 failedPlan。插件只重试失败项，不再把已经成功的
      // 图片整组重画；最多三轮，覆盖临时限流、单张错字或质检偶发失败。
      for (let round = 1; round <= 3; round++) {
        if (round > 1) generating.setMessage(`文章配图：正在补齐第 ${round} 轮（只重试缺失图片）…`)
        const result = (await plugin.api(ARTICLE_ILLUSTRATION_API, {
          method: 'POST',
          body: {
            article: clip(article, 20_000, '文章'),
            articleTitle,
            count,
            mode: 'generate',
            plan: pendingPlan,
          },
        })) as IllustrationGenerateResult
        lastResult = result
        if (result.cover?.imageUrl) generatedCover = result.cover
        for (const image of result.images ?? []) {
          if (image.imageUrl) generatedImages.set(image.anchor, image)
        }
        if (result.status !== 'partial' || !result.failedPlan) break
        pendingPlan = result.failedPlan
        await saveIllustrationJob(plugin, {
          notePath: note.file.path,
          articleFingerprint: fingerprint,
          articleTitle,
          count,
          pendingPlan,
          updatedAt: Date.now(),
        })
      }
    } finally {
      generating.hide()
    }
    const data: IllustrationGenerateResult = {
      ...lastResult,
      cover: generatedCover,
      images: confirmed.images
        .map((item) => generatedImages.get(item.anchor))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    }
    const imgs = data.images ?? []
    const expectedTotal = confirmed.images.length + (confirmed.cover ? 1 : 0)
    const actualTotal = imgs.length + (data.cover ? 1 : 0)
    const complete = imgs.length === confirmed.images.length && Boolean(data.cover) === Boolean(confirmed.cover)
    if (actualTotal === 0) {
      const reason = illustrationFailureMessages(lastResult).slice(0, 2).join('；')
      const supportId = lastResult?.requestId ? `（问题编号：${lastResult.requestId}）` : ''
      throw new Error(
        `${reason || '图片生成服务本轮没有返回可用图片，请稍后重试'}${supportId}。未完成任务已保留，再次运行“文章配图”可直接继续补图。`,
      )
    }

    // 封面单独处理:存 00_封面,插到文章最顶部(发草稿箱时自动成为封面)
    let coverPath: string | null = null
    if (data.cover) {
      const bin = await fetchImageBinary(data.cover.imageUrl)
      coverPath = uniqueVaultPath(
        plugin,
        normalizePath(`${folder}/${today()}_00_封面_${sanitizeTitle(data.cover.title) || '封面'}.png`),
      )
      await plugin.app.vault.createBinary(coverPath, bin)
    }

    const saved: { path: string; anchor: string }[] = []
    for (let i = 0; i < imgs.length; i++) {
      const bin = await fetchImageBinary(imgs[i].imageUrl)
      const path = uniqueVaultPath(
        plugin,
        normalizePath(`${folder}/${today()}_${String(i + 1).padStart(2, '0')}_${sanitizeTitle(imgs[i].title) || '配图'}.png`),
      )
      await plugin.app.vault.createBinary(path, bin)
      saved.push({ path, anchor: imgs[i].anchor })
    }

    let hits = 0
    await plugin.app.vault.process(note.file, (content) => {
      const r = insertEmbeds(content, saved)
      let out = r.out
      hits = r.hits
      if (coverPath) out = insertCoverEmbed(out, coverPath)
      return out
    })
    if (complete) await clearIllustrationJob(plugin, note.file.path)
    new Notice(
      complete
        ? `✅ 已生成 ${actualTotal} 张图片：${coverPath ? '1 张封面 + ' : ''}${saved.length} 张正文插图(${hits} 张按段落定位)`
        : `⚠️ 已保留并插入 ${actualTotal}/${expectedTotal} 张可用图片，缺失 ${expectedTotal - actualTotal} 张在三轮自动补图后仍未生成。${illustrationFailureMessages(lastResult).length ? `原因：${illustrationFailureMessages(lastResult).slice(0, 2).join('；')}。` : ''}${lastResult?.requestId ? `问题编号：${lastResult.requestId}。` : ''}成功图不会丢失或重复生成；再次运行“文章配图”可继续补齐。`,
      complete ? 10000 : 14000,
    )
  } catch (e) {
    planning?.hide()
    new Notice(`❌ 文章配图:${e instanceof Error ? e.message : String(e)}`, 10000)
  }
}

// ── 从主对话修改当前文章里的单张配图 ─────────────────

interface ArticleImageEntry {
  file: TFile
  linkTargets: string[]
}

interface IllustrationEditRequest {
  image: ArticleImageEntry
  instruction: string
  exactText: string[]
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])

function findArticleImages(plugin: AiLinziPlugin, noteFile: TFile, noteText: string): ArticleImageEntry[] {
  const byPath = new Map<string, ArticleImageEntry>()
  const addTarget = (rawTarget: string) => {
    const target = rawTarget
      .trim()
      .replace(/^<|>$/g, '')
      .split('|')[0]
      .split('#')[0]
      .trim()
    if (!target || /^https?:|^data:/i.test(target)) return
    let decoded = target
    try {
      decoded = decodeURIComponent(target)
    } catch {
      /* 不是 URI 编码就用原值 */
    }
    const file = plugin.app.metadataCache.getFirstLinkpathDest(decoded, noteFile.path)
    if (!(file instanceof TFile) || !IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) return
    const existing = byPath.get(file.path)
    if (existing) {
      if (!existing.linkTargets.includes(rawTarget)) existing.linkTargets.push(rawTarget)
    } else {
      byPath.set(file.path, { file, linkTargets: [rawTarget] })
    }
  }
  for (const match of noteText.matchAll(/!\[\[([^\]]+)\]\]/g)) addTarget(match[1])
  for (const match of noteText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) addTarget(match[1])
  return [...byPath.values()]
}

function splitExactText(value: string): string[] {
  const out: string[] = []
  for (const raw of value.split(/[\n/／、，,|｜]+/)) {
    const text = raw.trim().replace(/^[「『“‘"']+|[」』”’"']+$/g, '')
    if (text.length < 2 || text.length > 20 || out.includes(text)) continue
    out.push(text)
  }
  return out.slice(0, 5)
}

class IllustrationEditModal extends Modal {
  private submitted = false
  private resolve!: (value: IllustrationEditRequest | null) => void
  readonly result: Promise<IllustrationEditRequest | null>

  constructor(
    app: App,
    private images: ArticleImageEntry[],
    private initialInstruction: string,
  ) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
    this.open()
  }

  onOpen() {
    this.titleEl.setText('修改当前文章配图')
    this.contentEl.createEl('p', {
      text: '选择文章里的图片并写清修改要求。AI 会参考原图只改这一张，生成成功后自动备份并覆盖原图。',
      cls: 'ai-linzi-plan-intro',
    })
    let selected = this.images[0]
    let instruction = this.initialInstruction.trim()
    let exactText = extractExactTextHints(instruction).join(' / ')
    const preview = this.contentEl.createEl('img', { cls: 'ai-linzi-image-edit-preview' })
    const refreshPreview = () => {
      preview.src = this.app.vault.getResourcePath(selected.file)
      preview.alt = selected.file.basename
    }

    new Setting(this.contentEl)
      .setName('要修改哪张图?')
      .addDropdown((dropdown) => {
        this.images.forEach((item, index) => {
          dropdown.addOption(item.file.path, `${index + 1}. ${item.file.basename}`)
        })
        dropdown.setValue(selected.file.path).onChange((path) => {
          selected = this.images.find((item) => item.file.path === path) ?? this.images[0]
          refreshPreview()
        })
      })

    new Setting(this.contentEl)
      .setName('修改要求')
      .setDesc('例如:把标题里的错字改对，其他画面、人物和构图都保持不变。')
      .addTextArea((input) => {
        input.setValue(instruction).onChange((value) => (instruction = value))
        input.inputEl.rows = 3
        input.inputEl.addClass('ai-linzi-full-width')
      })

    new Setting(this.contentEl)
      .setName('必须写对的文字')
      .setDesc('用 / 分隔，最多 5 组。系统会在出图后逐字识别，不通过就自动重试。')
      .addText((input) => {
        input.setValue(exactText).onChange((value) => (exactText = value))
        input.inputEl.addClass('ai-linzi-full-width')
      })

    refreshPreview()
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('生成修改版并覆盖原图')
          .setCta()
          .onClick(() => {
            if (instruction.trim().length < 2) {
              new Notice('请先写清楚图片要修改什么')
              return
            }
            this.submitted = true
            this.resolve({ image: selected, instruction: instruction.trim(), exactText: splitExactText(exactText) })
            this.close()
          }),
      )
  }

  onClose() {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

async function imageFileToReferenceDataUrl(plugin: AiLinziPlugin, file: TFile): Promise<string> {
  const binary = await plugin.app.vault.readBinary(file)
  const mime = file.extension.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'
  const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(binary)], { type: mime }))
  try {
    const image = new Image()
    image.src = objectUrl
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('无法读取当前配图'))
    })
    const scale = Math.min(1, 1600 / image.naturalWidth, 1000 / image.naturalHeight)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('图片压缩失败')
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.88)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function timestampForFilename(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export async function runArticleIllustrationEdit(plugin: AiLinziPlugin, initialInstruction = ''): Promise<void> {
  const note = await getActiveNote(plugin)
  if (!note) return
  const images = findArticleImages(plugin, note.file, note.text)
  if (images.length === 0) {
    new Notice('当前笔记里没有找到本地 PNG/JPG/WebP 配图')
    return
  }
  const request = await new IllustrationEditModal(plugin.app, images, initialInstruction).result
  if (!request) return

  const working = new Notice('🎨 正在参考原图修改，并逐字检查图片文字…', 0)
  try {
    const imageDataUrl = await imageFileToReferenceDataUrl(plugin, request.image.file)
    const article = prepareWechatArticle(note.text).body
    const data = (await plugin.api(ARTICLE_ILLUSTRATION_API, {
      method: 'POST',
      body: {
        article: clip(article, 20_000, '文章'),
        mode: 'edit',
        edit: {
          imageDataUrl,
          instruction: request.instruction,
          exactText: request.exactText,
        },
      },
    })) as { imageUrl?: string; prompt?: string }
    if (!data.imageUrl) throw new Error('服务端没有返回修改后的图片')

    const originalBinary = await plugin.app.vault.readBinary(request.image.file)
    const modifiedBinary = await fetchImageBinary(data.imageUrl)
    if (request.image.file.extension.toLowerCase() === 'png') {
      const parent = request.image.file.parent?.path ?? ''
      const backupPath = uniqueVaultPath(
        plugin,
        normalizePath(
          `${parent ? `${parent}/` : ''}${request.image.file.basename}_修改前_${timestampForFilename()}.png`,
        ),
      )
      await plugin.app.vault.createBinary(backupPath, originalBinary)
      await plugin.app.vault.modifyBinary(request.image.file, modifiedBinary)
      new Notice(`✅ 已修改并覆盖「${request.image.file.name}」\n原图备份:${backupPath}`, 10000)
    } else {
      const parent = request.image.file.parent?.path ?? ''
      const newPath = uniqueVaultPath(
        plugin,
        normalizePath(`${parent ? `${parent}/` : ''}${request.image.file.basename}_修改版.png`),
      )
      await plugin.app.vault.createBinary(newPath, modifiedBinary)
      await plugin.app.vault.process(note.file, (content) => {
        let out = content
        for (const target of request.image.linkTargets) out = out.split(target).join(newPath)
        return out
      })
      new Notice(`✅ 已生成修改版并替换文章引用:${newPath}`, 10000)
    }

    const promptFile = request.image.file.parent
      ? plugin.app.vault.getAbstractFileByPath(`${request.image.file.parent.path}/AI霖子正文配图_PROMPTS.md`)
      : null
    if (promptFile instanceof TFile && data.prompt) {
      await plugin.app.vault.append(
        promptFile,
        `\n\n---\n\n## 单图修改 · ${request.image.file.name}\n\n- 修改要求:${request.instruction}\n- 文字白名单:${request.exactText.join(' / ') || '无'}\n\n### 修改提示词\n\n${data.prompt}\n`,
      )
    }
  } catch (error) {
    new Notice(`❌ 修改配图:${error instanceof Error ? error.message : String(error)}`, 10000)
  } finally {
    working.hide()
  }
}

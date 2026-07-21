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
  const folder = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
  if (!app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder).catch(() => {})
  }

  const base = `${today()}_${sanitizeTitle(spec.title) || '未命名'}`
  let path = normalizePath(`${folder}/${base}.md`)
  // 只新建不覆盖:重名自动加序号
  for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
    path = normalizePath(`${folder}/${base}_${i}.md`)
  }

  const fm = [
    '---',
    `title: ${JSON.stringify(spec.title)}`,
    `来源技能: ${spec.skill}`,
    `状态: 草稿`,
    `平台: ${spec.platform}`,
    `日期: ${isoDate()}`,
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
          t.inputEl.style.width = '100%'
        })
      } else {
        s.addText((t) => {
          t.setValue(this.values[f.key]).onChange((v) => (this.values[f.key] = v))
          t.inputEl.style.width = '100%'
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
    const text = await plugin.apiText('/api/skills/topic-radar', {
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
    const text = await plugin.apiText('/api/skills/wechat-writer', {
      topic: input.topic.trim().slice(0, LIMITS.WECHAT_TOPIC_MAX),
      material: clip(stripFrontmatter(note.text), LIMITS.WECHAT_MATERIAL_MAX, '笔记素材'),
    })
    const article = prepareWechatArticle(text)
    await writeOutput(plugin, {
      skill: '公众号写作',
      platform: '公众号',
      title: article.titleCandidates[0] || input.topic.trim(),
      body: article.body,
      summary: article.digest,
      titleCandidates: article.titleCandidates,
      sourceNote: note.file,
    })
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
    const data = (await plugin.api('/api/skills/wechat-distribute', {
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
    const text = await plugin.apiText('/api/skills/sales-review', {
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
        t.inputEl.style.width = '100%'
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
    suggested = (await plugin.api('/api/me/knowledge/suggest-section', {
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
      `/api/me/knowledge/sections/${confirmed.sectionKey}/append`,
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

async function fetchImageBinary(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1)
    const s = atob(b64)
    const u = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
    return u.buffer
  }
  const r = await requestUrl({ url, throw: false })
  if (r.status !== 200 || !r.arrayBuffer) throw new Error(`图片下载失败(${r.status})`)
  return r.arrayBuffer
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

function planMarkdown(
  plan: IllustrationPlan,
  generated: {
    cover?: { prompt?: string } | null
    images?: ({ prompt?: string } & IllustrationPlanItem)[]
  },
): string {
  const blocks = ['# 极简小清新手绘配图方案', '', '> 学员通用视觉：不使用 AI霖子个人手绘 IP。']
  if (plan.cover) {
    blocks.push('', `## 00 · 封面 · ${plan.cover.title}`, '', `- 核心意思：${plan.cover.coreIdea}`, `- 画面：${plan.cover.concept}`)
    if (generated.cover?.prompt) blocks.push('', '### 生图提示词', '', generated.cover.prompt)
  }
  plan.images.forEach((item, index) => {
    blocks.push(
      '',
      `## ${String(index + 1).padStart(2, '0')} · ${item.title}`,
      '',
      `- 放置位置：${item.anchor}`,
      `- 核心意思：${item.coreIdea}`,
      `- 画面大字：${item.labels.length ? item.labels.map((x) => `\`${x}\``).join('、') : '无'}`,
      `- 构图：${item.concept}`,
    )
    const prompt = generated.images?.find((generatedItem) => generatedItem.anchor === item.anchor)?.prompt
    if (prompt) blocks.push('', '### 生图提示词', '', prompt)
  })
  return blocks.join('\n').trim() + '\n'
}

export async function runArticleIllustration(plugin: AiLinziPlugin) {
  const note = await getActiveNote(plugin)
  if (!note) return
  const article = prepareWechatArticle(note.text).body
  if (article.length < 300) {
    new Notice(`文章只有 ${article.length} 字——配图需要至少 300 字的成稿`)
    return
  }
  const input = await new PromptModal(plugin.app, '文章配图 · 极简小清新手绘', '先生成配图方案', [
    {
      key: 'count',
      label: '正文插图几张?(2-4)',
      desc: '会额外规划 1 张封面。先免费查看每张图的核心意思、放置位置和画面文字；确认后才生图并扣积分。使用学员通用小人偶，不使用 AI霖子个人手绘 IP。',
      initial: '3',
    },
  ]).result
  if (!input) return
  const count = Math.min(4, Math.max(2, parseInt(input.count) || 3))

  const planning = new Notice('🤖 正在读文章并规划配图点…', 0)
  try {
    const planData = (await plugin.api('/api/skills/article-illustration', {
      method: 'POST',
      body: { article: clip(article, 20_000, '文章'), count, mode: 'plan' },
    })) as {
      plan?: IllustrationPlan
      estimatedCredits?: number
    }
    planning.hide()
    if (!planData.plan || (!planData.plan.cover && planData.plan.images.length === 0)) {
      throw new Error('没有规划出有效配图点')
    }
    const confirmed = await new IllustrationPlanModal(plugin.app, planData.plan, planData.estimatedCredits).result
    if (!confirmed) {
      new Notice('已取消，没有生成图片，也没有扣生图积分')
      return
    }

    const generating = runningNotice('文章配图')
    let data: {
      cover?: { title: string; imageUrl: string; prompt?: string } | null
      images?: (IllustrationPlanItem & { imageUrl: string; prompt?: string })[]
      failedCount?: number
    }
    try {
      data = (await plugin.api('/api/skills/article-illustration', {
        method: 'POST',
        body: { article: clip(article, 20_000, '文章'), count, mode: 'generate', plan: confirmed },
      })) as typeof data
    } finally {
      generating.hide()
    }
    const imgs = data.images ?? []
    if (!data.cover && imgs.length === 0) throw new Error('没有生成任何图片')

    const folder = normalizePath(
      `${plugin.settings.outputFolder || 'AI霖子输出'}/配图/${today()}_${sanitizeTitle(note.file.basename)}`,
    )
    await ensureFolder(plugin, folder)

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

    const promptsPath = uniqueVaultPath(plugin, normalizePath(`${folder}/AI霖子正文配图_PROMPTS.md`))
    await plugin.app.vault.create(promptsPath, planMarkdown(confirmed, data))

    let hits = 0
    await plugin.app.vault.process(note.file, (content) => {
      const r = insertEmbeds(content, saved)
      let out = r.out
      hits = r.hits
      if (coverPath) out = insertCoverEmbed(out, coverPath)
      return out
    })
    const failMsg = data.failedCount ? `;${data.failedCount} 张生成失败(未扣积分)` : ''
    new Notice(
      `✅ ${coverPath ? '封面 + ' : ''}${saved.length} 张正文插图已插入文章(${hits} 张按段落定位)${failMsg}\n方案和提示词已保存:${promptsPath}`,
      10000,
    )
  } catch (e) {
    planning.hide()
    new Notice(`❌ 文章配图:${e instanceof Error ? e.message : String(e)}`, 10000)
  }
}

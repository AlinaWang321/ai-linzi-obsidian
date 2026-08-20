/**
 * 课件PPT（deck-builder，0.7.63）：把一份 MD/TXT/PDF/DOCX 文档变成可放映的网页课件。
 *
 * 流程：用户选择并锁定一份文档 → 本机提取文字与图片引用 → 只把提取后的文字和
 * 图片令牌发给私有后端编排大纲（提示词、模型、权限与用量核算全在服务端）→ 插件按
 * 固定品牌模板在本机装配 HTML（图片在本机压缩后内嵌，绝不上传）→ 写入
 * `AI霖子输出/课件PPT/`。产物用系统浏览器打开：F 全屏放映，⌘P 直接存 PDF。
 */
import { Modal, Notice, Setting, TFile, normalizePath } from 'obsidian'
import type AiLinziPlugin from './main'
import { selectTranscriptSource } from './transcript-source'
import { friendlyErrorMessage } from './friendly-error'
import { extractDocxTextWithImages } from './local-document-text'
import {
  DECK_BUILDER_OUTPUT_FOLDER,
  DECK_SOURCE_MAX,
  DECK_SOURCE_MIN,
  DECK_THEMES,
  assembleDeckHtml,
  deckImageTokens,
  extractSourceImageTokens,
  validateDeckOutline,
  type DeckOutline,
  type DeckTheme,
} from './deck-builder-core'

const DECK_MAX_IMAGE_TOKENS = 40
const DECK_IMAGE_MAX_WIDTH = 1400
const DECK_IMAGE_JPEG_QUALITY = 0.82
const DECK_IMAGE_EXTENSIONS = /^(png|jpe?g|webp|gif)$/i

interface DeckBuilderInput {
  presenter: string
  brand: string
  theme: DeckTheme
}

/** 与 customer-consultation-brief 相同的逐级建目录方式（Vault API，绝不覆盖）。 */
async function ensureFolder(plugin: AiLinziPlugin, folder: string): Promise<void> {
  const parts = normalizePath(folder).split('/')
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current).catch(() => {})
    }
  }
}

function fileDate(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`
}

function sanitizeDeckFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

function uniqueHtmlPath(plugin: AiLinziPlugin, folder: string, base: string): string {
  let candidate = normalizePath(`${folder}/${base}.html`)
  let suffix = 2
  while (plugin.app.vault.getAbstractFileByPath(candidate)) {
    candidate = normalizePath(`${folder}/${base}_${suffix}.html`)
    suffix += 1
  }
  return candidate
}

/** 令牌目标 → Vault 图片文件：先按原样路径，再按源文档同目录，最后走 wikilink 解析。 */
function resolveImageTarget(plugin: AiLinziPlugin, sourceFile: TFile, target: string): TFile | null {
  const cleaned = target.replace(/^<|>$/g, '').split('#')[0].trim()
  if (!cleaned) return null
  const candidates: Array<TFile | null> = []
  const direct = plugin.app.vault.getAbstractFileByPath(normalizePath(cleaned))
  candidates.push(direct instanceof TFile ? direct : null)
  const parent = sourceFile.parent?.path
  if (parent && parent !== '/') {
    const sibling = plugin.app.vault.getAbstractFileByPath(normalizePath(`${parent}/${cleaned}`))
    candidates.push(sibling instanceof TFile ? sibling : null)
  }
  candidates.push(plugin.app.metadataCache.getFirstLinkpathDest(cleaned, sourceFile.path))
  for (const candidate of candidates) {
    if (candidate instanceof TFile && DECK_IMAGE_EXTENSIONS.test(candidate.extension)) return candidate
  }
  return null
}

/** 本机压缩：宽度压到 ≤1400、重编码 JPEG，先铺白底防止透明 PNG 变黑块。 */
async function imageBytesToDeckDataUrl(bytes: Uint8Array): Promise<string | null> {
  try {
    const blob = new Blob([new Uint8Array(bytes).slice().buffer])
    const url = URL.createObjectURL(blob)
    try {
      const image = new Image()
      image.decoding = 'async'
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('无法解码这张图片'))
        image.src = url
      })
      const scale = Math.min(1, DECK_IMAGE_MAX_WIDTH / Math.max(1, image.naturalWidth))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) return null
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', DECK_IMAGE_JPEG_QUALITY)
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return null
  }
}

async function imageFileToDeckDataUrl(plugin: AiLinziPlugin, file: TFile): Promise<string | null> {
  try {
    return await imageBytesToDeckDataUrl(new Uint8Array(await plugin.app.vault.readBinary(file)))
  } catch {
    return null
  }
}

class DeckBuilderModal extends Modal {
  private submitted = false
  private resolvePromise!: (value: DeckBuilderInput | null) => void
  readonly result = new Promise<DeckBuilderInput | null>((resolve) => {
    this.resolvePromise = resolve
  })

  constructor(
    private readonly plugin: AiLinziPlugin,
    private readonly sourceName: string,
    private readonly sourceChars: number,
    private readonly imageCount: number,
  ) {
    super(plugin.app)
    this.open()
  }

  onOpen(): void {
    const { contentEl } = this
    this.titleEl.setText('课件PPT · 生成设置')
    contentEl.createEl('p', {
      text: `已锁定《${this.sourceName}》（约 ${this.sourceChars.toLocaleString('zh-CN')} 字` +
        (this.imageCount > 0 ? `，识别到 ${this.imageCount} 张图片）` : '）'),
    })
    contentEl.createEl('p', {
      text: '文档与图片都在本机解析；只有提取后的文字会发给 AI霖子编排大纲，图片在本机压缩后直接嵌进课件，不会上传。',
      cls: 'setting-item-description',
    })
    const input: DeckBuilderInput = {
      presenter: this.plugin.settings.deckPresenter || '',
      brand: this.plugin.settings.deckBrand || '',
      theme: (DECK_THEMES as readonly string[]).includes(this.plugin.settings.deckTheme)
        ? (this.plugin.settings.deckTheme as DeckTheme)
        : '深蓝',
    }
    new Setting(contentEl)
      .setName('讲者名')
      .setDesc('显示在课件封面和每页页脚，比如你的名字或昵称')
      .addText((text) => text.setValue(input.presenter).onChange((value) => { input.presenter = value.trim() }))
    new Setting(contentEl)
      .setName('品牌 / 平台名')
      .setDesc('可留空；显示在讲者名后面')
      .addText((text) => text.setValue(input.brand).onChange((value) => { input.brand = value.trim() }))
    new Setting(contentEl)
      .setName('主题色')
      .setDesc('深蓝（商务）· 青竹（自然）· 黛紫（高级感）')
      .addDropdown((dropdown) => {
        for (const theme of DECK_THEMES) dropdown.addOption(theme, theme)
        dropdown.setValue(input.theme).onChange((value) => { input.theme = value as DeckTheme })
      })
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText('生成课件')
          .onClick(() => {
            this.submitted = true
            this.resolvePromise(input)
            this.close()
          }),
      )
  }

  onClose(): void {
    this.contentEl.empty()
    if (!this.submitted) this.resolvePromise(null)
  }
}

function parseDeckOutlineResponse(raw: string): DeckOutline | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as DeckOutline
  } catch {
    return null
  }
}

export async function runDeckBuilder(plugin: AiLinziPlugin): Promise<void> {
  const source = await selectTranscriptSource(plugin, '课件PPT', DECK_SOURCE_MAX, '文档')
  if (!source) return

  const statusId = plugin.reportSkillStatus(
    `🖥️ 课件PPT · 已锁定《${source.file.name}》（${source.text.length.toLocaleString('zh-CN')} 字），准备编排…`,
  )
  // 图片来源两条：Markdown 引用 Vault 里的图片文件；Word 把图片内嵌在 docx 里。
  // （PDF/TXT 暂不提取图片：PDF 的图形对象没有可靠的「这张图属于哪段话」信息。）
  const extension = source.file.extension.toLocaleLowerCase()
  const imageFiles = new Map<string, TFile>()
  const imageBytes = new Map<string, Uint8Array>()
  let sourceText = source.text
  if (extension === 'md') {
    for (const token of extractSourceImageTokens(source.text)) {
      if (imageFiles.size >= DECK_MAX_IMAGE_TOKENS) break
      const file = resolveImageTarget(plugin, source.file, token.target)
      if (file) imageFiles.set(token.token, file)
    }
  } else if (extension === 'docx') {
    try {
      const binary = new Uint8Array(await plugin.app.vault.readBinary(source.file))
      const extracted = extractDocxTextWithImages(binary, DECK_SOURCE_MAX)
      // 正文换成带图片占位令牌的版本，模型才知道每张图原本出现在哪一段。
      if (extracted.text.trim()) sourceText = extracted.text
      for (const image of extracted.images.slice(0, DECK_MAX_IMAGE_TOKENS)) {
        imageBytes.set(image.token, image.bytes)
      }
    } catch {
      // 解析图片失败不影响出课件：退回纯文字（source.text 已经可用）。
    }
  }
  const imageTokenCount = imageFiles.size + imageBytes.size

  if (sourceText.length < DECK_SOURCE_MIN) {
    new Notice(`《${source.file.name}》内容太少（不足 ${DECK_SOURCE_MIN} 字），先把讲义写得完整一点再来生成课件`, 8000)
    plugin.reportSkillStatus(`⚠️ 课件PPT已停止：《${source.file.name}》内容不足 ${DECK_SOURCE_MIN} 字。`, statusId)
    return
  }


  const input = await new DeckBuilderModal(
    plugin,
    source.file.name,
    sourceText.length,
    imageTokenCount,
  ).result
  if (!input) {
    plugin.reportSkillStatus(`已取消本次课件生成，《${source.file.name}》未处理。`, statusId)
    return
  }
  plugin.settings.deckPresenter = input.presenter
  plugin.settings.deckBrand = input.brand
  plugin.settings.deckTheme = input.theme
  await plugin.saveSettings()

  plugin.reportSkillStatus(`🤖 课件PPT · AI霖子正在编排《${source.file.name}》的课件大纲…`, statusId)
  const running = new Notice('🤖 AI霖子正在编排课件大纲…（约 1-2 分钟，请别关闭 Obsidian）', 0)
  try {
    const response = await plugin.apiText('/api/plugin/v1/skills/deck-builder', {
      text: sourceText,
      images: [...imageFiles.keys(), ...imageBytes.keys()],
      presenter: input.presenter || undefined,
      brand: input.brand || undefined,
    })
    const outline = parseDeckOutlineResponse(response)
    const verdict = outline ? validateDeckOutline(outline) : { ok: false as const, issues: [] }
    if (!outline || !verdict.ok || !verdict.outline) {
      throw new Error('课件大纲没有生成完整，请稍后重试，或换一篇内容更完整的文档')
    }

    plugin.reportSkillStatus('🎨 大纲完成，正在本机装配课件（图片压缩嵌入中）…', statusId)
    const imageDataUrls = new Map<string, string>()
    for (const token of deckImageTokens(verdict.outline)) {
      const file = imageFiles.get(token)
      const bytes = imageBytes.get(token)
      const dataUrl = file
        ? await imageFileToDeckDataUrl(plugin, file)
        : bytes
          ? await imageBytesToDeckDataUrl(bytes)
          : null
      if (dataUrl) imageDataUrls.set(token, dataUrl)
    }
    const html = assembleDeckHtml({ outline: verdict.outline, theme: input.theme, imageDataUrls })

    const root = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
    const folder = normalizePath(`${root}/${DECK_BUILDER_OUTPUT_FOLDER}`)
    await ensureFolder(plugin, folder)
    const base = `${fileDate()}_${sanitizeDeckFilePart(verdict.outline.meta.deck_title) || '课件'}_课件`
    const path = uniqueHtmlPath(plugin, folder, base)
    await plugin.app.vault.create(path, html)

    const pageCount = verdict.outline.slides.length
    const embedded = imageDataUrls.size
    plugin.reportSkillStatus(
      `✅ 课件PPT 已生成（${pageCount} 页${embedded > 0 ? `，嵌入 ${embedded} 张图片` : ''}）：${path}\n` +
        '👉 用系统浏览器打开：按 F 全屏放映、方向键翻页；⌘P（Windows 按 Ctrl+P）即可存成 PDF。',
      statusId,
    )
    new Notice(`✅ 课件已生成（${pageCount} 页），正在用浏览器打开…`, 8000)
    try {
      const opener = plugin.app as unknown as { openWithDefaultApp?: (path: string) => Promise<void> }
      await opener.openWithDefaultApp?.(path)
    } catch {
      // 打不开就算了，路径已经在状态条里。
    }
  } catch (error) {
    const message = friendlyErrorMessage(error instanceof Error ? error.message : String(error))
    plugin.reportSkillStatus(`❌ 课件PPT失败：${message}`, statusId)
    new Notice(`❌ 课件生成失败：${message}`, 9000)
  } finally {
    running.hide()
  }
}

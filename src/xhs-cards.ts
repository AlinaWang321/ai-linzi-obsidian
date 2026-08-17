import { Modal, Notice, TFile, normalizePath, requestUrl } from 'obsidian'
import { zipSync } from 'fflate'
import type AiLinziPlugin from './main'
import {
  composeGeneratedXhsNote,
  paginateXhsCardBlocks,
  paginateXTweetBlocks,
  parseXhsCardDocument,
  stableContentFingerprint,
  type XhsCardBlock,
} from './xhs-card-core'
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  drawBodyPage,
  drawCover,
  drawXTweetPage,
  fillCoverBlocks,
  paletteForStyle,
  wrapRichText,
  X_TWEET_LAYOUT,
  type XhsCardStyleId,
} from './xhs-card-render'
import { getXhsCardStyle } from './xhs-card-styles'

export interface XhsCardPackage {
  folderPath: string
  imagePaths: string[]
  zipPath: string
  manifestPath: string
  noteFile: TFile
  sourceImageCount: number
  embeddedSourceImageCount: number
  skippedSourceImages: string[]
}

interface GenerateXhsCardsInput {
  sourceFile: TFile
  noteFile: TFile
  markdown: string
  /** 只接受源文章明确提供的摘要；不得用正文第一段自动补齐。 */
  summary?: string
  /** 3 个备选标题、小红书正文和话题词；写在卡片图片之前，不参与卡片分页。 */
  caption?: string
  /** 卡片风格;缺省 classic 保证旧调用输出不变 */
  style?: XhsCardStyleId
  /** X 风格的身份信息(来自设置;头像路径可为空,回退首字圆标) */
  xIdentity?: { nickname: string; handle: string; avatarPath: string }
}

function isoDate(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fileDate(): string {
  return isoDate().replace(/-/g, '.')
}

function sanitizeName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 52)
}

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

function uniqueFolder(plugin: AiLinziPlugin, base: string): string {
  let path = normalizePath(base)
  for (let index = 2; plugin.app.vault.getAbstractFileByPath(path); index++) {
    path = normalizePath(`${base}_${index}`)
  }
  return path
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('浏览器未能生成 PNG'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

async function loadImageFromBinary(binary: ArrayBuffer): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([binary]))
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = url
    })
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function loadSourceImage(
  plugin: AiLinziPlugin,
  sourceFile: TFile,
  source: string,
): Promise<HTMLImageElement> {
  const target = plugin.app.metadataCache.getFirstLinkpathDest(source, sourceFile.path)
  if (target instanceof TFile && /^(png|jpe?g|webp)$/i.test(target.extension)) {
    return loadImageFromBinary(await plugin.app.vault.readBinary(target))
  }
  if (/^https?:\/\//i.test(source)) {
    const response = await requestUrl({ url: source, throw: false })
    if (response.status === 200 && response.arrayBuffer) {
      return loadImageFromBinary(response.arrayBuffer)
    }
  }
  throw new Error(`找不到图片：${source}`)
}

async function replaceWithGeneratedXhsNote(
  plugin: AiLinziPlugin,
  noteFile: TFile,
  imagePaths: string[],
  caption = '',
) {
  const current = await plugin.app.vault.cachedRead(noteFile)
  await plugin.app.vault.modify(
    noteFile,
    composeGeneratedXhsNote(current, imagePaths, caption),
  )
}

async function updateCardFrontmatter(
  plugin: AiLinziPlugin,
  input: GenerateXhsCardsInput,
  result: XhsCardPackage,
) {
  const date = isoDate()
  const fingerprint = stableContentFingerprint(input.markdown)
  await plugin.app.fileManager.processFrontMatter(input.noteFile, (fm: Record<string, unknown>) => {
    fm['小红书状态'] = '已生成小红书图文'
    fm['小红书生成时间'] = date
    fm['小红书卡片风格'] = getXhsCardStyle(input.style).name
    fm['小红书卡片目录'] = result.folderPath
    fm['小红书卡片ZIP'] = result.zipPath
    fm['来源路径'] = input.sourceFile.path
    fm['来源内容指纹'] = fingerprint
  })
  if (input.sourceFile.path !== input.noteFile.path) {
    await plugin.app.fileManager.processFrontMatter(input.sourceFile, (fm: Record<string, unknown>) => {
      fm['小红书状态'] = '已生成小红书图文'
      fm['小红书生成时间'] = date
      fm['小红书笔记'] = input.noteFile.path
      fm['小红书卡片目录'] = result.folderPath
      fm['小红书卡片ZIP'] = result.zipPath
      fm['小红书来源内容指纹'] = fingerprint
    })
  }
}

export async function generateXhsCardPackage(
  plugin: AiLinziPlugin,
  input: GenerateXhsCardsInput,
): Promise<XhsCardPackage> {
  const parsed = parseXhsCardDocument(input.markdown, input.sourceFile.basename, input.summary)
  const sourceImageBlocks = parsed.blocks.filter(
    (block): block is XhsCardBlock & { imageSource: string } =>
      block.kind === 'image' && Boolean(block.imageSource),
  )
  const loadedImages = await Promise.all(
    sourceImageBlocks.map(async (block) => {
      try {
        const image = await loadSourceImage(plugin, input.sourceFile, block.imageSource)
        block.imageAspectRatio = image.naturalWidth / image.naturalHeight
        return { block, image }
      } catch {
        return null
      }
    }),
  )
  const successfulImages = loadedImages.filter(
    (entry): entry is { block: XhsCardBlock & { imageSource: string }; image: HTMLImageElement } =>
      entry !== null,
  )
  const sourceImages = new Map<XhsCardBlock, HTMLImageElement>(
    successfulImages.map(({ block, image }) => [block, image]),
  )
  const coverImageBlock = successfulImages[0]?.block
  const coverImage = successfulImages[0]?.image ?? null
  const skippedSourceImages = sourceImageBlocks
    .filter((block) => !sourceImages.has(block))
    .map((block) => block.imageSource)
  const renderableBlocks = parsed.blocks.filter(
    (block) => block.kind !== 'image' || (block !== coverImageBlock && sourceImages.has(block)),
  )

  const styleId: XhsCardStyleId = input.style ?? 'classic'
  const palette = paletteForStyle(styleId)
  const measureCanvas = window.document.createElement('canvas')
  const measure = measureCanvas.getContext('2d')
  if (!measure) throw new Error('当前环境不支持 Canvas，无法生成卡片')
  let renderPage: (context: CanvasRenderingContext2D, index: number) => void
  let total: number
  if (styleId === 'x-dark') {
    // X 推文卡:无封面页,标题与小标题压平成加粗段落;每页完整推文框。
    const xRenderable = parsed.blocks.filter(
      (block) => block.kind !== 'image' || sourceImages.has(block),
    )
    const fullBold = (text: string) => [{ start: 0, end: text.length }]
    const flattened: XhsCardBlock[] = [
      { kind: 'paragraph', text: parsed.title, boldRanges: fullBold(parsed.title) },
      ...xRenderable.map((block): XhsCardBlock =>
        block.kind === 'heading'
          ? { kind: 'paragraph', text: block.text, boldRanges: fullBold(block.text) }
          : block.kind === 'quote'
            ? { ...block, kind: 'paragraph' }
            : block,
      ),
    ]
    const L = X_TWEET_LAYOUT
    const xPages = paginateXTweetBlocks(flattened, {
      pageBodyHeight: L.bodyBottom - L.bodyTop,
      lineHeight: L.lineHeight,
      paragraphGap: L.paragraphGap,
      imageGap: L.imageGap,
      wrapLines: (block) =>
        wrapRichText(measure, block, L.bodyWidth, L.fontSize, 400, 700, 0, 'sans', true),
      imageHeight: (block) => {
        const image = sourceImages.get(block)
        if (!image) return 0
        const scale = Math.min(L.bodyWidth / image.naturalWidth, L.imageMaxHeight / image.naturalHeight)
        return image.naturalHeight * scale
      },
    })
    const identity = input.xIdentity ?? { nickname: '', handle: '', avatarPath: '' }
    let avatar: HTMLImageElement | null = null
    if (identity.avatarPath) {
      try {
        const file = plugin.app.vault.getAbstractFileByPath(normalizePath(identity.avatarPath))
        if (file instanceof TFile) {
          avatar = await loadImageFromBinary(await plugin.app.vault.readBinary(file))
        }
      } catch {
        avatar = null
      }
    }
    const options = {
      nickname: identity.nickname.trim() || 'AI霖子用户',
      handle: identity.handle.trim().replace(/^@+/, '') || 'yourname',
      avatar,
    }
    total = Math.max(xPages.length, 1)
    renderPage = (context, index) =>
      drawXTweetPage(context, xPages[index]?.blocks ?? [], sourceImages, options)
  } else {
    // 封面与正文页同规则装满(2026-08-17 Alina 拍板);短文章可单卡装完
    const { coverBlocks, remainingBlocks } = fillCoverBlocks(
      measure,
      palette,
      parsed,
      coverImage,
      renderableBlocks,
    )
    const pages = remainingBlocks.length > 0 ? paginateXhsCardBlocks(remainingBlocks) : []
    total = pages.length + 1
    renderPage = (context, index) => {
      if (index === 0) drawCover(context, palette, parsed, coverBlocks, coverImage, total)
      else drawBodyPage(context, palette, pages[index - 1].blocks, sourceImages, index + 1, total)
    }
  }
  const root = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
  const folderPath = uniqueFolder(
    plugin,
    `${root}/小红书/${fileDate()}_${sanitizeName(input.sourceFile.basename)}_卡片`,
  )
  await ensureFolder(plugin, folderPath)
  const imagePaths: string[] = []
  const zipEntries: Record<string, Uint8Array> = {}

  for (let index = 0; index < total; index++) {
    const canvas = window.document.createElement('canvas')
    canvas.width = CARD_WIDTH
    canvas.height = CARD_HEIGHT
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境不支持 Canvas，无法生成卡片')
    renderPage(context, index)
    const png = await canvasPng(canvas)
    const filename = `${String(index + 1).padStart(2, '0')}.png`
    const path = normalizePath(`${folderPath}/${filename}`)
    await plugin.app.vault.createBinary(path, Uint8Array.from(png).buffer)
    imagePaths.push(path)
    zipEntries[filename] = png
  }

  const zipPath = normalizePath(`${folderPath}/小红书卡片.zip`)
  const zipped = zipSync(zipEntries, { level: 6 })
  await plugin.app.vault.createBinary(zipPath, Uint8Array.from(zipped).buffer)
  const manifestPath = normalizePath(`${folderPath}/manifest.json`)
  await plugin.app.vault.create(
    manifestPath,
    JSON.stringify(
      {
        version: 2,
        format: 'xiaohongshu-image-post',
        style: styleId,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        generatedAt: new Date().toISOString(),
        sourcePath: input.sourceFile.path,
        notePath: input.noteFile.path,
        title: parsed.title,
        summary: parsed.excerpt || null,
        hashtags: parsed.hashtags,
        sourceImages: {
          found: sourceImageBlocks.length,
          embedded: successfulImages.length,
          skipped: skippedSourceImages,
        },
        images: imagePaths,
        zipPath,
      },
      null,
      2,
    ),
  )

  const result = {
    folderPath,
    imagePaths,
    zipPath,
    manifestPath,
    noteFile: input.noteFile,
    sourceImageCount: sourceImageBlocks.length,
    embeddedSourceImageCount: successfulImages.length,
    skippedSourceImages,
  }
  await replaceWithGeneratedXhsNote(plugin, input.noteFile, imagePaths, input.caption)
  await updateCardFrontmatter(plugin, input, result)
  return result
}

export class XhsCardGalleryModal extends Modal {
  constructor(
    app: AiLinziPlugin['app'],
    private result: XhsCardPackage,
  ) {
    super(app)
  }

  onOpen() {
    this.titleEl.setText(`小红书卡片 · ${this.result.imagePaths.length} 页`)
    this.contentEl.createEl('p', {
      text:
        `图片和 ZIP 已保存到 Vault；原文配图已混排 ${this.result.embeddedSourceImageCount}/${this.result.sourceImageCount} 张。` +
        (this.result.skippedSourceImages.length > 0 ? ' 有图片未找到，请检查原文链接。' : '') +
        ' 请逐页检查后再发布。',
      cls: 'setting-item-description',
    })
    const actions = this.contentEl.createDiv({ cls: 'ai-linzi-xhs-gallery-actions' })
    const openNote = actions.createEl('button', { text: '打开小红书笔记', cls: 'mod-cta' })
    openNote.onclick = () => {
      this.close()
      void this.app.workspace.getLeaf('tab').openFile(this.result.noteFile)
    }
    const copyPath = actions.createEl('button', { text: '复制卡片目录' })
    copyPath.onclick = () => {
      void navigator.clipboard.writeText(this.result.folderPath)
      new Notice('卡片目录已复制')
    }

    const grid = this.contentEl.createDiv({ cls: 'ai-linzi-xhs-gallery-grid' })
    for (const path of this.result.imagePaths) {
      const file = this.app.vault.getAbstractFileByPath(path)
      if (!(file instanceof TFile)) continue
      const item = grid.createDiv({ cls: 'ai-linzi-xhs-gallery-item' })
      item.createEl('img', {
        attr: {
          src: this.app.vault.getResourcePath(file),
          alt: file.basename,
        },
      })
      item.createDiv({ text: file.name })
    }
  }

  onClose() {
    this.contentEl.empty()
  }
}

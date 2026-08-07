import { Modal, Notice, TFile, normalizePath, requestUrl } from 'obsidian'
import { zipSync } from 'fflate'
import type AiLinziPlugin from './main'
import {
  composeGeneratedXhsNote,
  paginateXhsCardBlocks,
  parseXhsCardDocument,
  shouldUseXhsSideBySideLayout,
  stableContentFingerprint,
  takeXhsCoverIntro,
  XHS_BODY_IMAGE_MAX_HEIGHT,
  XHS_SIDE_IMAGE_MAX_HEIGHT,
  XHS_SIDE_IMAGE_WIDTH,
  type ParsedXhsCardDocument,
  type XhsCardBlock,
} from './xhs-card-core'

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1440
const BLUE = '#1265E8'
const ORANGE = '#F4B900'
const TITLE = '#252D38'
const INK = '#33383F'
const MUTED = '#7C8796'
const PAPER = '#FFFFFF'
const SERIF_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif'
const SANS_FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'

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

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function drawPaper(context: CanvasRenderingContext2D) {
  context.fillStyle = PAPER
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
}

function setFont(
  context: CanvasRenderingContext2D,
  size: number,
  weight = 500,
  family: 'serif' | 'sans' = 'serif',
) {
  context.font = `${weight} ${size}px ${family === 'serif' ? SERIF_FONT : SANS_FONT}`
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const char of text) {
    const candidate = current + char
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current)
      current = char
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

function drawLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  maxLines?: number,
): number {
  const visible = typeof maxLines === 'number' ? lines.slice(0, maxLines) : lines
  visible.forEach((line, index) => context.fillText(line, x, y + index * lineHeight))
  return y + visible.length * lineHeight
}

function drawPageChrome(context: CanvasRenderingContext2D, page: number, total: number) {
  context.fillStyle = MUTED
  setFont(context, 22, 400, 'sans')
  context.textAlign = 'right'
  context.fillText(`${String(page).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, 1008, 1380)
  context.textAlign = 'left'
}

interface RichLine {
  text: string
  start: number
  xOffset: number
}

function boldAt(block: XhsCardBlock, index: number): boolean {
  return Boolean(block.boldRanges?.some((range) => index >= range.start && index < range.end))
}

function wrapRichText(
  context: CanvasRenderingContext2D,
  block: XhsCardBlock,
  maxWidth: number,
  size: number,
  weight: number,
  boldWeight: number,
  firstLineIndent = 0,
): RichLine[] {
  const lines: RichLine[] = []
  let start = 0
  let width = 0
  for (let index = 0; index < block.text.length; index++) {
    setFont(context, size, boldAt(block, index) ? boldWeight : weight)
    const charWidth = context.measureText(block.text[index]).width
    const lineMaxWidth = maxWidth - (lines.length === 0 ? firstLineIndent : 0)
    if (index > start && width + charWidth > lineMaxWidth) {
      lines.push({
        text: block.text.slice(start, index),
        start,
        xOffset: lines.length === 0 ? firstLineIndent : 0,
      })
      start = index
      width = charWidth
    } else {
      width += charWidth
    }
  }
  if (start < block.text.length) {
    lines.push({
      text: block.text.slice(start),
      start,
      xOffset: lines.length === 0 ? firstLineIndent : 0,
    })
  }
  return lines
}

function drawRichLines(
  context: CanvasRenderingContext2D,
  block: XhsCardBlock,
  lines: RichLine[],
  x: number,
  y: number,
  lineHeight: number,
  size: number,
  weight: number,
  boldWeight: number,
  color: string,
  boldColor: string,
): number {
  lines.forEach((line, lineIndex) => {
    let cursor = x + line.xOffset
    let segment = ''
    let segmentBold = boldAt(block, line.start)
    const flush = () => {
      if (!segment) return
      setFont(context, size, segmentBold ? boldWeight : weight)
      context.fillStyle = segmentBold ? boldColor : color
      context.fillText(segment, cursor, y + lineIndex * lineHeight)
      cursor += context.measureText(segment).width
      segment = ''
    }
    for (let index = 0; index < line.text.length; index++) {
      const currentBold = boldAt(block, line.start + index)
      if (segment && currentBold !== segmentBold) flush()
      segmentBold = currentBold
      segment += line.text[index]
    }
    flush()
  })
  return y + lines.length * lineHeight
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  maxHeight: number,
): number {
  const scale = Math.min(width / image.naturalWidth, maxHeight / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y,
    drawWidth,
    drawHeight,
  )
  return drawHeight
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

function drawCover(
  context: CanvasRenderingContext2D,
  document: ParsedXhsCardDocument,
  coverBlocks: XhsCardBlock[],
  image: HTMLImageElement | null,
  total: number,
) {
  drawPaper(context)
  drawPageChrome(context, 1, total)

  context.fillStyle = TITLE
  setFont(context, 58, 700)
  const titleLines = wrapText(context, document.title, 940).slice(0, 4)
  let cursor = drawLines(context, titleLines, 70, 108, 76) + 14

  context.fillStyle = MUTED
  setFont(context, 27, 400)
  if (document.excerpt) {
    const excerptLines = wrapText(context, document.excerpt, 938).slice(0, image ? 2 : 4)
    cursor = drawLines(context, excerptLines, 70, cursor, 43) + 20
  }

  if (image) {
    const imageHeight = drawContainedImage(context, image, 70, cursor, 940, 420)
    cursor += imageHeight + 30
  }

  for (const block of coverBlocks) {
    if (block.kind === 'heading') {
      context.fillStyle = BLUE
      setFont(context, 34, 700)
      const lines = wrapText(context, block.text, 900)
      cursor = drawLines(context, lines, 84, cursor, 46) + 18
      continue
    }
    if (block.kind === 'quote') {
      const lines = wrapRichText(context, block, 870, 29, 500, 700)
      context.fillStyle = BLUE
      roundedRect(context, 70, cursor - 27, 5, Math.max(46, lines.length * 48 - 4), 3)
      context.fill()
      cursor =
        drawRichLines(context, block, lines, 96, cursor, 48, 29, 500, 700, INK, '#172235') +
        18
      continue
    }
    const lines = wrapRichText(context, block, 940, 29, 400, 700, 58)
    cursor =
      drawRichLines(context, block, lines, 70, cursor, 48, 29, 400, 700, INK, '#172235') +
      22
  }
}

function drawBodyPage(
  context: CanvasRenderingContext2D,
  blocks: XhsCardBlock[],
  sourceImages: ReadonlyMap<XhsCardBlock, HTMLImageElement>,
  page: number,
  total: number,
) {
  drawPaper(context)
  drawPageChrome(context, page, total)
  let y = 104

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block.kind === 'image') {
      const image = sourceImages.get(block)
      const next = blocks[index + 1]
      if (image && shouldUseXhsSideBySideLayout(block, next)) {
        const text = next as XhsCardBlock
        const textX = 548
        const textWidth = 460
        const imageHeight = drawContainedImage(
          context,
          image,
          70,
          y,
          XHS_SIDE_IMAGE_WIDTH,
          XHS_SIDE_IMAGE_MAX_HEIGHT,
        )
        let textBottom = y
        if (text.kind === 'quote') {
          const lines = wrapRichText(context, text, textWidth - 32, 30, 560, 700)
          context.fillStyle = BLUE
          roundedRect(context, textX, y - 29, 6, Math.max(52, lines.length * 54 - 4), 3)
          context.fill()
          textBottom = drawRichLines(
            context,
            text,
            lines,
            textX + 28,
            y,
            54,
            30,
            560,
            700,
            TITLE,
            '#172235',
          )
        } else {
          const lines = wrapRichText(context, text, textWidth, 30, 400, 700, 54)
          textBottom = drawRichLines(
            context,
            text,
            lines,
            textX,
            y,
            52,
            30,
            400,
            700,
            INK,
            '#172235',
          )
        }
        y = Math.max(y + imageHeight, textBottom) + 34
        index++
      } else if (image) {
        y +=
          drawContainedImage(context, image, 70, y, 940, XHS_BODY_IMAGE_MAX_HEIGHT) +
          34
      }
      continue
    }
    if (block.kind === 'heading') {
      const primary = block.level !== 3
      if (primary) {
        if (block.sectionIndex) {
          context.fillStyle = '#FFE38A'
          roundedRect(context, 70, y - 46, 224, 72, 36)
          context.fill()
          context.fillStyle = '#28518F'
          setFont(context, 28, 650, 'sans')
          context.textAlign = 'center'
          context.fillText(`PART ${String(block.sectionIndex).padStart(2, '0')}`, 182, y + 2)
          context.textAlign = 'left'
          y += 112
        }
        context.fillStyle = ORANGE
        roundedRect(context, 70, y - 45, 7, 62, 3)
        context.fill()
        context.fillStyle = BLUE
        setFont(context, 46, 700)
        const lines = wrapText(context, block.text, 898)
        y = drawLines(context, lines, 105, y, 62) + 32
      } else {
        context.fillStyle = ORANGE
        context.beginPath()
        context.arc(78, y - 11, 6, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = BLUE
        setFont(context, 38, 700)
        const lines = wrapText(context, block.text, 900)
        y = drawLines(context, lines, 102, y, 54) + 24
      }
      continue
    }
    if (block.kind === 'quote') {
      const lines = wrapRichText(context, block, 880, 33, 560, 700)
      context.fillStyle = BLUE
      roundedRect(context, 70, y - 31, 6, Math.max(52, lines.length * 56 - 4), 3)
      context.fill()
      y =
        drawRichLines(
          context,
          block,
          lines,
          102,
          y,
          56,
          33,
          560,
          700,
          TITLE,
          '#172235',
        ) + 26
      continue
    }
    const lines = wrapRichText(context, block, 940, 32, 400, 700, 64)
    y =
      drawRichLines(
        context,
        block,
        lines,
        70,
        y,
        54,
        32,
        400,
        700,
        INK,
        '#172235',
      ) + 28
  }
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
  const { coverBlocks, remainingBlocks } = takeXhsCoverIntro(renderableBlocks)
  const pages = remainingBlocks.length > 0 ? paginateXhsCardBlocks(remainingBlocks) : []
  const total = pages.length + 1
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
    if (index === 0) drawCover(context, parsed, coverBlocks, coverImage, total)
    else drawBodyPage(context, pages[index - 1].blocks, sourceImages, index + 1, total)
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

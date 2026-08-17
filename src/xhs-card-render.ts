/**
 * 小红书卡片绘制层(纯 Canvas 绘制,无 Obsidian/window 依赖)。
 *
 * 三种风格:
 * - classic  经典彩色:0.7.36 及以前的唯一版式,调色板取值必须与旧常量完全一致,
 *            保证默认输出逐像素不变(含右下角页码)。
 * - mono     黑白极简:同一套版式换黑白灰调色板(无页码,PART 描边框,引用带浅灰底)。
 * - x-dark   X 风格推文卡:黑底白字,每页都是完整推文框(头像/昵称/蓝勾/@账号 +
 *            正文 + 固定装饰互动条),无封面页无页码;分页由 paginateXTweetBlocks
 *            按块边界+真实测量装页,正文永不压进底部框架。
 *
 * 该模块可在 Node(@napi-rs/canvas)里直接渲染样片,便于发版前离线验收。
 */
import type { ParsedXhsCardDocument, XhsCardBlock } from './xhs-card-core'
import {
  findStructuralCut,
  shouldUseXhsSideBySideLayout,
  sliceXhsBlockText,
  XHS_BODY_IMAGE_MAX_HEIGHT,
  XHS_SIDE_IMAGE_MAX_HEIGHT,
  XHS_SIDE_IMAGE_WIDTH,
} from './xhs-card-core'

export const CARD_WIDTH = 1080
export const CARD_HEIGHT = 1440

const SERIF_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif'
const SANS_FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'

type Ctx = CanvasRenderingContext2D
type FontFamily = 'serif' | 'sans'

/** 可绘制的最小图片形状(浏览器 HTMLImageElement 与 @napi-rs/canvas Image 都满足) */
export interface DrawableImage {
  naturalWidth: number
  naturalHeight: number
}

export type XhsCardStyleId = 'classic' | 'mono' | 'x-dark'

export interface XhsPagePalette {
  paper: string
  title: string
  ink: string
  boldInk: string
  muted: string
  /** 章节标题/引用条主色(经典版的蓝) */
  accent: string
  /** 结构强调色(经典版的橙:标题边条与圆点) */
  mark: string
  partPillBg: string
  partPillInk: string
  partPillStyle: 'filled' | 'outline'
  quoteBg: string | null
  headingFamily: FontFamily
  bodyFamily: FontFamily
  /** 行首标点禁则;经典风格保持旧换行输出不变 */
  kinsoku: boolean
  showPageNumber: boolean
}

/** 经典彩色:取值 = 0.7.36 以前的模块常量,一字不改。 */
export const CLASSIC_PALETTE: XhsPagePalette = {
  paper: '#FFFFFF',
  title: '#252D38',
  ink: '#33383F',
  boldInk: '#172235',
  muted: '#7C8796',
  accent: '#1265E8',
  mark: '#F4B900',
  partPillBg: '#FFE38A',
  partPillInk: '#28518F',
  partPillStyle: 'filled',
  quoteBg: null,
  headingFamily: 'serif',
  bodyFamily: 'serif',
  kinsoku: false,
  showPageNumber: true,
}

/** 黑白极简:与公众号排版「极简黑白」主题同气质;无页码(方便换顺序发)。 */
export const MONO_PALETTE: XhsPagePalette = {
  paper: '#FFFFFF',
  title: '#111111',
  ink: '#262626',
  boldInk: '#000000',
  muted: '#8C8C8C',
  accent: '#111111',
  mark: '#111111',
  partPillBg: '#FFFFFF',
  partPillInk: '#1F1F1F',
  partPillStyle: 'outline',
  quoteBg: '#F5F5F5',
  headingFamily: 'sans',
  bodyFamily: 'sans',
  kinsoku: true,
  showPageNumber: false,
}

export function paletteForStyle(style: XhsCardStyleId): XhsPagePalette {
  return style === 'mono' ? MONO_PALETTE : CLASSIC_PALETTE
}

// ── 通用绘制工具 ─────────────────────────────────────

function roundedRect(context: Ctx, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function drawPaper(context: Ctx, color: string) {
  context.fillStyle = color
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
}

function setFont(context: Ctx, size: number, weight = 500, family: FontFamily = 'serif') {
  context.font = `${weight} ${size}px ${family === 'serif' ? SERIF_FONT : SANS_FONT}`
}

function wrapText(context: Ctx, text: string, maxWidth: number): string[] {
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
  context: Ctx,
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

function drawPageChrome(context: Ctx, palette: XhsPagePalette, page: number, total: number) {
  context.fillStyle = palette.muted
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

/** 行首禁则:这些标点不允许出现在行首(kinsoku 开启时跟随上一行,轻微超宽可接受) */
const NO_LINE_START = new Set('，。、；：？！）」』】》…‥,.;:?!)%')

export function wrapRichText(
  context: Ctx,
  block: XhsCardBlock,
  maxWidth: number,
  size: number,
  weight: number,
  boldWeight: number,
  firstLineIndent = 0,
  family: FontFamily = 'serif',
  kinsoku = false,
): RichLine[] {
  const lines: RichLine[] = []
  let start = 0
  let width = 0
  for (let index = 0; index < block.text.length; index++) {
    setFont(context, size, boldAt(block, index) ? boldWeight : weight, family)
    const charWidth = context.measureText(block.text[index]).width
    const lineMaxWidth = maxWidth - (lines.length === 0 ? firstLineIndent : 0)
    if (kinsoku && index > start && width + charWidth > lineMaxWidth && NO_LINE_START.has(block.text[index])) {
      width += charWidth
      continue
    }
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
  context: Ctx,
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
  family: FontFamily = 'serif',
): number {
  lines.forEach((line, lineIndex) => {
    let cursor = x + line.xOffset
    let segment = ''
    let segmentBold = boldAt(block, line.start)
    const flush = () => {
      if (!segment) return
      setFont(context, size, segmentBold ? boldWeight : weight, family)
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
  context: Ctx,
  image: DrawableImage,
  x: number,
  y: number,
  width: number,
  maxHeight: number,
): number {
  const scale = Math.min(width / image.naturalWidth, maxHeight / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.drawImage(
    image as CanvasImageSource,
    x + (width - drawWidth) / 2,
    y,
    drawWidth,
    drawHeight,
  )
  return drawHeight
}

// ── 经典/黑白极简:封面页 + 正文页 ────────────────────

export interface CoverFillResult {
  coverBlocks: XhsCardBlock[]
  remainingBlocks: XhsCardBlock[]
}

/**
 * 把封面装满(2026-08-17 Alina 拍板:封面与正文页一样,不留大空白):
 * 用与 drawCover 完全相同的字体几何预演光标,按块装填;段落/引用装不下时
 * 按句读(限最后一行内回退)或行边界切开装满封面,剩余接到正文页。
 * 标题块不切(本就短),遇到正文配图停止(配图属于正文页)。
 * 短文章因此可能一张封面卡装完,不再产生稀疏的第二页。
 */
export function fillCoverBlocks(
  context: Ctx,
  palette: XhsPagePalette,
  document: ParsedXhsCardDocument,
  coverImage: DrawableImage | null,
  blocks: XhsCardBlock[],
): CoverFillResult {
  setFont(context, 58, 700, palette.headingFamily)
  const titleLines = wrapText(context, document.title, 940).slice(0, 4)
  let cursor = 108 + titleLines.length * 76 + 14
  if (document.excerpt) {
    setFont(context, 27, 400, palette.headingFamily)
    cursor += wrapText(context, document.excerpt, 938).slice(0, coverImage ? 2 : 4).length * 43 + 20
  }
  if (coverImage) {
    const scale = Math.min(940 / coverImage.naturalWidth, 420 / coverImage.naturalHeight)
    cursor += coverImage.naturalHeight * scale + 30
  }
  const limit = palette.showPageNumber ? 1330 : 1360

  const coverBlocks: XhsCardBlock[] = []
  const remainingBlocks: XhsCardBlock[] = []
  for (const block of blocks) {
    if (remainingBlocks.length > 0 || block.kind === 'image') {
      remainingBlocks.push(block)
      continue
    }
    if (block.kind === 'heading') {
      setFont(context, 34, 700, palette.headingFamily)
      const height = 28 + wrapText(context, block.text, 900).length * 50 + 24
      if (cursor + height > limit) {
        remainingBlocks.push(block)
        continue
      }
      coverBlocks.push(block)
      cursor += height
      continue
    }
    const quote = block.kind === 'quote'
    const gap = quote ? 24 : 28
    const wrap = (target: XhsCardBlock) =>
      wrapRichText(context, target, quote ? 870 : 940, 29, quote ? 500 : 400, 700, 0, palette.bodyFamily, palette.kinsoku)
    const lines = wrap(block)
    const height = lines.length * 52 + gap
    if (cursor + height <= limit) {
      coverBlocks.push(block)
      cursor += height
      continue
    }
    const fitLines = Math.floor((limit - cursor - gap) / 52)
    if (fitLines < 1 || fitLines >= lines.length) {
      remainingBlocks.push(block)
      continue
    }
    const cut = findStructuralCut(block.text, lines[fitLines].start, lines[fitLines - 1].start)
    const head = sliceXhsBlockText(block, 0, cut)
    const tail = sliceXhsBlockText(block, cut, block.text.length)
    coverBlocks.push(head)
    cursor = limit
    if (tail.text.trim()) remainingBlocks.push(tail)
  }
  return { coverBlocks, remainingBlocks }
}

export function drawCover(
  context: Ctx,
  palette: XhsPagePalette,
  document: ParsedXhsCardDocument,
  coverBlocks: XhsCardBlock[],
  image: DrawableImage | null,
  total: number,
) {
  drawPaper(context, palette.paper)
  if (palette.showPageNumber) drawPageChrome(context, palette, 1, total)

  context.fillStyle = palette.title
  setFont(context, 58, 700, palette.headingFamily)
  const titleLines = wrapText(context, document.title, 940).slice(0, 4)
  let cursor = drawLines(context, titleLines, 70, 108, 76) + 14

  context.fillStyle = palette.muted
  setFont(context, 27, 400, palette.headingFamily)
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
      if (cursor > 108) cursor += 28
      context.fillStyle = palette.accent
      setFont(context, 34, 700, palette.headingFamily)
      const lines = wrapText(context, block.text, 900)
      cursor = drawLines(context, lines, 84, cursor, 50) + 24
      continue
    }
    if (block.kind === 'quote') {
      const lines = wrapRichText(context, block, 870, 29, 500, 700, 0, palette.bodyFamily, palette.kinsoku)
      const barHeight = Math.max(50, lines.length * 52 - 4)
      if (palette.quoteBg) {
        context.fillStyle = palette.quoteBg
        roundedRect(context, 70, cursor - 29 - 12, 940, barHeight + 24, 8)
        context.fill()
      }
      context.fillStyle = palette.accent
      roundedRect(context, 70, cursor - 29, 5, barHeight, 3)
      context.fill()
      cursor =
        drawRichLines(context, block, lines, 96, cursor, 52, 29, 500, 700, palette.ink, palette.boldInk, palette.bodyFamily) +
        24
      continue
    }
    const lines = wrapRichText(context, block, 940, 29, 400, 700, 0, palette.bodyFamily, palette.kinsoku)
    cursor =
      drawRichLines(context, block, lines, 70, cursor, 52, 29, 400, 700, palette.ink, palette.boldInk, palette.bodyFamily) +
      28
  }
}

export function drawBodyPage(
  context: Ctx,
  palette: XhsPagePalette,
  blocks: XhsCardBlock[],
  sourceImages: ReadonlyMap<XhsCardBlock, DrawableImage>,
  page: number,
  total: number,
) {
  drawPaper(context, palette.paper)
  if (palette.showPageNumber) drawPageChrome(context, palette, page, total)
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
          const lines = wrapRichText(context, text, textWidth - 32, 30, 560, 700, 0, palette.bodyFamily, palette.kinsoku)
          context.fillStyle = palette.accent
          roundedRect(context, textX, y - 31, 6, Math.max(56, lines.length * 58 - 4), 3)
          context.fill()
          textBottom = drawRichLines(
            context,
            text,
            lines,
            textX + 28,
            y,
            58,
            30,
            560,
            700,
            palette.title,
            palette.boldInk,
            palette.bodyFamily,
          )
        } else {
          const lines = wrapRichText(context, text, textWidth, 30, 400, 700, 0, palette.bodyFamily, palette.kinsoku)
          textBottom = drawRichLines(
            context,
            text,
            lines,
            textX,
            y,
            56,
            30,
            400,
            700,
            palette.ink,
            palette.boldInk,
            palette.bodyFamily,
          )
        }
        y = Math.max(y + imageHeight, textBottom) + 40
        index++
      } else if (image) {
        y +=
          drawContainedImage(
            context,
            image,
            70,
            y,
            940,
            Math.min(XHS_BODY_IMAGE_MAX_HEIGHT, block.imageMaxHeight ?? XHS_BODY_IMAGE_MAX_HEIGHT),
          ) +
          40
      }
      continue
    }
    if (block.kind === 'heading') {
      const primary = block.level !== 3
      if (y > 104) y += primary ? 48 : 36
      if (primary) {
        if (block.sectionIndex) {
          if (palette.partPillStyle === 'outline') {
            context.strokeStyle = palette.mark
            context.lineWidth = 3
            roundedRect(context, 70, y - 46, 224, 72, 8)
            context.stroke()
          } else {
            context.fillStyle = palette.partPillBg
            roundedRect(context, 70, y - 46, 224, 72, 36)
            context.fill()
          }
          context.fillStyle = palette.partPillInk
          setFont(context, 28, 650, 'sans')
          context.textAlign = 'center'
          context.fillText(`PART ${String(block.sectionIndex).padStart(2, '0')}`, 182, y + 2)
          context.textAlign = 'left'
          y += 112
        }
        context.fillStyle = palette.mark
        roundedRect(context, 70, y - 45, 7, 62, 3)
        context.fill()
        context.fillStyle = palette.accent
        setFont(context, 46, 700, palette.headingFamily)
        const lines = wrapText(context, block.text, 898)
        y = drawLines(context, lines, 105, y, 62) + 40
      } else {
        context.fillStyle = palette.mark
        context.beginPath()
        context.arc(78, y - 11, 6, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = palette.accent
        setFont(context, 38, 700, palette.headingFamily)
        const lines = wrapText(context, block.text, 900)
        y = drawLines(context, lines, 102, y, 56) + 32
      }
      continue
    }
    if (block.kind === 'quote') {
      const lines = wrapRichText(context, block, 880, 33, 560, 700, 0, palette.bodyFamily, palette.kinsoku)
      const barHeight = Math.max(56, lines.length * 60 - 4)
      if (palette.quoteBg) {
        context.fillStyle = palette.quoteBg
        roundedRect(context, 70, y - 33 - 14, 940, barHeight + 28, 8)
        context.fill()
      }
      context.fillStyle = palette.accent
      roundedRect(context, 70, y - 33, 6, barHeight, 3)
      context.fill()
      y =
        drawRichLines(
          context,
          block,
          lines,
          102,
          y,
          60,
          33,
          560,
          700,
          palette.title,
          palette.boldInk,
          palette.bodyFamily,
        ) + 34
      continue
    }
    const lines = wrapRichText(context, block, 940, 32, 400, 700, 0, palette.bodyFamily, palette.kinsoku)
    y =
      drawRichLines(
        context,
        block,
        lines,
        70,
        y,
        58,
        32,
        400,
        700,
        palette.ink,
        palette.boldInk,
        palette.bodyFamily,
      ) + 36
  }
}

// ── X 风格推文卡 ─────────────────────────────────────

const X_BG = '#000000'
const X_INK = '#E7E9EA'
const X_BOLD_INK = '#FFFFFF'
const X_MUTED = '#71767B'
const X_LINE = '#2F3336'
const X_BADGE = '#1D9BF0'

/** X 卡几何常量:分页预算与绘制共用同一份,保证测量与落笔一致。 */
export const X_TWEET_LAYOUT = {
  pad: 80,
  bodyWidth: 920,
  /** 正文区上沿(头部框架之下) */
  bodyTop: 272,
  /** 正文区下沿硬边界(底部框架之上,含安全距) */
  bodyBottom: 1150,
  // 正文 36px(Alina 2026-08-17 看 34/36 对比样片后拍板;原 44→40→36);
  // 行高/段距按原比例跟随,分页测量走同一份常量,无需另改。
  fontSize: 36,
  lineHeight: 67,
  paragraphGap: 36,
  imageGap: 40,
  imageMaxHeight: 500,
} as const

/** 固定的装饰性互动数据(整套写死;学员发布时它只是模板视觉的一部分)。 */
const X_FAKE_METRICS: { icon: keyof typeof X_ICON_PATHS; count: string }[] = [
  { icon: 'reply', count: '8.1K' },
  { icon: 'repost', count: '3.7K' },
  { icon: 'like', count: '56.4K' },
  { icon: 'bookmark', count: '4.7K' },
]
const X_FAKE_TIME = '上午 11:10'
const X_FAKE_VIEWS = '26.4K'

/** 24 视图框内自绘图标(非官方素材) */
const X_ICON_PATHS = {
  reply: 'M12 3C6.9 3 3 6.6 3 11c0 2.2 1 4.2 2.6 5.7L5 21l4.2-1.6c.9.2 1.8.4 2.8.4 5.1 0 9-3.6 9-8S17.1 3 12 3z',
  repost: 'M7 8h9l-2.5-2.5M17 16H8l2.5 2.5M17 8v5M7 16v-5',
  like: 'M12 20s-7-4.4-9-8.5C1.6 8 3.6 5 6.5 5c2 0 3.6 1.2 4.5 2.6 1-1.4 2.6-2.6 4.5-2.6 3 0 5 3 3.6 6.5C19 15.6 12 20 12 20z',
  bookmark: 'M7 4h10v17l-5-3.5L7 21z',
} as const

export interface XTweetPageOptions {
  nickname: string
  handle: string
  avatar: DrawableImage | null
  /** 生成日期(YYYY/MM/DD);时间与互动数字固定为装饰值 */
  dateText: string
}

function drawXIcon(context: Ctx, icon: keyof typeof X_ICON_PATHS, x: number, y: number, size: number) {
  context.save()
  context.translate(x, y)
  context.scale(size / 24, size / 24)
  context.strokeStyle = X_MUTED
  context.lineWidth = 1.8
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.stroke(new Path2D(X_ICON_PATHS[icon]))
  context.restore()
}

function drawXBadge(context: Ctx, centerX: number, centerY: number, radius: number) {
  context.fillStyle = X_BADGE
  context.beginPath()
  context.arc(centerX, centerY, radius, 0, Math.PI * 2)
  context.fill()
  context.save()
  context.translate(centerX - radius, centerY - radius)
  context.scale((radius * 2) / 24, (radius * 2) / 24)
  context.fillStyle = '#FFFFFF'
  context.fill(new Path2D('M10.4 16.2l-3.9-3.9 1.7-1.7 2.2 2.2 5.4-5.4 1.7 1.7z'))
  context.restore()
}

function drawXAvatar(context: Ctx, options: XTweetPageOptions) {
  const L = X_TWEET_LAYOUT
  const size = 116
  const centerX = L.pad + size / 2
  const centerY = 88 + size / 2
  context.save()
  context.beginPath()
  context.arc(centerX, centerY, size / 2, 0, Math.PI * 2)
  context.clip()
  if (options.avatar) {
    const image = options.avatar
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight)
    const drawWidth = image.naturalWidth * scale
    const drawHeight = image.naturalHeight * scale
    context.drawImage(
      image as CanvasImageSource,
      centerX - drawWidth / 2,
      centerY - drawHeight / 2,
      drawWidth,
      drawHeight,
    )
  } else {
    const gradient = context.createLinearGradient(L.pad, 88, L.pad + size, 88 + size)
    gradient.addColorStop(0, '#2B6CB0')
    gradient.addColorStop(1, '#63B3ED')
    context.fillStyle = gradient
    context.fillRect(L.pad, 88, size, size)
    const initial = Array.from(options.nickname.trim())[0] ?? 'A'
    context.fillStyle = '#FFFFFF'
    setFont(context, 56, 800, 'sans')
    context.textAlign = 'center'
    context.fillText(initial, centerX, centerY + 20)
    context.textAlign = 'left'
  }
  context.restore()
}

function drawXImage(context: Ctx, image: DrawableImage, y: number): number {
  const L = X_TWEET_LAYOUT
  const scale = Math.min(L.bodyWidth / image.naturalWidth, L.imageMaxHeight / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  const x = L.pad + (L.bodyWidth - drawWidth) / 2
  context.save()
  roundedRect(context, x, y, drawWidth, drawHeight, 16)
  context.clip()
  context.drawImage(image as CanvasImageSource, x, y, drawWidth, drawHeight)
  context.restore()
  context.strokeStyle = X_LINE
  context.lineWidth = 2
  roundedRect(context, x, y, drawWidth, drawHeight, 16)
  context.stroke()
  return drawHeight
}

export function drawXTweetPage(
  context: Ctx,
  blocks: XhsCardBlock[],
  sourceImages: ReadonlyMap<XhsCardBlock, DrawableImage>,
  options: XTweetPageOptions,
) {
  const L = X_TWEET_LAYOUT
  drawPaper(context, X_BG)

  // 头部:头像 + 昵称 + 蓝勾 + @账号
  drawXAvatar(context, options)
  context.fillStyle = X_INK
  setFont(context, 46, 800, 'sans')
  const nameX = L.pad + 146
  context.fillText(options.nickname, nameX, 152)
  const nameWidth = context.measureText(options.nickname).width
  drawXBadge(context, nameX + nameWidth + 36, 138, 20)
  context.fillStyle = X_MUTED
  setFont(context, 36, 400, 'sans')
  context.fillText(`@${options.handle}`, nameX, 206)

  // 正文:块边界分页已由 paginateXTweetBlocks 保证不越过 bodyBottom
  let y = L.bodyTop + 62
  for (const block of blocks) {
    if (block.kind === 'image') {
      const image = sourceImages.get(block)
      if (image) y += drawXImage(context, image, y - 44) + L.imageGap
      continue
    }
    const lines = wrapRichText(context, block, L.bodyWidth, L.fontSize, 400, 700, 0, 'sans', true)
    y = drawRichLines(
      context,
      block,
      lines,
      L.pad,
      y,
      L.lineHeight,
      L.fontSize,
      400,
      700,
      X_INK,
      X_BOLD_INK,
      'sans',
    ) + L.paragraphGap
  }

  // 底部固定框架:时间戳 + 分隔线 + 装饰互动条
  setFont(context, 32, 400, 'sans')
  context.fillStyle = X_MUTED
  let cursor = L.pad
  const timePrefix = `${X_FAKE_TIME} · ${options.dateText} · `
  context.fillText(timePrefix, cursor, 1240)
  cursor += context.measureText(timePrefix).width
  setFont(context, 32, 700, 'sans')
  context.fillStyle = X_INK
  context.fillText(X_FAKE_VIEWS, cursor, 1240)
  cursor += context.measureText(X_FAKE_VIEWS).width
  setFont(context, 32, 400, 'sans')
  context.fillStyle = X_MUTED
  context.fillText(' Views', cursor, 1240)

  context.fillStyle = X_LINE
  context.fillRect(L.pad, 1268, L.bodyWidth, 2)

  const iconSize = 46
  const iconY = 1306
  const starts = [88, 344, 600]
  setFont(context, 34, 400, 'sans')
  const last = X_FAKE_METRICS[X_FAKE_METRICS.length - 1]
  const lastWidth = iconSize + 16 + context.measureText(last.count).width
  starts.push(L.pad + L.bodyWidth - 8 - lastWidth)
  X_FAKE_METRICS.forEach((metric, index) => {
    const x = starts[index]
    drawXIcon(context, metric.icon, x, iconY, iconSize)
    context.fillStyle = X_MUTED
    setFont(context, 34, 400, 'sans')
    context.fillText(metric.count, x + iconSize + 16, iconY + 38)
  })
}

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { PDFDocument } from 'pdf-lib'
import { strToU8, zipSync } from 'fflate'
import {
  parseArtifactMarkdown,
  type ArtifactBlock,
  type ArtifactDocument,
  type CreateArtifactOperation,
} from './artifact-renderer-core'

export interface RenderedArtifact {
  binary: boolean
  data: string | ArrayBuffer
  mimeType: string
}

const BRAND = {
  orange: 'F39800',
  blue: '0057FF',
  ink: '172033',
  muted: '667085',
  pale: 'FFF7EA',
  line: 'E7EAF0',
  white: 'FFFFFF',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function artifactHtml(document: ArtifactDocument, theme: 'brand' | 'clean'): string {
  const blocks = document.blocks.map((block) => {
    if (block.type === 'heading') {
      const level = Math.min(4, Math.max(2, block.level + 1))
      return `<h${level}>${escapeHtml(block.text)}</h${level}>`
    }
    if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`
    if (block.type === 'quote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`
    if (block.type === 'code') return `<pre><code>${escapeHtml(block.text)}</code></pre>`
    if (block.type === 'rule') return '<hr>'
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`
    }
    const head = `<thead><tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
    const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
    return `<div class="table-wrap"><table>${head}${body}</table></div>`
  }).join('\n')
  const accent = theme === 'clean' ? '#1f2937' : `#${BRAND.orange}`
  const blue = theme === 'clean' ? '#475569' : `#${BRAND.blue}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{--accent:${accent};--blue:${blue};--ink:#172033;--muted:#667085;--line:#e7eaf0;--paper:#fff}
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:var(--ink);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.75}
    main{width:min(920px,calc(100% - 32px));margin:40px auto;padding:64px 72px;background:var(--paper);border-radius:18px;box-shadow:0 16px 50px rgba(23,32,51,.08)}
    header{border-left:8px solid var(--accent);padding:4px 0 4px 24px;margin-bottom:44px}h1{font-size:38px;line-height:1.25;margin:0}header p{margin:10px 0 0;color:var(--muted)}
    h2,h3,h4{line-height:1.4;margin:2em 0 .65em}h2{font-size:27px;color:var(--blue);border-bottom:1px solid var(--line);padding-bottom:.35em}h3{font-size:21px}h4{font-size:18px}
    p,li{font-size:17px}p{margin:.8em 0}li{margin:.35em 0}blockquote{margin:1.4em 0;padding:16px 20px;border-left:5px solid var(--accent);background:#fff7ea;border-radius:8px;color:#3d4657}
    pre{overflow:auto;padding:18px 20px;background:#111827;color:#f9fafb;border-radius:10px;line-height:1.55}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
    .table-wrap{overflow-x:auto;margin:1.5em 0}table{width:100%;border-collapse:collapse;font-size:15px}th,td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}th{background:#f7f8fa;color:var(--blue)}
    footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
    @media(max-width:680px){main{margin:0;width:100%;padding:36px 24px;border-radius:0}h1{font-size:30px}}
    @media print{body{background:#fff}main{width:100%;margin:0;padding:18mm;box-shadow:none}footer{break-inside:avoid}}
  </style>
</head>
<body><main><header><h1>${escapeHtml(document.title)}</h1><p>AI霖子 · 智能生成文档</p></header>${blocks}<footer>由 AI霖子生成 · 请在使用前核对关键信息</footer></main></body>
</html>`
}

function docxTable(block: Extract<ArtifactBlock, { type: 'table' }>): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: BRAND.line }
  const row = (cells: string[], header = false) => new TableRow({
    children: cells.map((cell) => new TableCell({
      shading: header ? { type: ShadingType.CLEAR, fill: 'F3F6FA' } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
      children: [new Paragraph({
        children: [new TextRun({ text: cell, bold: header, color: header ? BRAND.blue : BRAND.ink, font: 'Hiragino Sans GB' })],
      })],
    })),
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [row(block.headers, true), ...block.rows.map((cells) => row(cells))],
  })
}

async function artifactDocx(document: ArtifactDocument): Promise<ArrayBuffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      text: document.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 460 },
      children: [new TextRun({ text: 'AI霖子 · 智能生成文档', color: BRAND.muted, size: 20, font: 'Hiragino Sans GB' })],
    }),
  ]
  for (const block of document.blocks) {
    if (block.type === 'heading') {
      const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]
      children.push(new Paragraph({
        text: block.text,
        heading: headings[Math.max(0, Math.min(3, block.level - 1))],
        spacing: { before: 260, after: 120 },
      }))
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, font: 'Hiragino Sans GB', size: 22, color: BRAND.ink })],
        spacing: { after: 150, line: 360 },
      }))
    } else if (block.type === 'quote') {
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, italics: true, color: BRAND.muted, font: 'Hiragino Sans GB' })],
        indent: { left: 420 },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: BRAND.orange, space: 10 } },
        spacing: { before: 120, after: 160 },
      }))
    } else if (block.type === 'code') {
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, font: 'Menlo', size: 18, color: BRAND.ink })],
        shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
        spacing: { before: 100, after: 160 },
      }))
    } else if (block.type === 'rule') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BRAND.line, space: 8 } } }))
    } else if (block.type === 'list') {
      block.items.forEach((item, index) => children.push(new Paragraph({
        children: [new TextRun({ text: item, font: 'Hiragino Sans GB', size: 22 })],
        bullet: block.ordered ? undefined : { level: 0 },
        numbering: block.ordered ? { reference: 'artifact-numbering', level: 0, instance: 1 } : undefined,
        spacing: { after: 80, line: 320 },
      })))
    } else {
      children.push(docxTable(block))
    }
  }
  const doc = new Document({
    creator: 'AI霖子',
    title: document.title,
    description: '由 AI霖子 Obsidian 插件生成',
    numbering: {
      config: [{
        reference: 'artifact-numbering',
        levels: [{
          level: 0,
          format: 'decimal',
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    styles: {
      default: { document: { run: { font: 'Hiragino Sans GB', size: 22, color: BRAND.ink } } },
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'AI霖子  ·  ', color: BRAND.muted, size: 18 }),
              new TextRun({ children: [PageNumber.CURRENT], color: BRAND.muted, size: 18 }),
            ],
          })],
        }),
      },
    }],
  })
  const blob = await Packer.toBlob(doc)
  return blob.arrayBuffer()
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    for (const character of Array.from(paragraph)) {
      const next = line + character
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line)
        line = character
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PDF 页面渲染失败')), 'image/png')
  })
}

async function artifactPdf(artifactDocument: ArtifactDocument, theme: 'brand' | 'clean'): Promise<ArrayBuffer> {
  if (typeof window === 'undefined' || !window.document) {
    throw new Error('PDF 只能在 Obsidian 桌面环境中生成')
  }
  const pageWidth = 1240
  const pageHeight = 1754
  const margin = 104
  const bottom = pageHeight - 104
  const accent = theme === 'clean' ? '#1f2937' : `#${BRAND.orange}`
  const pages: HTMLCanvasElement[] = []
  let canvas: HTMLCanvasElement
  let context!: CanvasRenderingContext2D
  let y = 0

  const newPage = (first = false) => {
    canvas = window.document.createElement('canvas')
    canvas.width = pageWidth
    canvas.height = pageHeight
    const next = canvas.getContext('2d')
    if (!next) throw new Error('当前 Obsidian 无法创建 PDF 画布')
    context = next
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, pageWidth, pageHeight)
    context.fillStyle = accent
    context.fillRect(0, 0, 18, pageHeight)
    context.fillStyle = '#98A2B3'
    context.font = '24px "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillText(`AI霖子  ·  ${pages.length + 1}`, margin, pageHeight - 52)
    y = first ? 170 : 110
    pages.push(canvas)
  }

  const ensure = (height: number) => {
    if (y + height > bottom) newPage()
  }
  const drawText = (text: string, options: { size: number; color?: string; bold?: boolean; indent?: number; gap?: number }) => {
    const indent = options.indent ?? 0
    context.font = `${options.bold ? '700' : '400'} ${options.size}px "PingFang SC", "Microsoft YaHei", sans-serif`
    const lineHeight = Math.round(options.size * 1.58)
    const lines = wrapCanvasText(context, text, pageWidth - margin * 2 - indent)
    for (const line of lines) {
      ensure(lineHeight)
      context.fillStyle = options.color ?? `#${BRAND.ink}`
      context.fillText(line, margin + indent, y)
      y += lineHeight
    }
    y += options.gap ?? Math.round(options.size * .55)
  }

  newPage(true)
  context.fillStyle = accent
  context.fillRect(margin, 108, 14, 132)
  drawText(artifactDocument.title, { size: 58, bold: true, indent: 38, gap: 30 })
  drawText('AI霖子 · 智能生成文档', { size: 25, color: `#${BRAND.muted}`, indent: 38, gap: 64 })

  for (const block of artifactDocument.blocks) {
    if (block.type === 'heading') {
      drawText(block.text, { size: block.level <= 2 ? 38 : 31, color: block.level <= 2 ? `#${BRAND.blue}` : `#${BRAND.ink}`, bold: true, gap: 22 })
    } else if (block.type === 'paragraph') {
      drawText(block.text, { size: 28, gap: 20 })
    } else if (block.type === 'quote') {
      ensure(70)
      context.fillStyle = accent
      context.fillRect(margin, y - 30, 8, 56)
      drawText(block.text, { size: 27, color: '#475467', indent: 30, gap: 24 })
    } else if (block.type === 'code') {
      drawText(block.text, { size: 23, color: '#344054', indent: 18, gap: 24 })
    } else if (block.type === 'rule') {
      ensure(42)
      context.strokeStyle = `#${BRAND.line}`
      context.beginPath()
      context.moveTo(margin, y)
      context.lineTo(pageWidth - margin, y)
      context.stroke()
      y += 42
    } else if (block.type === 'list') {
      block.items.forEach((item, index) => drawText(`${block.ordered ? `${index + 1}.` : '•'} ${item}`, { size: 27, indent: 18, gap: 8 }))
      y += 14
    } else {
      const rows = [block.headers, ...block.rows]
      for (const [index, row] of rows.entries()) {
        drawText(`${index === 0 ? '' : '• '}${row.join('  |  ')}`, { size: index === 0 ? 25 : 23, bold: index === 0, color: index === 0 ? `#${BRAND.blue}` : `#${BRAND.ink}`, gap: 8 })
      }
      y += 18
    }
  }

  const pdf = await PDFDocument.create()
  pdf.setTitle(artifactDocument.title)
  pdf.setAuthor('AI霖子')
  pdf.setCreator('AI霖子 Obsidian 插件')
  for (const pageCanvas of pages) {
    const bytes = await (await canvasBlob(pageCanvas)).arrayBuffer()
    const image = await pdf.embedPng(bytes)
    const page = pdf.addPage([595.28, 841.89])
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 })
  }
  return (await pdf.save()).buffer as ArrayBuffer
}

function slideText(block: ArtifactBlock): string[] {
  if (block.type === 'heading') return [`§ ${block.text}`]
  if (block.type === 'paragraph' || block.type === 'quote') return [block.text]
  if (block.type === 'code') return [block.text]
  if (block.type === 'rule') return []
  if (block.type === 'list') return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '•'} ${item}`)
  return [block.headers.join('  |  '), ...block.rows.map((row) => row.join('  |  '))]
}

function pptxPages(document: ArtifactDocument): Array<{ title: string; lines: string[] }> {
  const pages: Array<{ title: string; lines: string[] }> = []
  let current = { title: '核心内容', lines: [] as string[] }
  let chars = 0
  const flush = () => {
    if (current.lines.length > 0) pages.push(current)
    current = { title: '核心内容', lines: [] }
    chars = 0
  }
  for (const block of document.blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      flush()
      current.title = block.text
      continue
    }
    for (const line of slideText(block)) {
      const chunks = line.match(/[\s\S]{1,180}/g) ?? []
      for (const chunk of chunks) {
        if (chars + chunk.length > 520 || current.lines.length >= 10) {
          const continuingTitle = current.title
          flush()
          current.title = `${continuingTitle}（续）`
        }
        current.lines.push(chunk)
        chars += chunk.length
      }
    }
  }
  flush()
  return pages.length > 0 ? pages : [{ title: '核心内容', lines: ['内容已生成，请根据实际情况补充。'] }]
}

async function artifactPptx(document: ArtifactDocument, theme: 'brand' | 'clean'): Promise<ArrayBuffer> {
  const accent = theme === 'clean' ? '1F2937' : BRAND.orange
  const pages = pptxPages(document)
  const slides = [
    pptxSlide([
      pptxRect(2, 0, 0, .18, 7.5, accent),
      pptxRect(3, .18, 0, 13.15, .12, BRAND.blue),
      pptxText(4, document.title, 1, 2.05, 11.2, 1.5, { size: 34, bold: true, color: BRAND.ink }),
      pptxText(5, 'AI霖子 · 智能生成演示文稿', 1.03, 3.78, 8, .45, { size: 15, color: BRAND.muted }),
      pptxRect(6, 1.03, 4.42, 2, .05, accent),
    ]),
    ...pages.map((page, index) => {
      const lineHeight = Math.min(.72, 5.25 / Math.max(1, page.lines.length))
      const shapes = [
        pptxRect(2, 0, 0, .13, 7.5, accent),
        pptxText(3, page.title, .75, .55, 11.6, .65, { size: 25, bold: true, color: BRAND.blue }),
        pptxRect(4, .75, 1.35, 11.75, .012, BRAND.line),
        ...page.lines.map((line, lineIndex) => {
          const isSection = line.startsWith('§ ')
          return pptxText(
            5 + lineIndex,
            isSection ? line.slice(2) : line,
            isSection ? .85 : 1.02,
            1.65 + lineIndex * lineHeight,
            isSection ? 11.45 : 11.1,
            Math.max(.42, lineHeight - .05),
            { size: isSection ? 20 : 17, bold: isSection, color: isSection ? BRAND.ink : '344054' },
          )
        }),
        pptxText(30, `${index + 2} / ${pages.length + 1}`, 11.8, 7.03, .8, .22, { size: 9, color: '98A2B3', align: 'r' }),
      ]
      return pptxSlide(shapes)
    }),
  ]
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(pptxContentTypes(slides.length)),
    '_rels/.rels': strToU8(PPTX_ROOT_RELS),
    'docProps/app.xml': strToU8(pptxApp(slides.length)),
    'docProps/core.xml': strToU8(pptxCore(document.title)),
    'ppt/presentation.xml': strToU8(pptxPresentation(slides.length)),
    'ppt/_rels/presentation.xml.rels': strToU8(pptxPresentationRels(slides.length)),
    'ppt/theme/theme1.xml': strToU8(PPTX_THEME),
    'ppt/slideMasters/slideMaster1.xml': strToU8(PPTX_MASTER),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(PPTX_MASTER_RELS),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(PPTX_LAYOUT),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(PPTX_LAYOUT_RELS),
  }
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide)
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(PPTX_SLIDE_RELS)
  })
  const archive = zipSync(files, { level: 6 })
  return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
}

const PPTX_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const EMU = 914400
const pptxEmu = (value: number) => Math.round(value * EMU)

function pptxRect(id: number, x: number, y: number, width: number, height: number, color: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rectangle ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${pptxEmu(x)}" y="${pptxEmu(y)}"/><a:ext cx="${pptxEmu(width)}" cy="${pptxEmu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
}

function pptxText(
  id: number,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: { size: number; color: string; bold?: boolean; align?: 'l' | 'r' | 'ctr' },
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${pptxEmu(x)}" y="${pptxEmu(y)}"/><a:ext cx="${pptxEmu(width)}" cy="${pptxEmu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr" lIns="0" rIns="0" tIns="0" bIns="0"/><a:lstStyle/><a:p><a:pPr algn="${options.align ?? 'l'}"/><a:r><a:rPr lang="zh-CN" sz="${options.size * 100}"${options.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${options.color}"/></a:solidFill><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/></a:rPr><a:t>${escapeHtml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${options.size * 100}"/></a:p></p:txBody></p:sp>`
}

function pptxSlide(shapes: string[]): string {
  return `${PPTX_XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function pptxContentTypes(slideCount: number): string {
  const slideTypes = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  return `${PPTX_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideTypes}</Types>`
}

function pptxCore(title: string): string {
  const now = new Date().toISOString()
  return `${PPTX_XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeHtml(title)}</dc:title><dc:creator>AI霖子</dc:creator><cp:lastModifiedBy>AI霖子</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
}

function pptxPresentation(slideCount: number): string {
  const ids = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  return `${PPTX_XML}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
}

function pptxPresentationRels(slideCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
  return `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}</Relationships>`
}

const PPTX_ROOT_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
const pptxApp = (slideCount: number) => `${PPTX_XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>AI霖子</Application><PresentationFormat>宽屏</PresentationFormat><Slides>${slideCount}</Slides><Company>AI霖子</Company><AppVersion>1.0</AppVersion></Properties>`
const PPTX_SLIDE_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const PPTX_LAYOUT_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
const PPTX_MASTER_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const PPTX_LAYOUT = `${PPTX_XML}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
const PPTX_MASTER = `${PPTX_XML}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
const PPTX_THEME = `${PPTX_XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AI霖子"><a:themeElements><a:clrScheme name="AI霖子"><a:dk1><a:srgbClr val="172033"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="344054"/></a:dk2><a:lt2><a:srgbClr val="F4F6F8"/></a:lt2><a:accent1><a:srgbClr val="0057FF"/></a:accent1><a:accent2><a:srgbClr val="F39800"/></a:accent2><a:accent3><a:srgbClr val="12B76A"/></a:accent3><a:accent4><a:srgbClr val="7F56D9"/></a:accent4><a:accent5><a:srgbClr val="06AED4"/></a:accent5><a:accent6><a:srgbClr val="F04438"/></a:accent6><a:hlink><a:srgbClr val="0057FF"/></a:hlink><a:folHlink><a:srgbClr val="7F56D9"/></a:folHlink></a:clrScheme><a:fontScheme name="AI霖子"><a:majorFont><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="AI霖子"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

export async function renderArtifact(operation: CreateArtifactOperation): Promise<RenderedArtifact> {
  const document = parseArtifactMarkdown(operation.content, operation.title)
  const theme = operation.theme ?? 'brand'
  if (operation.format === 'html') {
    return { binary: false, data: artifactHtml(document, theme), mimeType: 'text/html' }
  }
  if (operation.format === 'docx') {
    return { binary: true, data: await artifactDocx(document), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  }
  if (operation.format === 'pdf') {
    return { binary: true, data: await artifactPdf(document, theme), mimeType: 'application/pdf' }
  }
  return { binary: true, data: await artifactPptx(document, theme), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
}

import { unzipSync, strFromU8, type UnzipFileInfo } from 'fflate'

export const LOCAL_SEARCH_EXTENSIONS = new Set([
  'md', 'txt', 'pdf', 'docx', 'html', 'htm', 'pptx', 'xlsx',
])

export const LOCAL_SEARCH_FILE_LIMITS: Record<string, number> = {
  md: 8 * 1024 * 1024,
  txt: 8 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  html: 8 * 1024 * 1024,
  htm: 8 * 1024 * 1024,
  pptx: 50 * 1024 * 1024,
  xlsx: 25 * 1024 * 1024,
}

const MAX_DOCX_XML_BYTES = 12 * 1024 * 1024
export const MAX_OFFICE_XML_TOTAL_BYTES = 32 * 1024 * 1024
export const MAX_OFFICE_XML_ENTRIES = 2_048
/** 单张内嵌图上限 12MB：再大的图对 1400px 课件没有意义，直接跳过。 */
const MAX_DOCX_MEDIA_BYTES = 12 * 1024 * 1024
/** 单份 Word 最多带出的图片数，防超长文档把课件撑爆。 */
const MAX_DOCX_IMAGES = 40
const MAX_XLSX_COLUMNS = 256
const MAX_XLSX_ROWS = 20_000
/** 原始 HTML 里标签占比很高；先按放大的上限解码，剥完标签再截到目标字数。 */
const MAX_RAW_HTML_CHARS = 1_500_000

export function isLocalSearchExtension(extension: string): boolean {
  return LOCAL_SEARCH_EXTENSIONS.has(extension.toLocaleLowerCase())
}

export function decodePlainText(data: Uint8Array, maxChars: number): string {
  const utf8 = new TextDecoder('utf-8').decode(data)
  const replacementCount = countCharacter(utf8, '\uFFFD')
  if (replacementCount <= Math.max(2, utf8.length * 0.005)) {
    return cleanExtractedText(utf8, maxChars)
  }
  try {
    const gb18030 = new TextDecoder('gb18030').decode(data)
    if (countCharacter(gb18030, '\uFFFD') < replacementCount) {
      return cleanExtractedText(gb18030, maxChars)
    }
  } catch {
    // 部分旧环境不提供 gb18030；UTF-8 的容错结果仍可用于搜索。
  }
  return cleanExtractedText(utf8, maxChars)
}

export function extractDocxText(data: Uint8Array, maxChars: number): string {
  const files = unzipOfficeXml(data, isSearchableDocxXml)
  const names = Object.keys(files).sort(docxXmlOrder)
  const parts: string[] = []
  let chars = 0
  for (const name of names) {
    const xml = strFromU8(files[name])
    const text = wordXmlToText(xml)
    if (!text) continue
    const remaining = maxChars - chars
    if (remaining <= 0) break
    parts.push(text.slice(0, remaining))
    chars += Math.min(text.length, remaining)
  }
  return cleanExtractedText(parts.join('\n\n'), maxChars)
}

export interface DocxImage {
  /** 正文里对应的占位令牌，形如 `![](docx-image-1)`，模型按它引用这张图。 */
  token: string
  /** zip 内的原始文件名，用于推断 MIME。 */
  name: string
  bytes: Uint8Array
}

export interface DocxWithImages {
  /** 与 extractDocxText 相同的正文，但在图片原始位置插入了占位令牌。 */
  text: string
  images: DocxImage[]
}

/**
 * 提取 Word 正文 **并按原始位置带出内嵌图片**（0.7.64，课件PPT 用）。
 *
 * docx 本质是 zip：正文在 word/document.xml，图片实体在 word/media/*，
 * 二者靠 word/_rels/document.xml.rels 的 rId 关联。这里在正文转文字前，
 * 把 <w:drawing>/<w:pict> 整段替换成占位令牌，令牌顺序即图片在文中的顺序，
 * 模型因此能把图片排到讲对应内容的那一页。图片二进制只留在本机、不上传。
 */
export function extractDocxTextWithImages(data: Uint8Array, maxChars: number): DocxWithImages {
  const files = unzipSync(data, {
    filter(file: UnzipFileInfo) {
      if (file.name === 'word/document.xml') return true
      if (file.name === 'word/_rels/document.xml.rels') return true
      if (!/^word\/media\/[^/]+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return false
      // 单张过大的图不进课件（课件图片会被压到 1400px，原图再大也没意义）。
      return file.originalSize <= MAX_DOCX_MEDIA_BYTES
    },
  })
  const documentXml = files['word/document.xml']
  if (!documentXml) return { text: '', images: [] }

  // rId → media 路径
  const relsXml = files['word/_rels/document.xml.rels']
  const relTarget = new Map<string, string>()
  if (relsXml) {
    const rels = strFromU8(relsXml)
    for (const match of rels.matchAll(/<Relationship\b[^>]*>/gi)) {
      const tag = match[0]
      const id = /\bId="([^"]+)"/i.exec(tag)?.[1]
      const target = /\bTarget="([^"]+)"/i.exec(tag)?.[1]
      if (!id || !target) continue
      if (!/image/i.test(/\bType="([^"]+)"/i.exec(tag)?.[1] ?? '')) continue
      relTarget.set(id, `word/${target.replace(/^\.?\//, '').replace(/^\.\.\//, '')}`)
    }
  }

  const images: DocxImage[] = []
  const seen = new Map<string, string>() // media 路径 → 已分配令牌（同一张图复用）
  const placeholder = (block: string): string => {
    if (images.length >= MAX_DOCX_IMAGES) return ''
    const rid = /r:(?:embed|id|link)="([^"]+)"/i.exec(block)?.[1]
    const path = rid ? relTarget.get(rid) : undefined
    if (!path) return ''
    const existing = seen.get(path)
    if (existing) return `\n${existing}\n`
    const bytes = files[path]
    if (!bytes || bytes.length === 0) return ''
    const token = `![](docx-image-${images.length + 1})`
    seen.set(path, token)
    images.push({ token, name: path, bytes })
    return `\n${token}\n`
  }

  const withTokens = strFromU8(documentXml)
    .replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/gi, (block) => placeholder(block))
    .replace(/<w:pict\b[\s\S]*?<\/w:pict>/gi, (block) => placeholder(block))
  const text = cleanExtractedText(wordXmlToText(withTokens), maxChars)
  // 正文被 maxChars 截断时，落在截断之后的图片一并丢弃，避免模型引用看不见的图。
  const kept = images.filter((image) => text.includes(image.token))
  return { text, images: kept }
}

export function extractPptxText(data: Uint8Array, maxChars: number): string {
  const files = unzipOfficeXml(data, isSearchablePptxXml)
  const names = Object.keys(files).sort(pptxXmlOrder)
  const parts: string[] = []
  let chars = 0
  for (const name of names) {
    const xml = strFromU8(files[name])
    const text = drawingXmlToText(xml)
    if (!text) continue
    const slide = name.match(/slide(\d+)\.xml$/i)?.[1]
    const label = /notesSlide/i.test(name) ? `【第 ${slide} 页备注】` : `【第 ${slide} 页】`
    const remaining = maxChars - chars
    if (remaining <= 0) break
    const block = `${label}\n${text}`.slice(0, remaining)
    parts.push(block)
    chars += block.length
  }
  return cleanExtractedText(parts.join('\n\n'), maxChars)
}

/**
 * Office Open XML（DOCX/PPTX/XLSX）安全解压：单项、总解压量和条目数三道上限。
 * fflate 会在 filter 返回 true 后按 originalSize 分配内存，所以必须在这里累计，
 * 不能等 unzipSync 完成后才检查。
 */
function unzipOfficeXml(
  data: Uint8Array,
  searchable: (name: string) => boolean,
): Record<string, Uint8Array> {
  let entries = 0
  let totalBytes = 0
  return unzipSync(data, {
    filter(file: UnzipFileInfo) {
      if (!searchable(file.name)) return false
      if (file.originalSize > MAX_DOCX_XML_BYTES) {
        throw new Error('Office 文件内部单个 XML 解压后过大，请拆分文档后重试')
      }
      entries += 1
      totalBytes += file.originalSize
      if (entries > MAX_OFFICE_XML_ENTRIES) {
        throw new Error(`Office 文件内部 XML 超过 ${MAX_OFFICE_XML_ENTRIES} 个，已停止解析`)
      }
      if (totalBytes > MAX_OFFICE_XML_TOTAL_BYTES) {
        throw new Error('Office 文件解压后 XML 总量超过 32MB，请拆分文档后重试')
      }
      return true
    },
  })
}

export function extractXlsxText(data: Uint8Array, maxChars: number): string {
  const files = unzipOfficeXml(data, isSearchableXlsxXml)
  const workbookXml = textOf(files, 'xl/workbook.xml')
  const relationships = workbookRelationships(textOf(files, 'xl/_rels/workbook.xml.rels'))
  const sharedStrings = xlsxSharedStrings(textOf(files, 'xl/sharedStrings.xml'))
  const dateStyles = xlsxDateStyles(textOf(files, 'xl/styles.xml'))
  const date1904 = /<workbookPr\b[^>]*\bdate1904=["'](?:1|true)["']/i.test(workbookXml)
  const sheets = workbookSheets(workbookXml, relationships, Object.keys(files))
  const parts: string[] = []
  let chars = 0
  for (const sheet of sheets) {
    const remaining = maxChars - chars
    if (remaining <= 0) break
    const xml = textOf(files, sheet.path)
    if (!xml) continue
    const table = worksheetXmlToText(xml, sharedStrings, dateStyles, date1904, remaining)
    if (!table) continue
    const block = `【工作表：${sheet.name}】\n${table}`.slice(0, remaining)
    parts.push(block)
    chars += block.length + 2
  }
  return cleanExtractedText(parts.join('\n\n'), maxChars)
}

function isSearchableXlsxXml(name: string): boolean {
  return (
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name) ||
    /^xl\/(?:workbook|sharedStrings|styles)\.xml$/i.test(name) ||
    /^xl\/_rels\/workbook\.xml\.rels$/i.test(name)
  )
}

function textOf(files: Record<string, Uint8Array>, path: string): string {
  const data = files[path]
  return data ? strFromU8(data) : ''
}

function xmlAttribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))
  return match ? decodeXmlEntities(match[2]) : ''
}

function normalizeArchivePath(value: string): string {
  const parts: string[] = []
  for (const segment of value.replace(/^\/+/, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

function workbookRelationships(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
    const id = xmlAttribute(match[0], 'Id')
    const target = xmlAttribute(match[0], 'Target')
    if (!id || !target || /:/.test(target.split('/')[0])) continue
    const path = target.startsWith('/')
      ? normalizeArchivePath(target)
      : normalizeArchivePath(`xl/${target}`)
    out.set(id, path)
  }
  return out
}

function workbookSheets(
  workbookXml: string,
  relationships: Map<string, string>,
  names: string[],
): Array<{ name: string; path: string }> {
  const sheets: Array<{ name: string; path: string }> = []
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/gi)) {
    const name = xmlAttribute(match[0], 'name') || `Sheet${sheets.length + 1}`
    const relationshipId = xmlAttribute(match[0], 'r:id')
    const path = relationships.get(relationshipId)
    if (path && /^xl\/worksheets\/sheet\d+\.xml$/i.test(path)) sheets.push({ name, path })
  }
  if (sheets.length > 0) return sheets
  return names
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => xlsxSheetIndex(left) - xlsxSheetIndex(right))
    .map((path, index) => ({ name: `Sheet${index + 1}`, path }))
}

function xlsxSheetIndex(path: string): number {
  return Number.parseInt(path.match(/sheet(\d+)\.xml$/i)?.[1] ?? '0', 10)
}

function xlsxSharedStrings(xml: string): string[] {
  const values: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    const text = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map((item) => decodeXmlEntities(item[1]))
      .join('')
    values.push(text)
  }
  return values
}

function xlsxDateStyles(xml: string): Set<number> {
  const customDateFormats = new Set<number>()
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/?\s*>/gi)) {
    const id = Number.parseInt(xmlAttribute(match[0], 'numFmtId'), 10)
    const format = xmlAttribute(match[0], 'formatCode')
      .replace(/"[^"]*"/g, '')
      .replace(/\[[^\]]*]/g, '')
      .replace(/\\./g, '')
    if (Number.isFinite(id) && /[ymdhs]/i.test(format)) customDateFormats.add(id)
  }
  const builtInDateFormats = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  ])
  const dateStyles = new Set<number>()
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] ?? ''
  let styleIndex = 0
  for (const match of cellXfs.matchAll(/<xf\b[^>]*\/?\s*>/gi)) {
    const numFmtId = Number.parseInt(xmlAttribute(match[0], 'numFmtId'), 10)
    if (builtInDateFormats.has(numFmtId) || customDateFormats.has(numFmtId)) {
      dateStyles.add(styleIndex)
    }
    styleIndex += 1
  }
  return dateStyles
}

function worksheetXmlToText(
  xml: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
  maxChars: number,
): string {
  const lines: string[] = []
  let chars = 0
  let rowCount = 0
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    rowCount += 1
    if (rowCount > MAX_XLSX_ROWS || chars >= maxChars) break
    const cells = new Map<number, string>()
    let lastColumn = 0
    let fallbackColumn = 1
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const tag = cellMatch[1]
      const inner = cellMatch[2] ?? ''
      const ref = xmlAttribute(tag, 'r')
      const column = xlsxColumnIndex(ref) || fallbackColumn
      fallbackColumn = column + 1
      if (column > MAX_XLSX_COLUMNS) continue
      const type = xmlAttribute(tag, 't')
      const style = Number.parseInt(xmlAttribute(tag, 's'), 10)
      const value = xlsxCellText(inner, type, sharedStrings, dateStyles.has(style), date1904)
      if (!value) continue
      cells.set(column, value)
      lastColumn = Math.max(lastColumn, column)
    }
    if (lastColumn === 0) continue
    const line = Array.from({ length: lastColumn }, (_, index) => cells.get(index + 1) ?? '').join('\t')
    if (chars + line.length + 1 > maxChars) break
    lines.push(line)
    chars += line.length + 1
  }
  return lines.join('\n')
}

function xlsxColumnIndex(reference: string): number {
  const letters = reference.match(/^([A-Z]+)/i)?.[1]?.toUpperCase() ?? ''
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  return value
}

function xlsxCellText(
  inner: string,
  type: string,
  sharedStrings: string[],
  isDate: boolean,
  date1904: boolean,
): string {
  if (type === 'inlineStr') {
    return cleanXlsxCell(
      [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
        .map((match) => decodeXmlEntities(match[1]))
        .join(''),
    )
  }
  const raw = decodeXmlEntities(inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '')
  if (type === 's') return cleanXlsxCell(sharedStrings[Number.parseInt(raw, 10)] ?? '')
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (type === 'e') return cleanXlsxCell(raw)
  if (type === 'd') return cleanXlsxCell(raw)
  if (isDate && /^-?\d+(?:\.\d+)?$/.test(raw)) return excelSerialDate(Number(raw), date1904)
  const formula = decodeXmlEntities(inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/i)?.[1] ?? '')
  if (raw) return cleanXlsxCell(raw)
  return formula ? cleanXlsxCell(`=${formula}`) : ''
}

function cleanXlsxCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

function excelSerialDate(serial: number, date1904: boolean): string {
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)
  const date = new Date(epoch + serial * 86_400_000)
  if (!Number.isFinite(date.getTime())) return String(serial)
  const iso = date.toISOString()
  return Math.abs(serial - Math.trunc(serial)) < 1e-9
    ? iso.slice(0, 10)
    : iso.replace('T', ' ').slice(0, 16)
}

export function extractHtmlText(data: Uint8Array, maxChars: number): string {
  const raw = decodePlainText(data, Math.min(Math.max(maxChars * 8, maxChars), MAX_RAW_HTML_CHARS))
  const title = raw.match(/<title[^>]*>([^<]{0,300})<\/title>/i)?.[1]?.trim()
  const body = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|figure|figcaption|table|ul|ol|dd|dt)\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
  const text = decodeXmlEntities(body)
  return cleanExtractedText(title ? `${title}\n${text}` : text, maxChars)
}

export async function extractPdfText(data: Uint8Array, maxChars: number): Promise<string> {
  // PDF.js touches DOMMatrix and other browser globals while its module is
  // initialized. Some supported Windows/Obsidian combinations do not expose
  // those globals until the workspace renderer is ready. Loading PDF.js during
  // plugin startup would therefore make the whole plugin fail before a user
  // ever asks to read a PDF. Keep the heavy parser completely lazy.
  const [{ getDocument }, { WorkerMessageHandler }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ])
  // Community plugins ship as one main.js, so expose the bundled worker handler
  // as a local fake worker. No CDN, remote script or server is involved.
  const runtimeWindow = (
    globalThis as typeof globalThis & { activeWindow?: Window; window?: Window }
  ).activeWindow ?? globalThis.window
  if (!runtimeWindow) throw new Error('当前 Obsidian 窗口尚未就绪，请稍后重试读取 PDF')
  const pdfjsWindow = runtimeWindow as Window & {
    pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler }
  }
  pdfjsWindow.pdfjsWorker ??= { WorkerMessageHandler }

  const loadingTask = getDocument({
    data: data.slice(),
    password: '',
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: false,
  })
  const pages: string[] = []
  let chars = 0
  try {
    const document = await loadingTask.promise
    for (let pageNumber = 1; pageNumber <= document.numPages && chars < maxChars; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue
        pageText += item.str
        pageText += item.hasEOL ? '\n' : ' '
        if (chars + pageText.length >= maxChars) break
      }
      pageText = pageText.trim()
      if (!pageText) continue
      const remaining = maxChars - chars
      pages.push(pageText.slice(0, remaining))
      chars += Math.min(pageText.length, remaining)
    }
  } finally {
    await loadingTask.destroy().catch(() => undefined)
  }
  return cleanExtractedText(pages.join('\n\n'), maxChars)
}

function isSearchablePptxXml(name: string): boolean {
  return (
    /^ppt\/slides\/slide\d+\.xml$/i.test(name) ||
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)
  )
}

function pptxXmlOrder(left: string, right: string): number {
  const kind = (name: string) => (/notesSlide/i.test(name) ? 1 : 0)
  const index = (name: string) => Number.parseInt(name.match(/(\d+)\.xml$/i)?.[1] ?? '0', 10)
  return kind(left) - kind(right) || index(left) - index(right)
}

/** PPTX 的文字都在 DrawingML `<a:t>` 里；段落/换行/表格标签转成对应空白。 */
function drawingXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<a:br\b[^>]*\/>/gi, '\n')
      .replace(/<\/a:p>/gi, '\n')
      .replace(/<\/a:tc>/gi, '\t')
      .replace(/<\/a:t>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
}

function isSearchableDocxXml(name: string): boolean {
  return (
    name === 'word/document.xml' ||
    /^word\/(?:footnotes|endnotes|comments)\.xml$/i.test(name) ||
    /^word\/(?:header|footer)\d+\.xml$/i.test(name)
  )
}

function docxXmlOrder(left: string, right: string): number {
  if (left === 'word/document.xml') return -1
  if (right === 'word/document.xml') return 1
  return left.localeCompare(right)
}

function wordXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n')
      .replace(/<\/w:tc>/gi, '\t')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function cleanExtractedText(value: string, maxChars: number): string {
  return value
    .split(String.fromCharCode(0))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars)
}

function countCharacter(value: string, character: string): number {
  let count = 0
  for (const current of value) {
    if (current === character) count += 1
  }
  return count
}

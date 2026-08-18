import { unzipSync, strFromU8, type UnzipFileInfo } from 'fflate'

export const LOCAL_SEARCH_EXTENSIONS = new Set([
  'md', 'txt', 'pdf', 'docx', 'html', 'htm', 'pptx',
])

export const LOCAL_SEARCH_FILE_LIMITS: Record<string, number> = {
  md: 8 * 1024 * 1024,
  txt: 8 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  html: 8 * 1024 * 1024,
  htm: 8 * 1024 * 1024,
  pptx: 50 * 1024 * 1024,
}

const MAX_DOCX_XML_BYTES = 12 * 1024 * 1024
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
  const files = unzipSync(data, {
    filter(file: UnzipFileInfo) {
      return isSearchableDocxXml(file.name) && file.originalSize <= MAX_DOCX_XML_BYTES
    },
  })
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

export function extractPptxText(data: Uint8Array, maxChars: number): string {
  const files = unzipSync(data, {
    filter(file: UnzipFileInfo) {
      return isSearchablePptxXml(file.name) && file.originalSize <= MAX_DOCX_XML_BYTES
    },
  })
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

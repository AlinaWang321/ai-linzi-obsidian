import { unzipSync, strFromU8, type UnzipFileInfo } from 'fflate'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs'

export const LOCAL_SEARCH_EXTENSIONS = new Set(['md', 'txt', 'pdf', 'docx'])

export const LOCAL_SEARCH_FILE_LIMITS: Record<string, number> = {
  md: 8 * 1024 * 1024,
  txt: 8 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
}

const MAX_DOCX_XML_BYTES = 12 * 1024 * 1024

// PDF.js normally loads a separate worker file. Obsidian community plugins are
// distributed as one main.js, so expose the bundled worker handler as a local
// fake worker. No CDN, remote script or server is involved.
const pdfjsGlobal = globalThis as typeof globalThis & {
  pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler }
}
pdfjsGlobal.pdfjsWorker ??= { WorkerMessageHandler }

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

export async function extractPdfText(data: Uint8Array, maxChars: number): Promise<string> {
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
    .replace(/&amp;/g, '&')
}

function cleanExtractedText(value: string, maxChars: number): string {
  return value
    .replace(/\u0000/g, '')
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

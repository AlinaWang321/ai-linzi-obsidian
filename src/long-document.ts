import { App, TFile } from 'obsidian'
import {
  decodePlainText,
  extractDocxText,
  extractPdfText,
  isLocalSearchExtension,
  LOCAL_SEARCH_FILE_LIMITS,
} from './local-document-text'

export const LONG_DOCUMENT_DEFAULT_MAX_CHARS = 400_000
export const LONG_DOCUMENT_DEFAULT_CHUNK_CHARS = 12_000
export const LONG_DOCUMENT_DEFAULT_MAX_CHUNKS = 36

export interface LongDocumentText {
  text: string
  totalChars: number
}

export interface LongDocumentChunk {
  index: number
  text: string
}

/**
 * 在用户自己的 Obsidian 进程内读取文件。这里不联网、不写缓存；调用者随后只按任务需要
 * 逐段发送给插件专用 API。多读 1 个字符用于可靠判断是否超过服务端上限。
 */
export async function readLocalDocumentText(
  app: App,
  file: TFile,
  maxChars: number,
  mode: 'chat' | 'long-document' = 'long-document',
): Promise<LongDocumentText> {
  const extension = file.extension.toLocaleLowerCase()
  if (!isLocalSearchExtension(extension)) {
    throw new Error('长文任务目前支持 MD、TXT、可复制文字的 PDF 和 DOCX')
  }
  const maxFileBytes = LOCAL_SEARCH_FILE_LIMITS[extension] ?? 0
  if (maxFileBytes > 0 && file.stat.size > maxFileBytes) {
    throw new Error(
      `《${file.name}》文件过大（${formatBytes(file.stat.size)}），当前 ${extension.toUpperCase()} ` +
      `单文件上限为 ${formatBytes(maxFileBytes)}`,
    )
  }
  const readLimit = Math.max(1, maxChars) + 1
  let text = ''
  if (extension === 'md') {
    text = (await app.vault.cachedRead(file)).trim().slice(0, readLimit)
  } else {
    const data = new Uint8Array(await app.vault.readBinary(file))
    if (extension === 'txt') text = decodePlainText(data, readLimit)
    else if (extension === 'pdf') text = await extractPdfText(data, readLimit)
    else if (extension === 'docx') text = extractDocxText(data, readLimit)
  }
  if (!text.trim()) {
    const hint = extension === 'pdf' ? '；扫描版 PDF 需要先做 OCR' : ''
    throw new Error(`《${file.name}》没有提取到可处理的文字${hint}`)
  }
  if (text.length > maxChars) {
    if (mode === 'chat') {
      throw new Error(
        `《${file.name}》超过普通对话单篇 ${maxChars.toLocaleString('zh-CN')} 字上限。` +
        '如需完整处理，请只勾选这一份文件并选择“作为长文任务处理”（Pro及以上）',
      )
    }
    throw new Error(
      `《${file.name}》超过本次长文任务 ${maxChars.toLocaleString('zh-CN')} 字上限，` +
      '请按章节拆成两份后再处理',
    )
  }
  return { text, totalChars: text.length }
}

/**
 * 优先按段落和换行切分，只有超长单段才硬切。每个字符只进入一个分段，避免重叠导致
 * 金句、数字和行动项在最终合并时重复。
 */
export function splitLongDocument(
  text: string,
  chunkChars = LONG_DOCUMENT_DEFAULT_CHUNK_CHARS,
  maxChunks = LONG_DOCUMENT_DEFAULT_MAX_CHUNKS,
): LongDocumentChunk[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  const target = Math.max(2_000, chunkChars)
  const pieces = clean.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }
  for (const piece of pieces) {
    const paragraph = piece.trim()
    if (!paragraph) continue
    if (paragraph.length > target) {
      flush()
      for (let offset = 0; offset < paragraph.length; offset += target) {
        chunks.push(paragraph.slice(offset, offset + target))
      }
      continue
    }
    const joined = current ? `${current}\n\n${paragraph}` : paragraph
    if (joined.length > target) flush()
    current = current ? `${current}\n\n${paragraph}` : paragraph
  }
  flush()
  if (chunks.length > maxChunks) {
    throw new Error(
      `这份文件需要拆成 ${chunks.length} 段，超过单次最多 ${maxChunks} 段。` +
      '请按章节拆成两份后再处理',
    )
  }
  return chunks.map((chunk, index) => ({ index, text: chunk }))
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`
  return `${value} B`
}

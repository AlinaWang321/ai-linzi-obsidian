import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const longDocument = await readFile(new URL('../src/long-document.ts', import.meta.url), 'utf8')
const selector = await readFile(new URL('../src/content-selector.ts', import.meta.url), 'utf8')

assert.match(longDocument, /LONG_DOCUMENT_DEFAULT_MAX_CHARS = 400_000/)
assert.match(longDocument, /splitLongDocument/)
assert.match(longDocument, /作为长文任务处理/)
assert.match(longDocument, /extractPdfText/)
assert.match(longDocument, /extractDocxText/)
assert.match(selector, /一次只处理一份文件/)
assert.match(main, /\/api\/plugin\/v1\/long-document/)
assert.match(main, /private longDocumentTask: LongDocumentTaskState \| null = null/)
assert.match(main, /继续处理/)
assert.match(main, /不会重跑前面的段落|nextIndex/)
assert.match(main, /this\.longDocumentTask = null[\s\S]*?await this\.persistNow\(\)/)

const savedConvo = main.match(/interface SavedConvo \{[\s\S]*?\n\}/)?.[0] ?? ''
assert.doesNotMatch(savedConvo, /longDocument/, '长文原文和断点不能写进会话历史')

console.log('long document tests: ok')

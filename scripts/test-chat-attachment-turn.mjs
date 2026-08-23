import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/chat-attachment-turn.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const attachment = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const empty = { imageCount: 0, vaultFileCount: 0, computerSpreadsheetCount: 0, longDocumentCount: 0 }
assert.equal(attachment.attachmentTurnCount(empty), 0)
assert.equal(attachment.buildAttachmentOnlyTurnText(empty), '')

const images = { ...empty, imageCount: 2 }
assert.equal(attachment.attachmentTurnCount(images), 2)
assert.match(attachment.buildAttachmentOnlyTurnText(images), /2 张图片/)
assert.match(attachment.buildAttachmentOnlyTurnText(images), /结合当前对话/)

const mixed = { imageCount: 1, vaultFileCount: 2, computerSpreadsheetCount: 1, longDocumentCount: 0 }
const text = attachment.buildAttachmentOnlyTurnText(mixed)
assert.match(text, /1 张图片/)
assert.match(text, /3 份资料/)
assert.doesNotMatch(text, /\.md|\.xlsx|\//, '自动补文不得泄露附件名或路径')

console.log('attachment-only turn tests: ok')

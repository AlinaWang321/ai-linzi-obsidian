import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bundled = await build({
  entryPoints: ['src/local-document-text.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const tempDir = await mkdtemp(join(tmpdir(), 'ai-linzi-document-test-'))
const bundlePath = join(tempDir, 'parser.mjs')
await writeFile(bundlePath, source)
// PDF.js only needs these browser globals for rendering. Text extraction does
// not use them, but its module initializes the constructors in Node tests.
globalThis.DOMMatrix ??= class DOMMatrix {}
globalThis.ImageData ??= class ImageData {}
globalThis.Path2D ??= class Path2D {}
const parser = await import(pathToFileURL(bundlePath).href)

try {
  assert.equal(parser.isLocalSearchExtension('md'), true)
  assert.equal(parser.isLocalSearchExtension('TXT'), true)
  assert.equal(parser.isLocalSearchExtension('pdf'), true)
  assert.equal(parser.isLocalSearchExtension('docx'), true)
  assert.equal(parser.isLocalSearchExtension('doc'), false)

  const plain = parser.decodePlainText(new TextEncoder().encode('本地 TXT 搜索\n第二行'), 120_000)
  assert.match(plain, /本地 TXT 搜索/)

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>本地 Word 搜索</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>客户需求</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '</w:body></w:document>'
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(documentXml),
  })
  const docxText = parser.extractDocxText(docx, 120_000)
  assert.match(docxText, /本地 Word 搜索/)
  assert.match(docxText, /表格内容/)
  assert.match(docxText, /客户需求/)

  const pdfText = await parser.extractPdfText(buildMinimalPdf('Vault PDF Search'), 120_000)
  assert.match(pdfText, /Vault PDF Search/)

  if (process.argv[2]) {
    const realPdfText = await parser.extractPdfText(new Uint8Array(await readFile(process.argv[2])), 120_000)
    assert.ok(realPdfText.length > 0, '指定的真实 PDF 未提取出文字')
    console.log(
      `real PDF extraction: ${realPdfText.length} chars, ` +
        `${(realPdfText.match(/[\p{Script=Han}]/gu) ?? []).length} Han chars`,
    )
  }

  console.log('local TXT, PDF and DOCX extraction tests passed')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

function buildMinimalPdf(text) {
  const escaped = text.replace(/([()\\])/g, '\\$1')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = body.length
  body += `xref\n0 ${objects.length + 1}\n`
  body += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`
  return new TextEncoder().encode(body)
}

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
globalThis.activeWindow ??= globalThis
const parser = await import(pathToFileURL(bundlePath).href)

try {
  assert.equal(parser.isLocalSearchExtension('md'), true)
  assert.equal(parser.isLocalSearchExtension('TXT'), true)
  assert.equal(parser.isLocalSearchExtension('pdf'), true)
  assert.equal(parser.isLocalSearchExtension('docx'), true)
  // v0.7.42：HTML/PPTX 进入可搜索/可读取白名单；旧版 doc/ppt 仍不支持
  assert.equal(parser.isLocalSearchExtension('html'), true)
  assert.equal(parser.isLocalSearchExtension('HTM'), true)
  assert.equal(parser.isLocalSearchExtension('pptx'), true)
  assert.equal(parser.isLocalSearchExtension('doc'), false)
  assert.equal(parser.isLocalSearchExtension('ppt'), false)
  assert.ok(parser.LOCAL_SEARCH_FILE_LIMITS.html > 0, 'html 缺少体积上限会被静默跳过')
  assert.ok(parser.LOCAL_SEARCH_FILE_LIMITS.htm > 0, 'htm 缺少体积上限会被静默跳过')
  assert.ok(parser.LOCAL_SEARCH_FILE_LIMITS.pptx > 0, 'pptx 缺少体积上限会被静默跳过')

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

  const slideXml = (text) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p>` +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  const pptx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'ppt/slides/slide1.xml': strToU8(slideXml('打卡营第一课 搭骨架')),
    'ppt/slides/slide2.xml': strToU8(slideXml('第二页 内容获客')),
    'ppt/notesSlides/notesSlide1.xml': strToU8(slideXml('备注：先讲数据流')),
    'ppt/media/image1.png': strToU8('not-xml'),
  })
  const pptxText = parser.extractPptxText(pptx, 120_000)
  assert.match(pptxText, /【第 1 页】/)
  assert.match(pptxText, /打卡营第一课 搭骨架/)
  assert.match(pptxText, /【第 2 页】[\s\S]*第二页 内容获客/)
  assert.match(pptxText, /【第 1 页备注】[\s\S]*备注：先讲数据流/)
  assert.ok(pptxText.indexOf('打卡营第一课') < pptxText.indexOf('第二页'), '幻灯片必须按页码排序')
  assert.doesNotMatch(pptxText, /not-xml/)

  const html =
    '<!doctype html><html><head><title>课堂讲义</title><style>body{color:red}</style>' +
    '<script>console.log("skip me")</script></head>' +
    '<body><h1>内容获客三步法</h1><p>先搭骨架&nbsp;再填血肉</p>' +
    '<ul><li>第一步 选题</li><li>第二步 结构</li></ul>' +
    '<table><tr><td>平台</td><td>公众号</td></tr></table></body></html>'
  const htmlText = parser.extractHtmlText(new TextEncoder().encode(html), 120_000)
  assert.match(htmlText, /课堂讲义/)
  assert.match(htmlText, /内容获客三步法/)
  assert.match(htmlText, /先搭骨架 再填血肉/)
  assert.match(htmlText, /第一步 选题/)
  assert.match(htmlText, /平台\t公众号/)
  assert.doesNotMatch(htmlText, /skip me/)
  assert.doesNotMatch(htmlText, /color:red/)

  if (process.argv[2]) {
    const realPdfText = await parser.extractPdfText(new Uint8Array(await readFile(process.argv[2])), 120_000)
    assert.ok(realPdfText.length > 0, '指定的真实 PDF 未提取出文字')
    console.log(
      `real PDF extraction: ${realPdfText.length} chars, ` +
        `${(realPdfText.match(/[\p{Script=Han}]/gu) ?? []).length} Han chars`,
    )
  }

  console.log('local TXT, PDF, DOCX, HTML and PPTX extraction tests passed')
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

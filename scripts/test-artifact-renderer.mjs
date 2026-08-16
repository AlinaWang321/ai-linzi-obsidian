import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { strFromU8, unzipSync } from 'fflate'

const require = createRequire(import.meta.url)
const bundled = await build({
  stdin: {
    contents: `export { renderArtifact } from './src/artifact-renderer.ts'; export { parseArtifactMarkdown, resolveArtifactPath, estimateArtifactUnits } from './src/artifact-renderer-core.ts'`,
    resolveDir: process.cwd(),
    sourcefile: 'artifact-test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const loaded = { exports: {} }
new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(loaded, loaded.exports, require)
const { renderArtifact, parseArtifactMarkdown, resolveArtifactPath, estimateArtifactUnits } = loaded.exports

const content = `---
状态: 测试
---
# 客户增长方案

## 一、核心目标

本月完成三个可验证动作，并记录真实结果。

- 明确目标客户
- 完成首次交付
- 复盘关键数据

> 先完成，再优化。

| 阶段 | 动作 |
| --- | --- |
| 第一周 | 客户访谈 |
| 第二周 | MVP 交付 |

<script>alert('不能执行')</script>`

const parsed = parseArtifactMarkdown(content, '备用标题')
assert.equal(parsed.title, '客户增长方案')
assert.ok(parsed.blocks.some((block) => block.type === 'table'))
assert.equal(resolveArtifactPath('$OUTPUT/文档/方案.docx', 'AI霖子输出'), 'AI霖子输出/文档/方案.docx')
assert.ok(estimateArtifactUnits({ type: 'create_artifact', path: '$OUTPUT/方案.pptx', format: 'pptx', title: '方案', content }).count >= 2)

const operation = (format) => ({
  type: 'create_artifact',
  path: `$OUTPUT/测试.${format}`,
  format,
  title: '客户增长方案',
  content,
  theme: 'brand',
})

const html = await renderArtifact(operation('html'))
assert.equal(html.binary, false)
assert.match(html.data, /<!doctype html>/i)
assert.match(html.data, /客户增长方案/)
assert.doesNotMatch(html.data, /<script>alert/)
assert.match(html.data, /&lt;script&gt;alert/)

const docx = await renderArtifact(operation('docx'))
assert.equal(docx.binary, true)
assert.equal(Buffer.from(docx.data).subarray(0, 2).toString(), 'PK')
const docxFiles = unzipSync(new Uint8Array(docx.data))
assert.match(strFromU8(docxFiles['word/document.xml']), /客户增长方案/)

const pptx = await renderArtifact(operation('pptx'))
assert.equal(pptx.binary, true)
assert.equal(Buffer.from(pptx.data).subarray(0, 2).toString(), 'PK')
const pptxFiles = unzipSync(new Uint8Array(pptx.data))
const slideText = Object.entries(pptxFiles)
  .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  .map(([, bytes]) => strFromU8(bytes))
  .join('\n')
assert.match(slideText, /客户增长方案/)

// PDF 正文由浏览器 Canvas 使用本机中文字体排版。测试用最小合法 PNG 替代
// 真实画布像素，验证分页结果确实被组装为可打开的 PDF 文件。
const transparentPng = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))
const fakeContext = {
  fillStyle: '', strokeStyle: '', font: '',
  fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  measureText(text) { return { width: Array.from(text).length * 26 } },
}
globalThis.window = {
  document: {
    createElement(name) {
      assert.equal(name, 'canvas')
      return {
        width: 0,
        height: 0,
        getContext(kind) { assert.equal(kind, '2d'); return fakeContext },
        toBlob(callback) { callback(new Blob([transparentPng], { type: 'image/png' })) },
      }
    },
  },
}
const pdf = await renderArtifact(operation('pdf'))
assert.equal(pdf.binary, true)
assert.equal(Buffer.from(pdf.data).subarray(0, 5).toString(), '%PDF-')
delete globalThis.window

if (process.env.ARTIFACT_FIXTURE_DIR) {
  await mkdir(process.env.ARTIFACT_FIXTURE_DIR, { recursive: true })
  await Promise.all([
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.html`, html.data),
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.docx`, Buffer.from(docx.data)),
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.pptx`, Buffer.from(pptx.data)),
  ])
}

console.log('artifact renderer tests passed')

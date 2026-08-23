import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { strFromU8, unzipSync } from 'fflate'

const require = createRequire(import.meta.url)
const bundled = await build({
  stdin: {
    contents: `export { renderArtifact, renderPresentationPreviewHtml } from './src/artifact-renderer.ts'; export { parseArtifactMarkdown, resolveArtifactPath, estimateArtifactUnits, normalizeArtifactStyle, normalizeArtifactTemplate, normalizeArtifactHtmlDesign, normalizePresentationSpec, explicitPresentationSlideCount, presentationSlideCountProblem, presentationContentProblem, artifactStyleSummary } from './src/artifact-renderer-core.ts'`,
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
const {
  renderArtifact,
  renderPresentationPreviewHtml,
  parseArtifactMarkdown,
  resolveArtifactPath,
  estimateArtifactUnits,
  normalizeArtifactStyle,
  normalizeArtifactTemplate,
  normalizeArtifactHtmlDesign,
  normalizePresentationSpec,
  explicitPresentationSlideCount,
  presentationSlideCountProblem,
  presentationContentProblem,
  artifactStyleSummary,
} = loaded.exports

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
| 本机入口 | 打开 01_Raw |
| 公式文本 | =2+2 |

<script>alert('不能执行')</script>

<div class="nav"><a href="../../../01_Raw/"><span>打开 01_Raw</span></a><a href="../../../02_Wiki/"><span>打开 02_Wiki</span></a></div>`

const parsed = parseArtifactMarkdown(content, '备用标题')
assert.equal(parsed.title, '客户增长方案')
assert.ok(parsed.blocks.some((block) => block.type === 'table'))
assert.equal(resolveArtifactPath('$OUTPUT/文档/方案.docx', 'AI霖子输出'), 'AI霖子输出/文档/方案.docx')
assert.ok(estimateArtifactUnits({ type: 'create_artifact', path: '$OUTPUT/方案.pptx', format: 'pptx', title: '方案', content }).count >= 2)
assert.equal(estimateArtifactUnits({ type: 'create_artifact', path: '$OUTPUT/方案.xlsx', format: 'xlsx', title: '方案', content }).label, '工作表')
assert.equal(normalizeArtifactTemplate('not-a-template'), 'general')
assert.deepEqual(
  normalizeArtifactHtmlDesign({
    designBrief: '深蓝高级经营驾驶舱',
    customCss: 'body{background:#071426}.hero{background:#0b2244;color:#fff}@media(max-width:620px){.cards{grid-template-columns:1fr}}',
  }),
  {
    designBrief: '深蓝高级经营驾驶舱',
    customCss: 'body{background:#071426}.hero{background:#0b2244;color:#fff}@media(max-width:620px){.cards{grid-template-columns:1fr}}',
  },
)
assert.equal(normalizeArtifactHtmlDesign({ customCss: '.hero{background:url(https://example.com/a.png)}' }), undefined)
assert.equal(normalizeArtifactHtmlDesign({ customCss: '@import "https://example.com/x.css";' }), undefined)
assert.equal(normalizeArtifactHtmlDesign({ customCss: `body{color:#fff}${' '.repeat(20_001)}` }), undefined)
assert.deepEqual(
  normalizeArtifactStyle({ bodySizePt: 99, marginMm: 2, accentColor: 'javascript:red', headerText: 'A\u0000B' }, 'course-handout'),
  {
    pageSize: 'a4', orientation: 'portrait', bodyFont: 'songti', headingFont: 'yahei',
    bodySizePt: 20, titleSizePt: 28, lineSpacing: 1.6, marginMm: 10,
    firstLineIndentChars: 2, includeCover: true, includeToc: true, pageNumbers: true,
    headerText: 'A B', footerText: 'AI霖子', accentColor: 'F39800',
  },
)

const operation = (format) => ({
  type: 'create_artifact',
  path: `$OUTPUT/测试.${format}`,
  format,
  title: '客户增长方案',
  content,
  theme: 'brand',
  template: format === 'xlsx' ? 'data-workbook' : format === 'pptx' ? 'presentation' : 'course-handout',
  style: { bodyFont: 'songti', headingFont: 'yahei', bodySizePt: 12, titleSizePt: 32, headerText: '客户增长方案', accentColor: '#7F56D9' },
  ...(format === 'pptx' ? { presentation } : {}),
})

const presentation = {
  template: 'course-explainer',
  subtitle: '从定位到行动的完整讲解',
  requestedSlideCount: 8,
  slides: [
    { layout: 'cover', kicker: '课程讲解', headline: '客户增长不是流量游戏，而是价值验证。', body: '一套从目标客户到首次交付的行动路径。' },
    { layout: 'statement', kicker: '先换一个判断', headline: '没有真实交付，就没有可复用的增长。', body: '先完成一次最小闭环，再谈放大。' },
    { layout: 'cards', kicker: '三个关键动作', headline: '增长从三个可验证动作开始。', items: ['聚焦一个有明确痛点且愿意付费的目标客户', '用一次真实访谈核实场景、需求与决策条件', '交付一个能得到真实反馈的最小成果'] },
    { layout: 'process', kicker: '行动路径', headline: '把模糊目标拆成四步闭环。', items: ['选定一类客户，写清他此刻最急的问题', '用真实对话验证问题是否愿意付费解决', '完成一次最小交付，不先堆大而全产品', '记录咨询、转化和反馈，决定下轮改什么'] },
    { layout: 'comparison', kicker: '避免走偏', headline: '从“想得很好”切换到“证据说话”。', leftTitle: '旧做法', leftItems: ['先花几周做完大而全的产品，再去找客户', '只看点赞与阅读，没有记录咨询和付费'], rightTitle: '新做法', rightItems: ['先用一次最小交付验证价值，再逐步增加内容', '同时记录真实反馈、转化与复购信号'] },
    { layout: 'metrics', kicker: '本周仪表盘', headline: '只盯四个能推动决策的数据。', metrics: [{ value: '10', label: '目标访谈' }, { value: '3', label: '有效需求' }, { value: '1', label: '最小交付' }, { value: '7天', label: '复盘周期' }] },
    { layout: 'quote', kicker: '一句话带走', headline: '先完成，再优化。', quote: '先完成，再优化。', source: '客户增长行动原则' },
    { layout: 'closing', kicker: '现在行动', headline: '今天就约出第一位真实客户。', body: '别再等准备好，真实对话会告诉你下一步。' },
  ],
}
const normalizedPresentation = normalizePresentationSpec({ ...presentation, requestedSlideCount: undefined, slides: [...presentation.slides, { layout: 'content', headline: '<script>alert(1)</script>', body: 'x'.repeat(900), css: 'position:fixed' }] })
assert.equal(normalizedPresentation.slides.length, 9)
assert.equal(normalizedPresentation.slides[8].body.length, 420)
assert.equal(normalizedPresentation.slides[8].css, undefined)
assert.equal(estimateArtifactUnits(operation('pptx')).count, 8)
assert.equal(explicitPresentationSlideCount('请把下面内容做成3页PPT'), 3)
assert.equal(explicitPresentationSlideCount('PPT 请控制在十二页'), 12)
assert.equal(explicitPresentationSlideCount('把第3页标题改短一点'), undefined)
assert.equal(
  presentationSlideCountProblem('请做成3页PPT', operation('pptx')),
  '用户明确要求 3 页 PPT，但当前页面设计稿是 8 页。请重新提交恰好 3 个完整 slides；不要让用户再次说明。',
)
assert.equal(presentationSlideCountProblem('请做成8页PPT', operation('pptx')), undefined)
assert.equal(presentationContentProblem(operation('pptx')), undefined)
const sparsePresentation = {
  ...operation('pptx'),
  presentation: {
    template: 'course-explainer',
    requestedSlideCount: 3,
    slides: [
      { layout: 'cover', headline: '内容增长' },
      { layout: 'process', headline: '三步做增长', items: ['定位', '发布', '复盘'] },
      { layout: 'closing', headline: '现在开始' },
    ],
  },
}
assert.match(presentationContentProblem(sparsePresentation), /第 2 页.*步骤过于空洞/)
const processBodyPresentation = {
  ...operation('pptx'),
  presentation: {
    template: 'course-explainer',
    requestedSlideCount: 3,
    slides: [
      { layout: 'cover', headline: '内容增长' },
      {
        layout: 'process',
        headline: '定位—内容—转化跑通最小闭环',
        body: '定位：锁定具体人群、高频场景与可验证的交付结果\\n内容：围绕客户痛点、解决方法和真实结果持续表达\\n转化：用诊断清单、资料领取或咨询预约承接明确下一步',
      },
      { layout: 'closing', headline: '现在开始', body: '今天完成第一轮。' },
    ],
  },
}
assert.equal(presentationContentProblem(processBodyPresentation), undefined)
const normalizedProcessBody = normalizePresentationSpec(processBodyPresentation.presentation)
assert.deepEqual(normalizedProcessBody.slides[1].items, [
  '定位：锁定具体人群、高频场景与可验证的交付结果',
  '内容：围绕客户痛点、解决方法和真实结果持续表达',
  '转化：用诊断清单、资料领取或咨询预约承接明确下一步',
])
assert.equal(normalizedProcessBody.slides[1].body, '')
const processArrayBodyPresentation = {
  ...operation('pptx'),
  presentation: {
    template: 'course-explainer',
    requestedSlideCount: 3,
    slides: [
      { layout: 'cover', headline: '内容增长' },
      {
        layout: 'process',
        headline: '定位—内容—转化跑通最小闭环',
        body: [
          '定位｜锁定具体人群、高频场景与可验证的交付结果',
          '内容｜围绕客户痛点、解决方法和真实结果持续表达',
          '转化｜用诊断清单、资料领取或咨询预约承接明确下一步',
        ],
      },
      { layout: 'closing', headline: '现在开始' },
    ],
  },
}
assert.equal(presentationContentProblem(processArrayBodyPresentation), undefined)
assert.deepEqual(normalizePresentationSpec(processArrayBodyPresentation.presentation).slides[1].items, [
  '定位｜锁定具体人群、高频场景与可验证的交付结果',
  '内容｜围绕客户痛点、解决方法和真实结果持续表达',
  '转化｜用诊断清单、资料领取或咨询预约承接明确下一步',
])
const processInlineBodyPresentation = {
  ...processArrayBodyPresentation,
  presentation: {
    ...processArrayBodyPresentation.presentation,
    slides: [
      { layout: 'cover', headline: '内容增长' },
      {
        layout: 'process',
        headline: '定位—内容—转化跑通最小闭环',
        body: '定位：锁定具体人群、高频场景与可验证结果，今天写完一句话价值主张。内容：围绕真实问题持续表达立场、方法与案例，今天完成一篇内容。转化：设置明确入口并跟进有效线索，今天补好行动按钮并联系三位客户。',
      },
      { layout: 'closing', headline: '现在开始' },
    ],
  },
}
assert.equal(presentationContentProblem(processInlineBodyPresentation), undefined)
assert.equal(normalizePresentationSpec({ ...presentation, requestedSlideCount: 3 }), undefined)
assert.match(artifactStyleSummary(operation('docx')), /课程讲义 · A4 纵向 · 12pt/)

const html = await renderArtifact(operation('html'), { vaultName: '数字大脑' })
assert.equal(html.binary, false)
assert.match(html.data, /<!doctype html>/i)
assert.match(html.data, /客户增长方案/)
assert.doesNotMatch(html.data, /<script>alert/)
assert.match(html.data, /&lt;script&gt;alert/)
assert.match(html.data, /<a class="vault-link" href="obsidian:\/\/search\?vault=/)
assert.match(html.data, /&amp;query=.*">打开 01_Raw<\/a>/)
assert.match(html.data, /<nav class="vault-nav-links">/)
assert.doesNotMatch(html.data, /<p><nav class="vault-nav-links">/)
assert.match(html.data, />打开 02_Wiki<\/a>/)
assert.doesNotMatch(html.data, /href="\.\.\/\.\.\/\.\.\//)
const customHtmlOperation = {
  ...operation('html'),
  layout: 'dashboard',
  htmlDesign: {
    designBrief: '深蓝数据驾驶舱',
    customCss: 'body{background:#071426}.hero{background:#0b2244;color:#fff}.hero h1{color:#7dd3fc}',
  },
}
const customHtml = await renderArtifact(customHtmlOperation)
assert.match(customHtml.data, /body\{background:#071426\}/)
assert.match(artifactStyleSummary(customHtmlOperation), /AI 自主 HTML 设计 · 深蓝数据驾驶舱/)

const docx = await renderArtifact(operation('docx'))
assert.equal(docx.binary, true)
assert.equal(Buffer.from(docx.data).subarray(0, 2).toString(), 'PK')
const docxFiles = unzipSync(new Uint8Array(docx.data))
const docxDocument = strFromU8(docxFiles['word/document.xml'])
assert.match(docxDocument, /客户增长方案/)
assert.match(docxDocument, /w:pgSz[^>]+w:w="11906"[^>]+w:h="16838"/)
assert.match(docxDocument, /w:pgMar[^>]+w:top="1247"/)
assert.match(docxDocument, /TOC \\h \\o &quot;1-3&quot;/)
assert.match(strFromU8(docxFiles['word/header1.xml']), /客户增长方案/)
assert.match(strFromU8(docxFiles['word/styles.xml']), /Songti SC/)
assert.match(strFromU8(docxFiles['word/settings.xml']), /<w:updateFields\/>/)

const pptx = await renderArtifact(operation('pptx'))
assert.equal(pptx.binary, true)
assert.equal(Buffer.from(pptx.data).subarray(0, 2).toString(), 'PK')
const pptxFiles = unzipSync(new Uint8Array(pptx.data))
const slideText = Object.entries(pptxFiles)
  .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  .map(([, bytes]) => strFromU8(bytes))
  .join('\n')
assert.match(strFromU8(pptxFiles['docProps/core.xml']), /客户增长方案/)
assert.match(slideText, /7F56D9/)
assert.doesNotMatch(slideText, /Microsoft YaHei|Hiragino Sans GB|Songti SC/)
assert.match(slideText, /a:latin typeface="Arial"/)
assert.match(slideText, /a:ea typeface=""/)
assert.match(slideText, /客户增长不是流量游戏/)
assert.match(slideText, /最小交付/)
assert.equal(Object.keys(pptxFiles).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 8)
assert.match(slideText, /prst="roundRect"/)
assert.match(slideText, /prst="ellipse"/)
await assert.rejects(
  renderArtifact({ ...operation('pptx'), presentation: { ...presentation, requestedSlideCount: 3 } }),
  /页数与用户要求不一致/,
)
await assert.rejects(renderArtifact(sparsePresentation), /步骤过于空洞/)

const presentationPreview = renderPresentationPreviewHtml(operation('pptx'))
assert.match(presentationPreview, /课程讲解/)
assert.match(presentationPreview, /class="slide comparison"/)
assert.match(presentationPreview, /class="metrics"/)
assert.doesNotMatch(presentationPreview, /<script/i)

const xlsx = await renderArtifact(operation('xlsx'))
assert.equal(xlsx.binary, true)
assert.equal(xlsx.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
assert.equal(Buffer.from(xlsx.data).subarray(0, 2).toString(), 'PK')
const xlsxFiles = unzipSync(new Uint8Array(xlsx.data))
const workbook = strFromU8(xlsxFiles['xl/workbook.xml'])
const worksheet = strFromU8(xlsxFiles['xl/worksheets/sheet2.xml'])
assert.match(workbook, /内容摘要/)
assert.match(workbook, /一、核心目标/)
assert.match(worksheet, /state="frozen"/)
assert.match(worksheet, /<autoFilter /)
assert.match(worksheet, /pageSetup[^>]+orientation="landscape"/)
assert.match(worksheet, /=2\+2/)
assert.doesNotMatch(worksheet, /<f(?:\s|>)/)
assert.match(strFromU8(xlsxFiles['xl/styles.xml']), /FF7F56D9/)

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
globalThis.window = { document: {} }
globalThis.createEl = (name) => {
  assert.equal(name, 'canvas')
  return {
    width: 0,
    height: 0,
    getContext(kind) { assert.equal(kind, '2d'); return fakeContext },
    toBlob(callback) { callback(new Blob([transparentPng], { type: 'image/png' })) },
  }
}
const pdf = await renderArtifact(operation('pdf'))
assert.equal(pdf.binary, true)
assert.equal(Buffer.from(pdf.data).subarray(0, 5).toString(), '%PDF-')
delete globalThis.window
delete globalThis.createEl

if (process.env.ARTIFACT_FIXTURE_DIR) {
  await mkdir(process.env.ARTIFACT_FIXTURE_DIR, { recursive: true })
  await Promise.all([
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.html`, html.data),
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.docx`, Buffer.from(docx.data)),
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.pptx`, Buffer.from(pptx.data)),
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案-PPT预览.html`, presentationPreview),
    writeFile(`${process.env.ARTIFACT_FIXTURE_DIR}/客户增长方案.xlsx`, Buffer.from(xlsx.data)),
  ])
}

console.log('artifact renderer tests passed')

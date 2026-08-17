import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { strFromU8, unzipSync } from 'fflate'

const require = createRequire(import.meta.url)
const bundled = await build({
  stdin: {
    contents: `export { renderPresentation } from './src/presentation-renderer.ts'; export * from './src/presentation-renderer-core.ts'`,
    resolveDir: process.cwd(),
    sourcefile: 'presentation-test-entry.ts',
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
  renderPresentation,
  normalizePresentationSlide,
  normalizePresentationTheme,
  resolvePresentationPaths,
} = loaded.exports

const slides = [
  { type: 'cover', kicker: 'DAY 1', title: '把知识变成可以现场交付的成果', subtitle: '课程 · 方案 · 报告都使用同一套演示能力' },
  { type: 'statement', title: '真正的好课件，不是把 Word 挤进幻灯片', body: '一页只讲一个中心意思，视觉服务于判断。' },
  { type: 'bullets', title: '今天完成三件事', bullets: ['读懂原始材料', '形成演示叙事', '导出可编辑 PowerPoint'], body: '所有格式都在用户电脑本机生成。' },
  { type: 'cards', title: '三种交付场景', cards: [{ label: '01', title: '课程', body: '帮助学员理解与行动' }, { label: '02', title: '方案', body: '帮助决策者做选择' }, { label: '03', title: '报告', body: '帮助团队看清事实' }] },
  { type: 'comparison', title: '两种生成路线', columns: [{ title: '截图式 PPT', items: ['看起来一致', '文字不能编辑'] }, { title: '原生 PPT', items: ['文字和色块可编辑', '适合继续修改'] }] },
  { type: 'process', title: '从文档到演示', steps: [{ title: '读取', body: 'MD/TXT/DOCX/PDF' }, { title: '策划', body: 'Luna 决定叙事和版式' }, { title: '渲染', body: '插件本机生成' }] },
  { type: 'timeline', title: '交付节奏', steps: [{ title: '先看内容' }, { title: '再确认版式' }, { title: '最后写盘' }] },
  { type: 'metrics', title: '关键边界', metrics: [{ value: '0', label: '额外 Node 安装' }, { value: '3', label: '可选输出格式' }, { value: '100%', label: 'PPT 文字可编辑' }] },
  { type: 'table', title: '格式能力', table: { headers: ['格式', '用途', '可编辑'], rows: [['HTML', '现场演示', '网页源码'], ['PPTX', '继续修改', '是'], ['PDF', '固定交付', '否']] } },
  { type: 'quote', title: '一句话原则', quote: 'Skill 决定风格，Luna 决定内容，插件负责可靠落地。', attribution: 'AI霖子演示引擎' },
  { type: 'section', kicker: 'NEXT', title: '用户的专属风格，可以以后再加', subtitle: '底层协议不需要跟着重写' },
  { type: 'closing', title: '从一份文档，直接得到能讲、能改、能交付的演示', subtitle: 'HTML · PowerPoint · PDF' },
]

for (const slide of slides) assert.ok(normalizePresentationSlide(slide), `layout ${slide.type} should be valid`)
assert.equal(normalizePresentationSlide({ type: 'comparison', title: '错误', columns: [{ title: '只有一列', items: ['x'] }] }), null)
assert.equal(normalizePresentationTheme({ primary: '#123456', headingFont: '<bad>' }).primary, '123456')

const operation = {
  type: 'create_presentation',
  basePath: '$OUTPUT/演示文稿/演示引擎测试',
  formats: ['html', 'pptx'],
  title: '演示引擎测试',
  subtitle: '通用场景',
  theme: normalizePresentationTheme({
    name: '深海暖金',
    primary: '102544',
    accent: 'F39800',
    background: 'F7F2E8',
    surface: 'FFFFFF',
    text: '172033',
    muted: '667085',
    shape: 'rounded',
  }),
  slides,
}

assert.deepEqual(
  resolvePresentationPaths(operation, 'AI霖子输出'),
  ['AI霖子输出/演示文稿/演示引擎测试.html', 'AI霖子输出/演示文稿/演示引擎测试.pptx'],
)

const rendered = await renderPresentation(operation)
assert.equal(rendered.length, 2)
const html = rendered.find((file) => file.format === 'html')
assert.equal(html.binary, false)
assert.match(html.data, /class="slide slide-cover"/)
assert.match(html.data, /class="slide slide-comparison"/)
assert.match(html.data, /ArrowRight/)
assert.match(html.data, /@media print/)
assert.doesNotMatch(html.data, /<bad>/)

const pptx = rendered.find((file) => file.format === 'pptx')
assert.equal(Buffer.from(pptx.data).subarray(0, 2).toString(), 'PK')
const pptxFiles = unzipSync(new Uint8Array(pptx.data))
const slideNames = Object.keys(pptxFiles).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
assert.equal(slideNames.length, slides.length)
const slideXml = slideNames.map((name) => strFromU8(pptxFiles[name])).join('\n')
assert.match(slideXml, /把知识变成可以现场交付的成果/)
assert.match(slideXml, /原生 PPT/)
assert.doesNotMatch(slideXml, /<p:pic>/) // 不是整页截图，文字与色块保持原生可编辑。
if (process.env.PRESENTATION_SAMPLE_DIR) {
  await mkdir(process.env.PRESENTATION_SAMPLE_DIR, { recursive: true })
  await writeFile(`${process.env.PRESENTATION_SAMPLE_DIR}/演示引擎测试.html`, html.data)
  await writeFile(`${process.env.PRESENTATION_SAMPLE_DIR}/演示引擎测试.pptx`, Buffer.from(pptx.data))
}

const transparentPng = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))
const fakeContext = {
  fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1, lineWidth: 1,
  fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, roundRect() {},
  measureText(text) { return { width: Array.from(text).length * 22 } },
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
const pdfOperation = { ...operation, formats: ['pdf'], slides: slides.slice(0, 3) }
const [pdf] = await renderPresentation(pdfOperation)
assert.equal(Buffer.from(pdf.data).subarray(0, 4).toString(), '%PDF')

console.log('presentation renderer tests passed')

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-deck-builder-'))
const outfile = path.join(tempDir, 'core.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/deck-builder-core.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const core = await import(pathToFileURL(outfile).href)

assert.equal(core.DECK_SOURCE_MIN, 200)
assert.equal(core.DECK_SOURCE_MAX, 60_000)
assert.equal(core.DECK_BUILDER_OUTPUT_FOLDER, '课件PPT')
assert.deepEqual([...core.DECK_THEMES], ['深蓝', '青竹', '黛紫'])

// ── 大纲校验：拦硬伤，不拦长文本 ──
assert.equal(core.validateDeckOutline(null).ok, false)
assert.equal(core.validateDeckOutline({ meta: {}, slides: [] }).ok, false)
const goodOutline = {
  meta: { deck_title: '朋友圈获客', session: '第一课', presenter: '小D', brand: '向阳教练平台' },
  slides: [
    { type: 'cover', title_prefix: '做出会', title_accent: '成交', subtitle: '朋友圈获客', promise: '不打扰，也能成交' },
    { type: 'list', kicker: 'WHY · 为什么', title: '为什么不成交', items: [{ text: '只有广告和流水账' }, { text: '发圈靠结构不靠灵感' }] },
    { type: 'imagetext', kicker: 'CASE · 案例', title: '客户见证', image: '![](attachments/a.jpg)', points: [{ text: '截图+一句点评' }] },
    { type: 'image', kicker: 'DATA · 数据', title: '转化看得见', image: '![[漏斗.png]]', cap: '漏斗一目了然' },
    { type: 'quote', kicker: 'KEY · 记住', quote: '发圈不是求点赞' },
    { type: 'end', pre: '明晚见', title: 'Day 2', subtitle: '发圈复盘' },
  ],
}
const verdict = core.validateDeckOutline(goodOutline)
assert.equal(verdict.ok, true)
assert.deepEqual(core.deckImageTokens(goodOutline), ['![](attachments/a.jpg)', '![[漏斗.png]]'])
assert.equal(core.validateDeckOutline({
  meta: { deck_title: 'x' },
  slides: [{ type: 'alien' }, {}, { type: 'quote' }, { type: 'cover', title_prefix: 'x' }],
}).ok, false)

// ── 装配：主题、打印样式、图片内嵌、转义、截断 ──
const dataUrl = 'data:image/jpeg;base64,QUJD'
const html = core.assembleDeckHtml({
  outline: goodOutline,
  theme: '青竹',
  imageDataUrls: new Map([
    ['![](attachments/a.jpg)', dataUrl],
    ['![[漏斗.png]]', dataUrl],
  ]),
})
assert.match(html, /--bgd:#0A1F17/) // 青竹主题底色
assert.match(html, /@media print/)
assert.match(html, /@page\{size:1280px 720px;margin:0;\}/)
assert.match(html, /page-break-after:always/)
assert.equal((html.match(/data:image\/jpeg;base64,QUJD/g) ?? []).length, 2)
assert.match(html, /小D · 向阳教练平台 · 朋友圈获客/) // 页脚品牌 = 讲者·品牌·标题
assert.match(html, /F 全屏 · ⌘P 存PDF/)
assert.doesNotMatch(html, /\{\{/) // 不允许残留占位符

// 图片令牌缺失时：image 页跳过、imagetext 页降级为清单页，绝不出死链
const withoutImages = core.assembleDeckHtml({ outline: goodOutline, theme: '深蓝', imageDataUrls: new Map() })
assert.doesNotMatch(withoutImages, /<img/)
assert.match(withoutImages, /截图\+一句点评/)

// 模型夹带的任意 HTML 必须被转义，仅放行 <b>
const hostile = core.assembleDeckHtml({
  outline: {
    meta: { deck_title: 'x<script>alert(1)</script>' },
    slides: [
      { type: 'cover', title_prefix: '<img src=x onerror=alert(1)>', title_accent: 'y' },
      { type: 'list', title: 't', items: [{ text: '加<b>粗</b>保留<i>斜体转义</i>' }] },
      { type: 'quote', quote: 'q' },
      { type: 'end', title: 'e' },
    ],
  },
  theme: '深蓝',
  imageDataUrls: new Map(),
})
assert.doesNotMatch(hostile, /<script>alert/)
assert.doesNotMatch(hostile, /onerror=alert/)
assert.match(hostile, /加<b>粗<\/b>保留&lt;i&gt;斜体转义&lt;\/i&gt;/)

// 超长文字按可见字数截断，保版面
assert.equal(core.clipVisible('一'.repeat(50), 10), `${'一'.repeat(9)}…`)
assert.equal(core.clipVisible('短<b>句</b>', 10), '短<b>句</b>')

// ── 源文图片令牌提取 ──
const tokens = core.extractSourceImageTokens(
  '正文 ![](attachments/a%20b.jpg) 与 ![[漏斗.png|说明]] 重复 ![[漏斗.png]] 外链 ![](https://x.com/a.png)',
)
assert.deepEqual(tokens.map((t) => t.target), ['漏斗.png', 'attachments/a b.jpg'])

// ── UI 层源码约束 ──
const source = await readFile(new URL('../src/deck-builder.ts', import.meta.url), 'utf8')
assert.match(source, /\/api\/plugin\/v1\/skills\/deck-builder/)
assert.match(source, /selectTranscriptSource\(plugin, '课件PPT', DECK_SOURCE_MAX, '文档'\)/)
assert.match(source, /DECK_BUILDER_OUTPUT_FOLDER/)
assert.match(source, /图片在本机压缩后直接嵌进课件，不会上传/)
assert.doesNotMatch(source, /writeOutput\(/)
assert.doesNotMatch(source, /积分|计费/) // 报错与提示文案不得提计费
const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(main, /id: 'deck-builder'/)
assert.match(main, /课件PPT:选择文档/)

console.log('deck builder tests passed')

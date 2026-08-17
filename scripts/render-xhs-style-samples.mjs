/**
 * 离线渲染三种小红书卡片风格的样片(开发工具,不进 npm test)。
 * 用与插件完全相同的绘制模块(@napi-rs/canvas 提供 Canvas),供发版前视觉验收。
 *
 * 用法: node scripts/render-xhs-style-samples.mjs [输出目录]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createCanvas, Path2D as NapiPath2D } from '@napi-rs/canvas'

if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = NapiPath2D

async function loadTs(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  const module = { exports: {} }
  new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
  return module.exports
}

const core = await loadTs('src/xhs-card-core.ts')
const render = await loadTs('src/xhs-card-render.ts')

const sampleMarkdown = `# 不是不想做一人公司，是不知道自己能卖什么

很多人卡住的从来不是能力，而是**说不清自己到底帮谁、解决什么问题**。

> 清晰就是力量，模糊就是贫穷。

## 先跑通商业闭环，再迭代定位

我的建议一直是三步：盘点你已经被验证过的优势，找到愿意付钱的那群人，用最小闭环把第一单跑通。

核心问题从来不是「要不要卖时间」，而是你被替换掉之后，靠什么赚钱。顺序千万别搞反，很多人一上来就磨定位，磨了三个月一单没开。

#一人公司 #个人品牌
`

const parsed = core.parseXhsCardDocument(sampleMarkdown, '样片')
const outDir = process.argv[2] ?? 'sample-cards'
await mkdir(outDir, { recursive: true })

async function savePage(name, draw) {
  const canvas = createCanvas(render.CARD_WIDTH, render.CARD_HEIGHT)
  const context = canvas.getContext('2d')
  draw(context)
  await writeFile(`${outDir}/${name}`, canvas.toBuffer('image/png'))
  console.log('written:', `${outDir}/${name}`)
}

// classic 与 mono:封面 + 正文页
for (const styleId of ['classic', 'mono']) {
  const palette = render.paletteForStyle(styleId)
  const { coverBlocks, remainingBlocks } = core.takeXhsCoverIntro(parsed.blocks)
  const pages = remainingBlocks.length > 0 ? core.paginateXhsCardBlocks(remainingBlocks) : []
  const total = pages.length + 1
  await savePage(`${styleId}-01-cover.png`, (context) =>
    render.drawCover(context, palette, parsed, coverBlocks, null, total),
  )
  if (pages[0]) {
    await savePage(`${styleId}-02-body.png`, (context) =>
      render.drawBodyPage(context, palette, pages[0].blocks, new Map(), 2, total),
    )
  }
}

// x-dark:压平 + 推文分页(与 xhs-cards.ts 同一套接线)
{
  const fullBold = (text) => [{ start: 0, end: text.length }]
  const flattened = [
    { kind: 'paragraph', text: parsed.title, boldRanges: fullBold(parsed.title) },
    ...parsed.blocks.map((block) =>
      block.kind === 'heading'
        ? { kind: 'paragraph', text: block.text, boldRanges: fullBold(block.text) }
        : block.kind === 'quote'
          ? { ...block, kind: 'paragraph' }
          : block,
    ),
  ]
  const measure = createCanvas(10, 10).getContext('2d')
  const L = render.X_TWEET_LAYOUT
  const pages = core.paginateXTweetBlocks(flattened, {
    pageBodyHeight: L.bodyBottom - L.bodyTop,
    lineHeight: L.lineHeight,
    paragraphGap: L.paragraphGap,
    imageGap: L.imageGap,
    lineCount: (block) =>
      render.wrapRichText(measure, block, L.bodyWidth, L.fontSize, 400, 700, 0, 'sans', true).length,
    imageHeight: () => 0,
  })
  const options = { nickname: 'Alina霖子', handle: 'alinalinzi', avatar: null, dateText: '2026/08/17' }
  for (let index = 0; index < pages.length; index++) {
    await savePage(`x-dark-${String(index + 1).padStart(2, '0')}.png`, (context) =>
      render.drawXTweetPage(context, pages[index].blocks, new Map(), options),
    )
  }
}

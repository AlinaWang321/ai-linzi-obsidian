import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/xhs-card-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
})
const module = { exports: {} }
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
const cards = module.exports

const parsed = cards.parseXhsCardDocument(
  `---
title: "测试"
---
# 一人公司真正要做的，不是把自己变忙

## 先停一下

你需要的不是更多任务，而是**更清楚的优先级**。

> 系统的意义，是替你守住重复动作。

#一人公司 #内容系统
`,
  '备用标题',
)

assert.equal(parsed.title, '一人公司真正要做的，不是把自己变忙')
assert.deepEqual(parsed.hashtags, ['#一人公司', '#内容系统'])
assert.deepEqual(
  parsed.blocks.map((block) => block.kind),
  ['heading', 'paragraph', 'quote'],
)
assert.equal(parsed.blocks[0].level, 2)
assert.equal(parsed.blocks[0].sectionIndex, 1)
assert.equal(parsed.excerpt, '')
assert.deepEqual(parsed.blocks[1].boldRanges, [{ start: 13, end: 20 }])

const withSummary = cards.parseXhsCardDocument(
  '# 标题\n\n正文第一段不应该自动变成摘要。',
  '备用标题',
  '这是原文 frontmatter 中明确提供的摘要。',
)
assert.equal(withSummary.excerpt, '这是原文 frontmatter 中明确提供的摘要。')

const withStandalonePart = cards.parseXhsCardDocument(
  '# 标题\n\n**PART 01**\n\n## 第一部分\n\n第一段正文。',
  '备用标题',
)
assert.deepEqual(
  withStandalonePart.blocks.map((block) => block.text),
  ['第一部分', '第一段正文。'],
)
assert.equal(withStandalonePart.blocks[0].sectionIndex, 1)

const withCombinedPart = cards.parseXhsCardDocument(
  '# 标题\n\n## PART 03：第三部分\n\n正文。',
  '备用标题',
)
assert.equal(withCombinedPart.blocks[0].text, '第三部分')
assert.equal(withCombinedPart.blocks[0].sectionIndex, 3)

const withOldGallery = cards.parseXhsCardDocument(
  `# 标题

真正的文章结尾。

<!-- AI_LINZI_XHS_CARDS_START -->
## 小红书 3:4 发布卡片

> 由 AI霖子在本地生成；发布前可直接检查每一页。

![[AI霖子输出/小红书/测试卡片/01.png]]
<!-- AI_LINZI_XHS_CARDS_END -->`,
  '备用标题',
)
assert.deepEqual(withOldGallery.blocks.map((block) => block.text), ['真正的文章结尾。'])
assert.equal(
  withOldGallery.blocks.some(
    (block) => block.text.includes('发布卡片') || block.text.includes('由 AI霖子在本地生成'),
  ),
  false,
)

const composedNote = cards.composeGeneratedXhsNote(
  `---
title: "小红书测试"
来源路径: "公众号/原文.md"
---

# 公众号原文标题

这里是公众号全文，不应该出现在最终小红书笔记中。`,
  ['AI霖子输出/小红书/测试卡片/01.png', 'AI霖子输出/小红书/测试卡片/02.png'],
  '## 小红书爆款标题（3选1）\n\n1. 标题一\n2. 标题二\n3. 标题三\n\n## 小红书正文\n\n这是可以直接发布的小红书配文。\n\n#一人公司 #AI霖子',
)
assert.ok(composedNote.startsWith('---\ntitle: "小红书测试"'))
assert.ok(composedNote.includes('![[AI霖子输出/小红书/测试卡片/01.png]]'))
assert.ok(composedNote.includes('![[AI霖子输出/小红书/测试卡片/02.png]]'))
assert.ok(composedNote.indexOf('这是可以直接发布的小红书配文') < composedNote.indexOf('01.png'))
assert.equal(composedNote.includes('这里是公众号全文'), false)

const withImages = cards.parseXhsCardDocument(
  `# 图文混排测试

图片上面的正文。

![文章配图](attachments/第一张.png)

图片下面的正文。

![[04_Output/第二张.jpg|第二张说明]]

<img src="https://example.com/第三张.webp" alt="第三张说明">

最后一段正文。`,
  '备用标题',
)
assert.deepEqual(
  withImages.blocks.map((block) => block.kind),
  ['paragraph', 'image', 'paragraph', 'image', 'image', 'paragraph'],
)
assert.deepEqual(
  withImages.blocks.filter((block) => block.kind === 'image').map((block) => block.imageSource),
  ['attachments/第一张.png', '04_Output/第二张.jpg', 'https://example.com/第三张.webp'],
)
assert.deepEqual(
  withImages.blocks.filter((block) => block.kind === 'image').map((block) => block.text),
  ['文章配图', '第二张说明', '第三张说明'],
)

const coverSource = cards.parseXhsCardDocument(
  '# 标题\n\n这是正文开头第一句。**这句要加粗。**这是正文开头后续内容。'.concat('继续正文。'.repeat(30)),
  '备用标题',
)
const coverSplit = cards.takeXhsCoverIntro(coverSource.blocks, 28)
assert.ok(coverSplit.coverBlocks.length > 0)
assert.ok(coverSplit.remainingBlocks.length > 0)
assert.ok(coverSplit.coverBlocks[0].text.startsWith('这是正文开头第一句'))
assert.equal(
  coverSplit.coverBlocks.map((block) => block.text).join('') +
    coverSplit.remainingBlocks.map((block) => block.text).join(''),
  coverSource.blocks.map((block) => block.text).join(''),
)
assert.ok(
  [...coverSplit.coverBlocks, ...coverSplit.remainingBlocks].some((block) =>
    (block.boldRanges ?? []).some((range) => range.end > range.start),
  ),
)

const orderedCover = cards.takeXhsCoverIntro(
  [
    { kind: 'heading', text: '第一部分', level: 2, sectionIndex: 1 },
    { kind: 'paragraph', text: '第一部分的正文开头。' },
    { kind: 'paragraph', text: '后续正文。' },
  ],
  29,
)
assert.deepEqual(
  orderedCover.coverBlocks.map((block) => block.text),
  ['第一部分', '第一部分的正文开头。'],
)
assert.deepEqual(orderedCover.remainingBlocks.map((block) => block.text), ['后续正文。'])

const coverStopsAtImage = cards.takeXhsCoverIntro(
  [
    { kind: 'paragraph', text: '图片前正文。' },
    { kind: 'image', text: '配图', imageSource: 'attachments/image.png' },
    { kind: 'paragraph', text: '图片后正文。' },
  ],
  100,
)
assert.deepEqual(coverStopsAtImage.coverBlocks.map((block) => block.text), ['图片前正文。'])
assert.deepEqual(
  coverStopsAtImage.remainingBlocks.map((block) => block.kind),
  ['image', 'paragraph'],
)

const withoutRule = cards.parseXhsCardDocument('# 标题\n\n正文。\n\n---\n\n## 小标题', '备用标题')
assert.equal(withoutRule.blocks.some((block) => block.text === '---'), false)
assert.equal(withoutRule.blocks.at(-1).level, 2)
assert.equal(withoutRule.blocks.at(-1).sectionIndex, 1)

const longBold = cards.parseXhsCardDocument(
  `# 标题\n\n${'普通正文。'.repeat(55)}**${'需要保留的金句。'.repeat(12)}**`,
  '备用标题',
)
const boldPages = cards.paginateXhsCardBlocks(longBold.blocks, 6)
assert.ok(boldPages.length > 1)
assert.ok(
  boldPages
    .flatMap((page) => page.blocks)
    .some((block) => (block.boldRanges ?? []).some((range) => range.end > range.start)),
)

const pages = cards.paginateXhsCardBlocks(
  Array.from({ length: 8 }, (_, index) => ({
    kind: index % 3 === 0 ? 'heading' : 'paragraph',
    text: `${index + 1} ${'这是一段用于测试自动分页的中文内容。'.repeat(8)}`,
  })),
)
assert.ok(pages.length > 1)
assert.ok(pages.every((page) => page.blocks.length > 0))

const mixedPages = cards.paginateXhsCardBlocks([
  { kind: 'paragraph', text: '图片上方的正文。'.repeat(4) },
  {
    kind: 'image',
    text: '原文配图',
    imageSource: 'attachments/mixed.png',
    imageAspectRatio: 16 / 9,
  },
  { kind: 'paragraph', text: '图片下方的正文。'.repeat(4) },
])
assert.ok(
  mixedPages.some(
    (page) =>
      page.blocks.some((block) => block.kind === 'image') &&
      page.blocks.some((block) => block.kind === 'paragraph'),
  ),
  '图片页应该同时保留上下文文字，而不是一张图片独占一页',
)
const compactMixedPages = cards.paginateXhsCardBlocks([
  { kind: 'paragraph', text: '图片前面的正文。'.repeat(34) },
  {
    kind: 'image',
    text: '原文横版配图',
    imageSource: 'attachments/compact.png',
    imageAspectRatio: 3 / 2,
  },
  { kind: 'paragraph', text: '图片右边的短上下文。'.repeat(5) },
])
assert.equal(compactMixedPages.length, 1)
assert.deepEqual(
  compactMixedPages[0].blocks.map((block) => block.kind),
  ['paragraph', 'paragraph', 'image', 'paragraph'],
)
assert.equal(
  cards.shouldUseXhsSideBySideLayout(
    compactMixedPages[0].blocks[2],
    compactMixedPages[0].blocks[3],
  ),
  true,
)
const roomyMixedPages = cards.paginateXhsCardBlocks([
  { kind: 'paragraph', text: '图片前面的正文。'.repeat(4) },
  {
    kind: 'image',
    text: '正常全宽配图',
    imageSource: 'attachments/full-width.png',
    imageAspectRatio: 3 / 2,
  },
  { kind: 'paragraph', text: '图片下方的短上下文。'.repeat(3) },
])
const roomyImage = roomyMixedPages
  .flatMap((page) => page.blocks)
  .find((block) => block.kind === 'image')
assert.equal(roomyImage?.imageLayout, 'full')
assert.equal(
  cards.shouldUseXhsSideBySideLayout(
    roomyImage,
    roomyMixedPages.flatMap((page) => page.blocks).find((block) => block.text.includes('短上下文')),
  ),
  false,
  '当前页能容纳全宽图时，不应仅因后面文字较短就改成左图右文',
)
const headingPages = cards.paginateXhsCardBlocks(
  [
    { kind: 'paragraph', text: '前一页正文。'.repeat(40) },
    { kind: 'heading', text: '新的章节', level: 2, sectionIndex: 2 },
    { kind: 'paragraph', text: '章节开头必须跟着标题。'.repeat(8) },
  ],
  8,
)
assert.ok(
  headingPages.slice(0, -1).every((page) => page.blocks.at(-1)?.kind !== 'heading'),
  '章节标题不能孤零零留在上一页底部',
)
const adaptiveHeadingImagePages = cards.paginateXhsCardBlocks([
  {
    kind: 'image',
    text: '课程真实页面',
    imageSource: 'attachments/course.png',
    imageAspectRatio: 1160 / 665,
  },
  { kind: 'paragraph', text: '课程真实页面：左边直接播放课程，右边是16节完整目录和学习进度。' },
  { kind: 'heading', text: '课程讲完以后，AI继续陪你行动落地', level: 2, sectionIndex: 2 },
  {
    kind: 'image',
    text: '章节配图',
    imageSource: 'attachments/part-02.png',
    imageAspectRatio: 3 / 2,
  },
])
assert.equal(adaptiveHeadingImagePages.length, 1)
assert.deepEqual(
  adaptiveHeadingImagePages[0].blocks.map((block) => block.kind),
  ['image', 'paragraph', 'heading', 'image'],
)
const adaptiveHeadingImage = adaptiveHeadingImagePages[0].blocks.at(-1)
assert.equal(adaptiveHeadingImage?.imageLayout, 'full')
assert.ok(
  Number(adaptiveHeadingImage?.imageMaxHeight) >= cards.XHS_HEADING_IMAGE_MIN_HEIGHT,
  '章节配图缩小后仍需保持可读尺寸',
)
assert.ok(
  Number(adaptiveHeadingImage?.imageMaxHeight) < cards.XHS_BODY_IMAGE_MAX_HEIGHT,
  '章节配图应按上一页剩余空间缩小，而不是整组换页',
)
const endingImagePages = cards.paginateXhsCardBlocks([
  { kind: 'paragraph', text: '图片前面的长正文。'.repeat(70) },
  {
    kind: 'image',
    text: '结尾原文配图',
    imageSource: 'attachments/ending.png',
    imageAspectRatio: 3 / 4,
  },
])
const endingImagePage = endingImagePages.find((page) =>
  page.blocks.some((block) => block.kind === 'image'),
)
assert.ok(endingImagePage?.blocks.some((block) => block.kind !== 'image'))
assert.equal(cards.stableContentFingerprint('same'), cards.stableContentFingerprint('same'))
assert.notEqual(cards.stableContentFingerprint('same'), cards.stableContentFingerprint('different'))

// ── X 推文风分页:装满优先(句读/行边界切分)+ 硬边界不可越过 ──
const X_PER_LINE = 20
const X_BUDGET = {
  pageBodyHeight: 878, // floor((878-44)/82)=10 行/页
  lineHeight: 82,
  paragraphGap: 44,
  imageGap: 40,
  // 估算测量:CJK 字宽≈字号,一行 20 字
  wrapLines: (block) => {
    const count = Math.max(1, Math.ceil(block.text.length / X_PER_LINE))
    return Array.from({ length: count }, (_, index) => ({ start: index * X_PER_LINE }))
  },
  imageHeight: () => 400,
}
const xBlockHeight = (block) =>
  block.kind === 'image'
    ? X_BUDGET.imageHeight(block) + X_BUDGET.imageGap
    : X_BUDGET.wrapLines(block).length * X_BUDGET.lineHeight + X_BUDGET.paragraphGap

const xParagraph = (text) => ({ kind: 'paragraph', text })
const xSentence = '这一句正好二十个字用来测试分页效果好。' // 19 字 + 句号
const xInput = [
  xParagraph(xSentence.repeat(9)), // 180 字 = 9 行,占满近一页
  xParagraph(xSentence.repeat(9)),
  { kind: 'image', text: '', imageSource: 'a.png' },
  xParagraph('尾段收束。'),
]
const xPages = cards.paginateXTweetBlocks(xInput, X_BUDGET)
assert.ok(xPages.length >= 2, 'X 分页应产生多页')
for (const page of xPages) {
  const used = page.blocks.reduce((sum, block) => sum + xBlockHeight(block), 0)
  assert.ok(used <= X_BUDGET.pageBodyHeight, `每页内容高度(${used})不得超过正文区硬边界`)
}
// 装满优先:除最后一页外,每页剩余空间必须放不下下一行(松弛 < 一行+段距)
for (let index = 0; index < xPages.length - 1; index++) {
  const used = xPages[index].blocks.reduce((sum, block) => sum + xBlockHeight(block), 0)
  const nextIsImage = xPages[index + 1].blocks[0]?.kind === 'image'
  const nextNeed = nextIsImage ? 440 : X_BUDGET.lineHeight + X_BUDGET.paragraphGap
  assert.ok(
    X_BUDGET.pageBodyHeight - used < nextNeed,
    `第 ${index + 1} 页应装满(剩余 ${X_BUDGET.pageBodyHeight - used}px 还装得下下一块的开头)`,
  )
}
// 切分优先句读:被切开的页尾文本块以句读结尾
const firstPageLastText = xPages[0].blocks.filter((block) => block.kind !== 'image').at(-1)
assert.match(firstPageLastText.text, /[。！？；…!?;]$/, '页尾切点应落在句读上')
// 不丢字:输入输出全文一致
const xJoined = xPages.flatMap((page) => page.blocks.filter((b) => b.kind !== 'image').map((b) => b.text)).join('')
assert.equal(xJoined, xInput.filter((b) => b.kind !== 'image').map((b) => b.text).join(''))
// 图片不可切:整张出现且只出现一次
assert.equal(xPages.flatMap((page) => page.blocks.filter((b) => b.kind === 'image')).length, 1)

// 超长单段(无句读)在整页空间里按行边界连续切,页页装满且不丢字
const noPunct = '连续不断没有标点的长句子'.repeat(40)
const longPages = cards.paginateXTweetBlocks([xParagraph(noPunct)], X_BUDGET)
assert.ok(longPages.length >= 2)
for (const page of longPages) {
  const used = page.blocks.reduce((sum, block) => sum + xBlockHeight(block), 0)
  assert.ok(used <= X_BUDGET.pageBodyHeight)
}
assert.equal(longPages.flatMap((p) => p.blocks.map((b) => b.text)).join(''), noPunct)

// ── 封面装满(fillCoverBlocks):与正文页同规则,不留大空白 ──
const renderResult = await build({
  entryPoints: ['src/xhs-card-render.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
})
const renderModule = { exports: {} }
new Function('module', 'exports', renderResult.outputFiles[0].text)(renderModule, renderModule.exports)
const renderLib = renderModule.exports
const stubCtx = { font: '', measureText: (text) => ({ width: Array.from(text).length * 20 }) }
const coverDoc = { title: '短标题', excerpt: '', hashtags: [], blocks: [] }
const coverPara = (text) => ({ kind: 'paragraph', text })
const paletteMono = renderLib.MONO_PALETTE
// 短文章:全部装进封面,单卡完成
const shortFill = renderLib.fillCoverBlocks(stubCtx, paletteMono, coverDoc, null, [coverPara('只有一小段。')])
assert.equal(shortFill.remainingBlocks.length, 0, '短文章应一张封面卡装完')
// 长文章:封面装满后按句读切,剩余进正文页,不丢字
const coverSentence = '封面段落也用二十个字一句来测试装满。'
const longBlocks = [coverPara(coverSentence.repeat(60)), coverPara('后续段落。')]
const longFill = renderLib.fillCoverBlocks(stubCtx, paletteMono, coverDoc, null, longBlocks)
assert.ok(longFill.coverBlocks.length >= 1 && longFill.remainingBlocks.length >= 1)
assert.match(longFill.coverBlocks.at(-1).text, /[。！？；…!?;]$/, '封面切点应落在句读上')
assert.equal(
  [...longFill.coverBlocks, ...longFill.remainingBlocks].map((b) => b.text).join(''),
  longBlocks.map((b) => b.text).join(''),
)
// 遇到配图停止:配图与其后内容全部留给正文页
const imageFill = renderLib.fillCoverBlocks(stubCtx, paletteMono, coverDoc, null, [
  coverPara('第一段。'),
  { kind: 'image', text: '', imageSource: 'b.png' },
  coverPara('图后段落。'),
])
assert.equal(imageFill.coverBlocks.length, 1)
assert.equal(imageFill.remainingBlocks[0].kind, 'image')

// ── 风格清单与渲染层接线 ─────────────────────────────
const { readFile } = await import('node:fs/promises')
const styleResult = await build({
  entryPoints: ['src/xhs-card-styles.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
})
const styleModule = { exports: {} }
new Function('module', 'exports', styleResult.outputFiles[0].text)(styleModule, styleModule.exports)
const styles = styleModule.exports
assert.deepEqual(
  styles.XHS_CARD_STYLES.map((style) => style.id),
  ['classic', 'mono', 'x-dark'],
)
assert.equal(styles.getXhsCardStyle('不存在').id, 'classic', '未知风格必须回退经典彩色')

const renderSource = await readFile(new URL('../src/xhs-card-render.ts', import.meta.url), 'utf8')
assert.match(renderSource, /paper: '#FFFFFF',\n  title: '#252D38',\n  ink: '#33383F',/, '经典调色板取值不得偏离旧常量')
assert.match(renderSource, /showPageNumber: true/, '经典风格保留页码')
const monoBlock = renderSource.slice(renderSource.indexOf('MONO_PALETTE'))
assert.match(monoBlock, /showPageNumber: false/, '黑白极简不带页码')
assert.doesNotMatch(renderSource, /drawPageChrome\(context,\s*[^,]+,\s*\d+,\s*\d+\)[\s\S]{0,400}drawXTweetPage/, 'X 页面不绘制页码')
const xSection = renderSource.slice(renderSource.indexOf('export function drawXTweetPage'))
assert.doesNotMatch(xSection, /drawPageChrome/, 'X 推文页不得出现页码绘制')
assert.match(xSection, /drawXAvatar/, 'X 推文页必须绘制头部')
assert.match(xSection, /X_FAKE_METRICS/, 'X 推文页必须绘制底部互动条')

const cardsSource = await readFile(new URL('../src/xhs-cards.ts', import.meta.url), 'utf8')
assert.match(cardsSource, /input\.style \?\? 'classic'/, '缺省风格必须是经典彩色,旧调用输出不变')
assert.match(cardsSource, /paginateXTweetBlocks\(flattened/, 'X 风格必须走推文分页器')
const actionsSource = await readFile(new URL('../src/actions.ts', import.meta.url), 'utf8')
const pickerCalls = actionsSource.match(/await pickXhsCardStyle\(plugin\)/g) ?? []
assert.equal(pickerCalls.length, 2, '卡片技能与多平台分发都必须先经过风格选择卡')
for (const match of actionsSource.matchAll(/pickXhsCardStyle\(plugin\)[\s\S]{0,120}/g)) {
  assert.match(match[0], /if \(!styleChoice\) return/, '取消选择必须在服务端调用前中止')
}

console.log('xhs card core regression tests passed')

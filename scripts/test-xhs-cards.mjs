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
  '这是可以直接发布的小红书配文。\n\n#一人公司 #AI霖子',
)
assert.ok(composedNote.startsWith('---\ntitle: "小红书测试"'))
assert.ok(composedNote.includes('![[AI霖子输出/小红书/测试卡片/01.png]]'))
assert.ok(composedNote.includes('![[AI霖子输出/小红书/测试卡片/02.png]]'))
assert.ok(composedNote.indexOf('01.png') < composedNote.indexOf('这是可以直接发布的小红书配文'))
assert.equal(composedNote.includes('这里是公众号全文'), false)

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
assert.equal(cards.stableContentFingerprint('same'), cards.stableContentFingerprint('same'))
assert.notEqual(cards.stableContentFingerprint('same'), cards.stableContentFingerprint('different'))

console.log('xhs card core regression tests passed')

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

async function loadTs(entry, withObsidianStub = false) {
  const plugins = withObsidianStub
    ? [
        {
          name: 'obsidian-stub',
          setup(ctx) {
            ctx.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
            ctx.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              loader: 'js',
              contents: `
                export class Notice { hide() {} }
                export class TFile {}
                export class Modal {}
                export class Setting {}
                export const requestUrl = async () => ({})
                export const normalizePath = (value) => value
              `,
            }))
          },
        },
      ]
    : []
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins,
    logLevel: 'silent',
  })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
  return module.exports
}

const article = await loadTs('src/article-format.ts')
const publisher = await loadTs('src/publish.ts', true)

const writerOutput = `## 一、5 个爆款标题候选

1. 标题甲
2. 标题乙

## 二、正文（约 3000 字）

这是开头。

**PART 04**
**低心力客户，最容易把教练拖进拯救关系**

**真正值得加粗的是这一节的核心判断。**

这是正文。

![图注](assets/body.png)

## 三、摘要

这是摘要。`

const preparedWriter = article.prepareWechatArticle(writerOutput)
assert.equal(preparedWriter.recognizedContainer, true)
assert.deepEqual(preparedWriter.titleCandidates, ['标题甲', '标题乙'])
assert.equal(preparedWriter.digest, '这是摘要。')
assert.match(preparedWriter.body, /\*\*PART 04\*\*\n\n## 低心力客户/)
assert.doesNotMatch(preparedWriter.body, /标题候选|## 三、摘要/)

const interviewOutput = `## 一、5 个爆款标题候选

1. 访谈标题

## 二、正文(约 N 字)

开头。

PART 01 真正昂贵的是高质量思考
正文。

## 三、摘要
访谈摘要。`
const preparedInterview = article.prepareWechatArticle(interviewOutput)
assert.match(preparedInterview.body, /\*\*PART 01\*\*\n\n## 真正昂贵的是高质量思考/)

const oneSentenceDigest = article.prepareWechatArticle(
  interviewOutput.replace('## 三、摘要', '## 三、一句话摘要'),
)
assert.equal(oneSentenceDigest.digest, '访谈摘要。')

const withFrontmatter = `---\ntitle: 测试\n状态: 草稿\n---\n\n正文第一段。`
const inserted = article.insertEmbeds(withFrontmatter, [{ path: 'assets/body.png', anchor: '找不到的锚点' }])
assert.match(inserted.out, /^---\ntitle: 测试\n状态: 草稿\n---/)
assert.equal(inserted.out.split('---')[1].includes('![['), false)
const withCover = article.insertCoverEmbed(inserted.out, 'assets/cover.png')
assert.match(withCover, /^---\ntitle: 测试\n状态: 草稿\n---/)
assert.ok(withCover.indexOf('![[assets/cover.png]]') > withCover.indexOf('\n---', 4))

const html = publisher.mdToWechatHtml(
  writerOutput.replace('这是正文。', "这是正文。\n\n<script>alert('x')</script>"),
  () => '<img src="https://example.com/body.png" style="display:block;width:100%;">',
)
assert.match(html, /font-size:14px/)
assert.match(html, /color:#0057FF/)
assert.doesNotMatch(html, /标题候选|这是摘要|<script|alert\(/)
assert.match(html, /example\.com\/body\.png/)
assert.match(
  html,
  /<strong style="color:#1f3f7c;font-weight:700;">真正值得加粗的是这一节的核心判断。<\/strong>/,
)

const historicBody = `![[attachments/2026.07.22_00_封面_测试.png]]

# PART 01

过去几个月，AI霖子一直是一个网页端产品。`
assert.equal(
  publisher.resolveWechatDigest(undefined, '', historicBody),
  '过去几个月，AI霖子一直是一个网页端产品。',
)
assert.equal(
  publisher.resolveWechatDigest({ 一句话摘要: '  插件让本地笔记和 AI 无缝连接。  ' }, '', historicBody),
  '插件让本地笔记和 AI 无缝连接。',
)
assert.equal(
  publisher.isDedicatedWechatCover({ src: 'attachments/2026_00_封面_测试.png', alt: '' }),
  true,
)
assert.equal(
  publisher.isDedicatedWechatCover({ src: 'attachments/正文图.png', alt: '' }),
  false,
)
const imageBlock = publisher.wechatImageHtml('https://example.com/a.png', '说明')
assert.match(imageBlock, /^<section/)
assert.match(imageBlock, /<img src="https:\/\/example\.com\/a\.png"/)
assert.match(imageBlock, /<\/section>$/)

console.log('format regression tests passed')

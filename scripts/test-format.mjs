import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

async function loadTs(entry, withObsidianStub = false, harness) {
  const plugins = withObsidianStub
    ? [
        {
          name: 'obsidian-stub',
          setup(ctx) {
            if (harness) {
              ctx.onResolve({ filter: /wechat-theme-picker$/ }, () => ({ path: 'picker', namespace: 'picker-stub' }))
              ctx.onLoad({ filter: /.*/, namespace: 'picker-stub' }, () => ({ loader: 'js', contents: 'export const pickWechatTheme = (plugin, preview) => harness.pick(plugin, preview)' }))
            }
            ctx.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
            ctx.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              loader: 'js',
              contents: `
                export class Notice { hide() {} }
                export const TFile = harness?.TFile ?? class {}
                export class Modal {}
                export class Setting {}
                export const sanitizeHTMLToDom = () => {};
                export const requestUrl = async (options) => harness ? harness.requestUrl(options) : ({})
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
  new Function('module', 'exports', 'require', 'harness', result.outputFiles[0].text)(module, module.exports, require, harness)
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

const completeWriterOutput = `## 一、5 个爆款标题候选

1. 标题一
2. 标题二
3. 标题三
4. 标题四
5. 标题五

## 二、正文（约 4000 字）

${'这是完整正文。'.repeat(520)}

## 三、一句话摘要

这是一句完整且可以直接使用的文章摘要。`
assert.equal(article.isCompleteWechatArticle(article.prepareWechatArticle(completeWriterOutput)), true)
assert.equal(article.isCompleteWechatArticle(preparedWriter), false, '标题与摘要不完整的残稿不得写入')
for (const bodyChars of [1, 1100, 1681, 2174, 2847]) {
  const shortOutput = completeWriterOutput.replace('这是完整正文。'.repeat(520), '文'.repeat(bodyChars))
  assert.equal(article.isCompleteWechatArticle(article.prepareWechatArticle(shortOutput)), true, `${bodyChars} 字完整正文可以交付`)
}
const emptyOutput = completeWriterOutput.replace('这是完整正文。'.repeat(520), '')
assert.equal(article.isCompleteWechatArticle(article.prepareWechatArticle(emptyOutput)), false, '空正文不交付')

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
  /<strong style="color:#0057FF;font-weight:700;">真正值得加粗的是这一节的核心判断。<\/strong>/,
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

assert.deepEqual(
  publisher.wechatImageLinkCandidates('assets/%E6%B5%8B%E8%AF%95%20%E5%9B%BE.png'),
  ['assets/测试 图.png', 'assets/%E6%B5%8B%E8%AF%95%20%E5%9B%BE.png'],
  '合法 URL 编码优先解码，同时保留原路径兜底',
)
assert.deepEqual(
  publisher.wechatImageLinkCandidates('assets/100%真实.png'),
  ['assets/100%真实.png'],
  '文件名含字面量百分号时不得抛出 URI malformed',
)
assert.equal(
  publisher.isExternalFileImageSource('<file:///private/var/folders/wps-office/wps1.jpg>'),
  true,
  'WPS 临时 file URI 必须与 Vault 图片区分',
)
assert.match(publisher.friendlyWxError(40164, 'invalid ip 120.230.70.62'), /120\.230\.70\.62/)
assert.match(publisher.friendlyWxError(40164, 'invalid ip 120.230.70.62'), /VPN\/代理/)

// ── 公众号排版主题库 ──────────────────────────────
const themes = await loadTs('src/wechat-themes.ts')
assert.ok(Array.isArray(themes.WECHAT_THEMES) && themes.WECHAT_THEMES.length >= 4, '至少提供 4 套排版主题')
const themeIds = themes.WECHAT_THEMES.map((t) => t.id)
assert.equal(new Set(themeIds).size, themeIds.length, '主题 id 不得重复')
assert.equal(themes.DEFAULT_WECHAT_THEME.id, 'classic-blue', '经典亮蓝必须是默认主题')
assert.equal(themes.getWechatTheme('不存在的历史id').id, 'classic-blue', '未知主题 id 必须回退默认')

// 默认主题输出必须与主题库里的 classic-blue 完全一致(老用户升级零变化)
const classic = themes.getWechatTheme('classic-blue')
assert.equal(
  publisher.mdToWechatHtml(writerOutput, () => ''),
  publisher.mdToWechatHtml(writerOutput, () => '', false, classic),
)

// 每套主题都能完整渲染,颜色正确落到强调元素上
const themeSample = writerOutput.replace('这是正文。', '这是正文。\n\n> 引用一句话。')
for (const theme of themes.WECHAT_THEMES) {
  const themed = publisher.mdToWechatHtml(themeSample, () => '', true, theme)
  assert.match(themed, /^<section/)
  assert.doesNotMatch(themed, /undefined/)
  assert.ok(themed.includes(`color:${theme.accent}`), `主题 ${theme.id} 的强调色应出现在输出中`)
  assert.ok(themed.includes(`background:${theme.quoteBg}`), `主题 ${theme.id} 的引用底色应出现在输出中`)
}

// 标题与胶囊变体确实生效,且主题之间不串色
const mono = themes.getWechatTheme('mono-ink')
const monoHtml = publisher.mdToWechatHtml(themeSample, () => '', false, mono)
assert.doesNotMatch(monoHtml, /#0057FF/, '非默认主题不得残留经典亮蓝的颜色')
assert.match(monoHtml, /<h2 style="[^"]*border-bottom/, '极简黑白的大标题应为下划线变体')
assert.match(monoHtml, /<p style="[^"]*border:1px solid #111111[^"]*">PART 04<\/p>/, '极简黑白的 PART 胶囊应为描边变体')
const warm = themes.getWechatTheme('warm-clay')
const warmHtml = publisher.mdToWechatHtml(themeSample, () => '', false, warm)
assert.match(warmHtml, /<h2 style="[^"]*border-radius:6px;background:/, '暖橙杂志的大标题应为底色块变体')

const publishSource = await readFile(new URL('../src/publish.ts', import.meta.url), 'utf8')
assert.match(publishSource, /pickArticleWechatTheme\(plugin, note\)/, '排版与发草稿箱入口必须先经过主题选择卡')
const pickerSource = await readFile(new URL('../src/wechat-theme-picker.ts', import.meta.url), 'utf8')
assert.match(pickerSource, /wechatThemeId/, '主题选择卡必须记住上次选择')
const sendDraftStart = publishSource.indexOf('export async function sendToWechatDraft')
assert.ok(sendDraftStart >= 0, '必须保留公众号草稿箱发送入口')
const sendDraftSource = publishSource.slice(sendDraftStart)
assert.match(sendDraftSource, /extractImages\(note\.body\)/, '草稿箱发送应读取文章里已有的图片')
assert.match(sendDraftSource, /isExternalFileImageSource/, '草稿箱发送应拒绝 Vault 外的 WPS\/浏览器临时图片')
assert.match(sendDraftSource, /uploadContentImage/, '草稿箱发送应上传已有正文图片')
assert.match(sendDraftSource, /mdToWechatHtml/, '草稿箱发送应自动执行公众号排版')
assert.doesNotMatch(
  sendDraftSource,
  /runArticleIllustration|article-illustration/,
  '草稿箱发送不得再次调用 AI 文章配图',
)

console.log('format regression tests passed')

// 中文编号标题与导入的 HTML 必须真正使用当前主题，不能只让示例卡好看。
const numbered = '一、第一节标题\n\n第一节合成正文。\n\n**二、第二节标题**\n\n第二节合成正文。\n\n（一）一个子标题\n\n子标题正文。'
const imported = '<section style="color:black"><h2 id="chapter" class="MsoHeading2" style="color:black">导入标题</h2><p class="MsoNormal" style="font-size:12px"><span style="color:red"><font color="red">合成正文</font></span><b>强调文字</b></p></section>'
for (const theme of themes.WECHAT_THEMES) {
  const result = publisher.mdToWechatHtml(numbered, () => '', false, theme)
  assert.equal((result.match(/<h2\b/g) ?? []).length, 2, `${theme.id}: 两个中文编号主标题`)
  assert.equal((result.match(/<h3\b/g) ?? []).length, 1, `${theme.id}: 中文括号子标题`)
  assert.ok(result.includes(`color:${theme.accent}`))
  const restored = publisher.mdToWechatHtml(imported, () => '', false, theme)
  assert.match(restored, /<h2 id="chapter" style=/)
  assert.ok(restored.includes(`color:${theme.accent}`))
  assert.doesNotMatch(restored, /Mso|color:black|color:red|font-size:12px|<font|<span/)
  assert.match(restored, /<strong style=/)
  assert.doesNotMatch(restored, /<[^>]*\bstyle="[^">]*"[^>]*\bstyle=/, '不能重复写 style 属性')
}
for (const md of [
  '一、这是一句正文，不是标题。',
  '一、第一项\n二、第二项',
  '> 一、引用里的编号',
  '- 一、列表里的编号',
  '```html\n<p>一、代码示例</p>\n```',
  '<table><tr><td><p>一、表格内容</p></td></tr></table>',
  '一、' + '很长的段落'.repeat(20),
]) {
  assert.doesNotMatch(publisher.mdToWechatHtml(md, () => ''), /<h[23]\b/, '不得把正文/引用/列表/表格/代码升为章节')
}
const keepLinks = publisher.mdToWechatHtml('<p class="x">正文 <a href="https://example.com?q=1" title="literal style=blue > text">链接</a></p>\n<ol start="3"><li value="5">项目</li></ol>', () => '')
assert.match(keepLinks, /href="https:\/\/example.com\?q=1"/)
assert.match(keepLinks, /title="literal style=blue > text"/)
assert.match(keepLinks, /<ol start="3" style=/)
assert.match(keepLinks, /<li value="5" style=/)
const importedParagraph = publisher.mdToWechatHtml('<p id="section" class="MsoNormal">一、导入的小节</p><img src="https://example.com/image.png" style="width:80%;height:auto">', () => '')
assert.match(importedParagraph, /<h2 id="section" style=/)
assert.match(importedParagraph, /style="width:80%;height:auto"/)
assert.match(publishSource, /render: \(theme\) => mdToWechatHtml\(note.body/)
assert.match(pickerSource, /sanitizeHTMLToDom/)
console.log('wechat source compatibility tests passed')


// 真正调用发送函数，拦截微信边界；不能只检查字符串接线或只验证转换器。
class DraftFile { constructor(path) { this.path = path; this.name = path; this.basename = path.replace(/\.md$/, '') } }
for (const theme of themes.WECHAT_THEMES) {
  const source = new DraftFile('synthetic-original.md')
  const other = new DraftFile('synthetic-other.md')
  const cover = new DraftFile('assets/cover.png')
  const body = `![[assets/cover.png]]\n\n${numbered}\n\n${imported}`
  let current = source
  let previewHtml = ''
  let payload
  let savedTarget
  let count = 0
  const harness = {
    TFile: DraftFile,
    pick: async (_plugin, preview) => {
      previewHtml = preview.render(theme)
      current = other // 在选模板时切换当前笔记，来源必须仍锁定原文章。
      return theme
    },
    requestUrl: async (options) => {
      count++
      if (options.url.includes('/token?')) return { json: { access_token: 'synthetic-token' } }
      if (options.url.includes('/material/add_material?')) return { json: { media_id: 'synthetic-cover' } }
      if (options.url.includes('/draft/add?')) {
        payload = JSON.parse(options.body)
        return { json: { media_id: 'synthetic-draft' } }
      }
      throw new Error('unexpected request')
    },
  }
  const publish = await loadTs('src/publish.ts', true, harness)
  const plugin = {
    settings: { wechatAppId: `synthetic-${theme.id}`, brandFooter: false },
    getWechatAppSecret: () => 'synthetic-secret',
    rememberCurrentMarkdownFile: () => current,
    app: {
      vault: { cachedRead: async (file) => { assert.equal(file, source); return body }, readBinary: async () => new ArrayBuffer(8) },
      metadataCache: { getFirstLinkpathDest: () => cover, getFileCache: () => ({ frontmatter: { title: '合成验收文章' } }) },
      fileManager: { processFrontMatter: async (file, update) => { savedTarget = file; const fm = {}; update(fm); assert.equal(fm['公众号草稿ID'], 'synthetic-draft') } },
    },
  }
  await publish.sendToWechatDraft(plugin)
  assert.equal(count, 3, '只发生令牌、封面上传和草稿三个预期请求')
  assert.equal(savedTarget, source, '状态回写原笔记')
  assert.equal(payload.articles[0].content, previewHtml, '无正文图的完整预览必须与发送载荷逐字一致')
  assert.ok(payload.articles[0].content.includes(`color:${theme.accent}`))
  assert.equal((payload.articles[0].content.match(/<h2\b/g) ?? []).length, 3)
  current = source
  harness.pick = async () => null
  await publish.sendToWechatDraft(plugin)
  assert.equal(count, 3, '取消模板选择必须零请求')
}
console.log('wechat draft payload and source-lock tests passed')

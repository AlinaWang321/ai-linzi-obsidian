import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

const result = await build({
  entryPoints: ['src/skill-suggest.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
})
const module = { exports: {} }
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
const suggest = module.exports

const legacy = suggest.extractPluginSkillSuggestions(
  '这张图需要重做。\n\n<<<推荐技能 consulting-visual>>>',
  '配图的「AI霖子」写错了，可以改一下吗？',
)
assert.equal(legacy.cleanText, '这张图需要重做。')
assert.deepEqual(legacy.suggestions, [
  { slug: 'article-illustration', label: '文章配图 · 极简手绘', actionId: 'illustration' },
])

const local = suggest.extractPluginSkillSuggestions(
  '可以直接走文章配图。\n<<<推荐技能 article-illustration>>>',
  '请修改当前文章配图里的错字',
)
assert.equal(local.suggestions.length, 1)
assert.equal(local.suggestions[0].slug, 'article-illustration')

const automatic = suggest.extractPluginSkillSuggestions('我来帮你处理。', '这张封面的标题写错了，帮我修正')
assert.equal(automatic.suggestions[0].slug, 'article-illustration')
const firstImageEdit = '把我第一张图片的标题改成：一键撰写、配图、排版、发布公众号'
assert.equal(suggest.isArticleIllustrationEditIntent(firstImageEdit), true)
assert.equal(suggest.extractPluginSkillSuggestions('可以修改。', firstImageEdit).suggestions[0].slug, 'article-illustration')
assert.deepEqual(suggest.extractExactTextHints(firstImageEdit), ['一键撰写、配图、排版、发布公众号'])
assert.equal(suggest.isArticleIllustrationEditIntent('我想调整商业模式'), false)
const addPartImage = '把 Part 4 也增加一张配图'
assert.equal(suggest.isSingleArticleIllustrationIntent(addPartImage), true)
assert.equal(suggest.isSingleArticleIllustrationIntent('再给这一段加一张图'), true)
assert.deepEqual(
  suggest.extractPluginSkillSuggestions(
    '我会根据当前笔记补一张图。\n<<<推荐技能 article-illustration>>>',
    addPartImage,
  ).suggestions,
  [],
  '单张补图请求应直接进入主对话生图链路，不能再推荐整篇文章配图技能',
)
assert.equal(suggest.isSingleArticleIllustrationIntent('给整篇文章生成配图'), false)
assert.equal(
  suggest.extractPluginSkillSuggestions('可以。', '给整篇文章生成配图').suggestions[0].slug,
  'article-illustration',
)
assert.equal(suggest.isArticleIllustrationIntent('帮我看看咨询简报'), false)
assert.deepEqual(
  suggest.extractExactTextHints('把配图里的「AI霖子」改正确，霖字写错了'),
  ['AI霖子'],
)

const unknown = suggest.extractPluginSkillSuggestions('答复\n<<<推荐技能 made-up-skill>>>', '普通问题')
assert.equal(unknown.cleanText, '答复')
assert.deepEqual(unknown.suggestions, [])

const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
assert.match(styles, /\.ai-linzi-msg-body \*[\s\S]*?user-select: text !important/, '对话文字必须支持鼠标拖选复制')
assert.match(styles, /\.ai-linzi-msg-body[\s\S]*?-webkit-app-region: no-drag/, '消息正文不能被侧边栏拖拽区域吞掉')

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(main, /enableMessageTextSelection\(body\)/, '每条对话消息都必须启用原生文字选择')
assert.match(main, /navigator\.clipboard\.writeText\(selectedText\)/, '选中文字后必须支持右键复制')
assert.match(main, /articleIllustrationEditOffer/, '整篇配图完成后必须在右侧对话保留单图修改入口')
assert.match(main, /修改某一张配图/, '单图修改按钮文案必须直接可理解')
const actionsStart = main.indexOf('export const SKILL_ACTIONS')
const actionsEnd = main.indexOf('// ── 设置', actionsStart)
const actions = main.slice(actionsStart, actionsEnd)
const topicRadarIndex = actions.indexOf("id: 'topic-radar'")
const wechatWriterIndex = actions.indexOf("id: 'wechat-writer'")
const interviewIndex = actions.indexOf("id: 'interview'")
assert.ok(
  topicRadarIndex >= 0 && topicRadarIndex < wechatWriterIndex && wechatWriterIndex < interviewIndex,
  '技能菜单前三项必须依次为选题雷达、公众号写作、公众号原创访谈写作',
)
assert.match(actions, /name: '公众号原创访谈写作:/)

console.log('plugin skill suggestion regression tests passed')

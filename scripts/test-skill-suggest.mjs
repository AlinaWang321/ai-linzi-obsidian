import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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
assert.equal(suggest.isArticleIllustrationEditIntent('我想调整商业模式'), false)
assert.equal(suggest.isArticleIllustrationIntent('帮我看看咨询简报'), false)
assert.deepEqual(
  suggest.extractExactTextHints('把配图里的「AI霖子」改正确，霖字写错了'),
  ['AI霖子'],
)

const unknown = suggest.extractPluginSkillSuggestions('答复\n<<<推荐技能 made-up-skill>>>', '普通问题')
assert.equal(unknown.cleanText, '答复')
assert.deepEqual(unknown.suggestions, [])

console.log('plugin skill suggestion regression tests passed')

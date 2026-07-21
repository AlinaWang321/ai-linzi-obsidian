import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const result = await build({
  entryPoints: ['src/content-state.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
})
const module = { exports: {} }
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
const state = module.exports

assert.equal(state.isInsideOutputFolder('AI霖子输出/公众号文章/测试.md', 'AI霖子输出'), true)
assert.equal(state.isInsideOutputFolder('AI霖子输出2/测试.md', 'AI霖子输出'), false)
assert.equal(state.isInsideOutputFolder('04_Output/公众号文章/测试.md', 'AI霖子输出'), false)
assert.equal(state.isDashboardContentPath('AI霖子输出/公众号文章/2026.07.21_测试.md', 'AI霖子输出'), true)
assert.equal(
  state.isDashboardContentPath('AI霖子输出/公众号文章/配图/测试/AI霖子正文配图_PROMPTS.md', 'AI霖子输出'),
  false,
)

const base = {
  path: 'AI霖子输出/2026.07.21_测试.md',
  basename: '2026.07.21_测试',
  createdAt: new Date('2026-07-21T08:00:00+08:00').getTime(),
  modifiedAt: new Date('2026-07-21T09:00:00+08:00').getTime(),
  hasLocalImages: false,
}

const topic = state.deriveContentRecord({
  ...base,
  frontmatter: { 来源技能: '选题雷达', 状态: '草稿', 日期: '2026-07-21' },
})
assert.equal(topic.kind, '选题')
assert.equal(topic.contentStage, '待写选题')
assert.equal(state.boardLane(topic), 'topic')

const legacyDraft = state.deriveContentRecord({
  ...base,
  path: '04_Output/自媒体内容/公众号文章/草稿箱（待发布）/2026.07.21_测试.md',
  frontmatter: null,
})
assert.equal(legacyDraft.kind, '公众号文章')
assert.equal(legacyDraft.wechatStatus, '已生成草稿')
assert.equal(state.boardLane(legacyDraft), 'write')

const illustrated = { ...legacyDraft, hasLocalImages: true }
assert.equal(state.boardLane(illustrated), 'format')

const sent = state.deriveContentRecord({
  ...base,
  frontmatter: {
    内容类型: '公众号文章',
    内容阶段: '已生成草稿',
    公众号状态: '已发送公众号草稿箱',
    公众号草稿箱时间: '2026/07/21',
  },
})
assert.equal(sent.wechatDraftDate, '2026-07-21')
assert.equal(state.boardLane(sent), 'draftbox')

const published = state.deriveContentRecord({
  ...base,
  path: '公众号文章/已发布/2026.07.21_测试.md',
  frontmatter: { 内容类型: '公众号文章', 发布日期: '2026.07.21' },
})
assert.equal(published.wechatStatus, '已正式发布')
assert.equal(published.wechatPublishedDate, '2026-07-21')
assert.equal(state.boardLane(published), 'published')

assert.deepEqual(
  state.canonicalContentFields({ skill: '公众号写作', platform: '公众号', date: '2026-07-21', contentId: 'c1' }),
  {
    内容ID: 'c1',
    内容类型: '公众号文章',
    内容阶段: '已生成草稿',
    公众号状态: '已生成草稿',
    视频状态: '未开始',
    小红书状态: '未开始',
    创建日期: '2026-07-21',
    草稿日期: '2026-07-21',
  },
)

console.log('content state regression tests passed')

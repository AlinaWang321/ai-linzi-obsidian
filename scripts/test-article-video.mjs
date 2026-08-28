import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-article-video-'))
const outfile = path.join(tempDir, 'article-video-core.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/article-video-core.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const core = await import(pathToFileURL(outfile).href)

for (const value of [
  '用文章转短视频处理当前文章',
  '用 Article to Video 把这篇文章做成一分钟短视频',
  '把文章变成短视频',
  '将当前笔记生成 120 秒视频',
]) assert.equal(core.isBuiltInArticleVideoIntent(value), true, value)

for (const value of [
  '修改 Article to Video skill',
  '文章转短视频为什么总是让我确认？',
  '介绍一下文章转短视频的流程',
  '帮我润色这篇文章',
]) assert.equal(core.isBuiltInArticleVideoIntent(value), false, value)

assert.equal(core.articleVideoDurationFromText('生成一分钟视频'), 60)
assert.equal(core.articleVideoDurationFromText('我要 120 秒'), 120)
assert.equal(core.articleVideoDurationFromText('做个一分半的'), 90)
assert.equal(core.articleVideoDurationFromText('半分钟就好'), 30)
assert.equal(core.ARTICLE_VIDEO_DEFAULT_BRAND.background, '#FFFBEA')
assert.equal(core.ARTICLE_VIDEO_DISPLAY_NAME, '文章转短视频：当前文章➡️极简信息解说视频')

const valid = {
  title: '知识体系卖三次',
  durationTarget: 60,
  scenes: [
    { id: 's1', type: 'hook', headline: '一套知识，为什么只卖一次？', voiceover: '开场旁白。' },
    { id: 's2', type: 'number', headline: '同一体系，可以卖三次', voiceover: '数字旁白。', number: '3', unit: '次' },
    { id: 's3', type: 'comparison', headline: '不是重复卖', voiceover: '对比旁白。', left: { label: '误区', value: '换包装' }, right: { label: '正解', value: '换交付' } },
    { id: 's4', type: 'steps', headline: '三层交付', voiceover: '方法旁白。', items: [{ title: '课程' }, { title: '咨询' }] },
    { id: 's5', type: 'summary', headline: '别只卖知识', voiceover: '收尾旁白。', items: [{ title: '结果' }, { title: '体验' }] },
  ],
}
const storyboard = core.parseArticleVideoStoryboard(JSON.stringify(valid), 60)
assert.ok(storyboard)
assert.equal(storyboard.durationTarget, 60)
assert.equal(storyboard.brand.background, '#FFFBEA')
assert.equal(core.parseArticleVideoStoryboard(JSON.stringify({ ...valid, scenes: valid.scenes.slice(1) }), 60), null)

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const runtime = await readFile(new URL('../src/article-video-runtime.ts', import.meta.url), 'utf8')
assert.match(main, /id: 'article-to-video'/)
assert.match(main, /isBuiltInArticleVideoIntent\(typedText\)/)
assert.match(main, /await this\.plugin\.runArticleToVideo\(typedText\)/)
assert.ok(
  main.indexOf('isBuiltInArticleVideoIntent(typedText)') < main.indexOf('const attachmentSummary = this.attachmentTurnSummary()'),
  '官方视频路由必须在普通对话/本地 Skill 解析前截获',
)
assert.match(main, /import\('\.\/article-video-runtime'\)/)
assert.match(main, /skill\.name\.toLocaleLowerCase\(\) !== 'article-to-video'/)
assert.match(runtime, /detectArticleVideoEnvironment\(\)/)
assert.match(runtime, /confirmModal\.open\(\)/)
assert.match(runtime, /确认并生成 MP4/)
assert.match(runtime, /同意安装环境并继续/)
assert.match(runtime, /OpenJS\.NodeJS\.LTS/)
assert.match(runtime, /Gyan\.FFmpeg/)
assert.match(runtime, /\['install', \.\.\.formulas\]/)
assert.match(runtime, /shell: false/)
assert.doesNotMatch(runtime, /curl[\s\S]{0,80}(?:sh|bash)/)
assert.doesNotMatch(runtime, /confirmLocalSkillAction|propose_skill_action/)
assert.match(runtime, /AI霖子输出[\s\S]{0,120}文章转短视频/)
assert.match(runtime, /storyboard\.json/)
assert.match(runtime, /validation\.json/)
assert.match(runtime, /id="scene-\$\{index \+ 1\}"/)
assert.match(runtime, /id="caption-\$\{index \+ 1\}"/)
assert.match(runtime, /id="narration-audio"/)
assert.match(runtime, /findResumableProject/)
assert.match(runtime, /不会重复调用或消耗配音额度/)

console.log('built-in Article to Video tests passed')

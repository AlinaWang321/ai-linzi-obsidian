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
assert.equal(core.explicitArticleVideoDurationFromText('按照前面的建议重新生成 120 秒'), 120)
assert.equal(core.explicitArticleVideoDurationFromText('镜头再丰富一点'), undefined)
assert.equal(core.articleVideoDurationFromText('做个一分半的'), 90)
assert.equal(core.articleVideoDurationFromText('半分钟就好'), 30)
assert.equal(core.ARTICLE_VIDEO_DEFAULT_BRAND.background, '#FFFBEA')
assert.equal(core.ARTICLE_VIDEO_DISPLAY_NAME, '文章转短视频：当前文章➡️极简信息解说视频')
assert.equal(core.articleVideoPlatform('darwin'), 'macos')
assert.equal(core.articleVideoPlatform('win32'), 'windows')
assert.equal(core.isArticleVideoCancelIntent('取消这个视频'), true)
assert.equal(core.articleVideoPendingTurnAction('第 3 幕再口语一点', 'draft'), 'revise')
assert.equal(core.articleVideoPendingTurnAction('确认', 'draft'), 'confirm')
assert.equal(core.articleVideoPendingTurnAction('安装完成', 'setup-required'), 'confirm')
assert.equal(core.articleVideoPendingTurnAction('配音读音改一下', 'complete'), 'revise')
assert.equal(core.articleVideoPendingTurnAction('取消这个视频', 'failed'), 'cancel')
assert.equal(core.articleVideoPendingTurnAction('第 2 幕重写', 'running'), 'none')
assert.equal(core.ARTICLE_VIDEO_NODE_MIN_MAJOR, 22)
assert.equal(core.ARTICLE_VIDEO_HYPERFRAMES_MIN_VERSION, '0.8.15')
assert.equal(core.ARTICLE_VIDEO_HYPERFRAMES_INSTALL_COMMAND, 'npm install --global hyperframes@latest')
assert.equal(core.isArticleVideoPostProductionRevisionIntent('fish audio 的配音里 AI霖子的霖读错了，字幕仍写霖，读音改成林，镜头再丰富一点'), true)
assert.equal(core.isArticleVideoPostProductionRevisionIntent('帮我查一下今天的客户记录'), false)
assert.equal(core.isArticleVideoPostProductionRevisionIntent('调用文章转短视频技能继续修改上一版'), true)
assert.equal(core.isArticleVideoPostProductionRevisionIntent('这个字读错了，应该读林'), true)
const pronunciationOverrides = core.extractArticleVideoPronunciationOverrides(
  'fish audio的配音里AI霖子的霖读错了，这个字应该读林。字幕上是霖，但读音是林。',
)
assert.deepEqual(pronunciationOverrides[0], { display: 'AI霖子', spoken: 'AI林子' })
assert.equal(core.applyArticleVideoPronunciations('欢迎来到AI霖子的频道', pronunciationOverrides), '欢迎来到AI林子的频道')
const localAiInstallPrompt = core.buildArticleVideoLocalAiInstallPrompt({
  platform: 'windows',
  missing: ['node', 'ffmpeg', 'hyperframes'],
})
assert.match(localAiInstallPrompt, /Node\.js >= 22/)
assert.match(localAiInstallPrompt, /HyperFrames >= 0\.8\.15/)
assert.match(localAiInstallPrompt, /最新稳定版或最新 LTS/)
assert.match(localAiInstallPrompt, /管理员权限.*等待我明确确认/)
assert.match(localAiInstallPrompt, /不要修改 Obsidian Vault/)
assert.match(localAiInstallPrompt, /node --version/)
assert.match(localAiInstallPrompt, /ffprobe -version/)
assert.match(localAiInstallPrompt, /hyperframes --version/)
assert.doesNotMatch(localAiInstallPrompt, /hyperframes@0\.8\.15/)

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
const readable = core.articleVideoStoryboardMarkdown(storyboard)
assert.match(readable, /第 1 幕｜开场钩子/)
assert.match(readable, /屏幕主文案/)
assert.match(readable, /旁白/)
assert.match(readable, /最终时长以确认后的真实配音为准/)

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const runtime = await readFile(new URL('../src/article-video-runtime.ts', import.meta.url), 'utf8')
assert.match(main, /id: 'article-to-video'/)
assert.match(main, /isBuiltInArticleVideoIntent\(typedText\)/)
assert.match(main, /await this\.startArticleVideoWorkflow\(typedText, true\)/)
assert.match(main, /articleVideoReview\?: ArticleVideoReviewState/)
assert.match(main, /脚本确认，生成视频/)
assert.match(main, /安装完成，重新检测并继续/)
assert.match(main, /复制 Homebrew 官方安装命令/)
assert.match(main, /复制 HyperFrames 安装命令/)
assert.match(main, /复制给本机 AI 安装/)
assert.match(main, /WorkBuddy、Codex 或 Claude Code/)
assert.match(main, /buildArticleVideoLocalAiInstallPrompt/)
assert.match(main, /continuesCompletedVideo/)
assert.match(main, /isArticleVideoPostProductionRevisionIntent/)
assert.match(main, /新成片另存且不覆盖当前文件/)
assert.match(main, /字幕“\$\{item\.display\}”→配音“\$\{item\.spoken\}”/)
assert.match(main, /上一次环境检测没有完成；本次将重新检测/)
assert.match(main, /!message\.articleVideoReview/)
assert.match(main, /!message\.articleVideoTurn/)
assert.ok(
  main.indexOf('isBuiltInArticleVideoIntent(typedText)') < main.indexOf('const attachmentSummary = this.attachmentTurnSummary()'),
  '官方视频路由必须在普通对话/本地 Skill 解析前截获',
)
assert.match(main, /import\('\.\/article-video-runtime'\)/)
assert.match(main, /skill\.name\.toLocaleLowerCase\(\) !== 'article-to-video'/)
assert.match(runtime, /detectArticleVideoEnvironment\(\)/)
assert.match(runtime, /requestArticleVideoDraft/)
assert.match(runtime, /prepareArticleVideoDraft/)
assert.match(runtime, /reviseArticleVideoDraft/)
assert.match(runtime, /generateConfirmedArticleVideo/)
assert.match(runtime, /mode: 'revise'/)
assert.match(runtime, /currentStoryboard: review\.storyboard/)
assert.match(runtime, /确认，生成脚本/)
assert.match(runtime, /本机免费配音（默认，无需 API）/)
assert.match(runtime, /Fish Audio（音质更好，需要 API）/)
assert.match(runtime, /localSpeech/)
assert.match(runtime, /\/usr\/bin\/say/)
assert.match(runtime, /Tingting/)
assert.match(runtime, /--file-format=AIFF/)
assert.match(runtime, /tmpdir\(\)/)
assert.match(runtime, /copyFile\(temporaryAudio, output\)/)
assert.match(runtime, /\/usr\/bin\/osascript/)
assert.match(runtime, /NSSpeechSynthesizer/)
assert.match(runtime, /startSpeakingStringToURL/)
assert.match(runtime, /System\.Speech\.Synthesis\.SpeechSynthesizer/)
assert.doesNotMatch(runtime, /class ArticleVideoScriptModal/)
assert.doesNotMatch(runtime, /ai-linzi-article-video-script-modal/)
assert.doesNotMatch(runtime, /setName\('画面标题'\)/)
assert.ok(
  main.indexOf('articleVideoStoryboardMarkdown(review.storyboard)') <
    main.indexOf('脚本确认，生成视频'),
  '必须先在主对话展示完整逐幕脚本，再提供确认生成按钮',
)
assert.match(runtime, /detectHyperframes/)
assert.match(runtime, /versionAtLeast/)
assert.match(runtime, /process\.platform === 'win32' \? `\$\{name\}\.exe` : name/)
assert.match(runtime, /process\.env\.APPDATA && join\(process\.env\.APPDATA, 'npm'\)/)
assert.match(runtime, /hyperframesBinPath/)
assert.match(runtime, /argsPrefix: \[script\]/)
assert.match(runtime, /environment\.hyperframes\.argsPrefix \?\? \[\]/)
assert.match(runtime, /explicitArticleVideoDurationFromText\(change\) \?\? review\.draftTarget/)
assert.match(runtime, /applyArticleVideoPronunciations\(scene\.voiceover, options\.pronunciations\)/)
assert.match(runtime, /配音读音替换由客户端单独处理/)
assert.match(runtime, /outputPath: undefined/)
assert.match(runtime, /环境检测已结束，仍未识别到/)
assert.match(runtime, /本机视频环境检测通过，正在继续生成视频/)
assert.doesNotMatch(runtime, /const executable = process\.platform === 'win32' \? `\$\{name\}\.cmd` : name/)
assert.match(runtime, /ARTICLE_VIDEO_HYPERFRAMES_MIN_VERSION/)
assert.match(runtime, /HyperFrames，请按首次设置卡片完成安装/)
assert.doesNotMatch(runtime, /OpenJS\.NodeJS\.LTS/)
assert.doesNotMatch(runtime, /Gyan\.FFmpeg/)
assert.doesNotMatch(runtime, /\['install', \.\.\.formulas\]/)
assert.doesNotMatch(runtime, /\['--yes', `hyperframes@/)
assert.doesNotMatch(runtime, /installArticleVideoEnvironment/)
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
assert.match(runtime, /不会重复消耗配音额度/)
assert.match(runtime, /voiceConfigHash/)
assert.doesNotMatch(runtime, /<span>ARTICLE TO VIDEO<\/span>/)
assert.doesNotMatch(runtime, /escapeHtml\(storyboard\.brand\.name\)/)
assert.match(runtime, /<footer><span>\$\{escapeHtml\(storyboard\.title\)\}<\/span><\/footer>/)

console.log('built-in Article to Video tests passed')

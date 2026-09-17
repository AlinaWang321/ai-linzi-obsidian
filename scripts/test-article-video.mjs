import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-article-video-'))
const outfile = path.join(tempDir, 'article-video-core.mjs')
const processOutfile = path.join(tempDir, 'article-video-process.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/article-video-core.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const core = await import(pathToFileURL(outfile).href)
await build({
  entryPoints: [fileURLToPath(new URL('../src/article-video-process.ts', import.meta.url))],
  outfile: processOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const processCore = await import(pathToFileURL(processOutfile).href)

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
  '用咨询交付闭环处理当前打开的咨询文档',
  '用 consultation-client-workflow 处理当前打开的咨询文档',
  '调用客户咨询简报处理这份逐字稿',
]) assert.equal(core.isBuiltInArticleVideoIntent(value), false, value)

assert.equal(core.articleVideoDurationFromText('生成一分钟视频'), 60)
assert.equal(core.articleVideoDurationFromText('我要 120 秒'), 120)
assert.equal(core.explicitArticleVideoDurationFromText('按照前面的建议重新生成 120 秒'), 120)
assert.equal(core.explicitArticleVideoDurationFromText('镜头再丰富一点'), undefined)
assert.equal(core.articleVideoDurationFromText('做个一分半的'), 90)
assert.equal(core.articleVideoDurationFromText('半分钟就好'), 30)
assert.deepEqual([...core.ARTICLE_VIDEO_DURATIONS], [30, 60, 90, 120, 150, 180])
// 2026-09-16 真实对话：用户说“增加到 2-3 分钟”时旧版仍停在 60 秒，只有逐字说“2分钟”才变 120。
assert.equal(core.explicitArticleVideoDurationFromText('内容可以更有深度和干货一些，可以举例子，视频长度增加到2-3分钟'), 150)
assert.equal(core.explicitArticleVideoDurationFromText('长度增加2分钟到3分钟，内容更有深度和干货'), 150)
assert.equal(core.explicitArticleVideoDurationFromText('然后把整个短视频的长度变成 2 分钟，内容更有干货和深度一些。'), 120)
assert.equal(core.explicitArticleVideoDurationFromText('做成三分钟的'), 180)
assert.equal(core.explicitArticleVideoDurationFromText('两到三分钟'), 150)
assert.equal(core.explicitArticleVideoDurationFromText('两分半'), 150)
assert.equal(core.explicitArticleVideoDurationFromText('2分30秒'), 150)
assert.equal(core.explicitArticleVideoDurationFromText('1分30秒'), 90)
assert.equal(core.explicitArticleVideoDurationFromText('1.5分钟'), 90)
assert.equal(core.explicitArticleVideoDurationFromText('改成150秒'), 150)
assert.equal(core.explicitArticleVideoDurationFromText('改成180秒'), 180)
assert.equal(core.explicitArticleVideoDurationFromText('五分钟'), 180)
assert.equal(core.explicitArticleVideoDurationFromText('第 3 幕再口语一点'), undefined)
assert.equal(core.explicitArticleVideoDurationFromText('把第2幕和第3幕合并'), undefined)
assert.equal(core.nearestArticleVideoDuration(100), 90)
assert.equal(core.articleVideoNarrationMinChars(120), 575)
assert.equal(core.estimateArticleVideoSeconds(494), 95)
assert.equal(core.ARTICLE_VIDEO_DEFAULT_BRAND.background, '#FFFBEA')
assert.equal(core.ARTICLE_VIDEO_HORIZONTAL_BRAND.background, '#050B16')
assert.equal(core.ARTICLE_VIDEO_HORIZONTAL_BRAND.primary, '#0057FF')
assert.equal(core.ARTICLE_VIDEO_HORIZONTAL_BRAND.accent, '#F39800')
assert.equal(core.ARTICLE_VIDEO_DISPLAY_NAME, '文章转短视频（竖版）')
assert.equal(core.ARTICLE_VIDEO_HORIZONTAL_DISPLAY_NAME, '文章转短视频（横版）')
assert.equal(core.ARTICLE_VIDEO_SOURCE_MAX_CHARS, 60_000)
assert.deepEqual([...core.ARTICLE_VIDEO_SOURCE_EXTENSIONS], ['md', 'txt', 'pdf', 'docx'])
assert.equal(core.isArticleVideoSourceExtension('DOCX'), true)
assert.equal(core.isArticleVideoSourceExtension('pptx'), false)
assert.equal(core.articleVideoDisplayName('vertical'), '文章转短视频（竖版）')
assert.equal(core.articleVideoDisplayName('horizontal'), '文章转短视频（横版）')
assert.equal(core.articleVideoFormatFromText('用文章转短视频（横版）处理当前文章'), 'horizontal')
assert.equal(core.articleVideoFormatFromText('把当前文章做成 16:9 视频'), 'horizontal')
assert.equal(core.articleVideoFormatFromText('用文章转短视频处理当前文章'), 'vertical')
assert.equal(core.articleVideoPlatform('darwin'), 'macos')
assert.equal(core.articleVideoPlatform('win32'), 'windows')
assert.deepEqual(core.articleVideoVerticalNumberLayout('3'), { fontSize: 310, wide: false })
assert.deepEqual(core.articleVideoVerticalNumberLayout('1600万→3200万'), { fontSize: 114, wide: true })
assert.equal(core.articleVideoVerticalNumberLayout('1000万').wide, true)
assert.deepEqual(core.articleVideoHorizontalNumberLayout('3'), { fontSize: 180, wide: false })
assert.deepEqual(core.articleVideoHorizontalNumberLayout('30-50万'), { fontSize: 104, wide: true })
assert.equal(core.articleVideoHorizontalNumberLayout('1000万').wide, true)
const horizontalChapters = core.articleVideoHorizontalChapters([
  { id: 's1', type: 'hook', eyebrow: '现实卡点', headline: '为什么越做越累', voiceover: '旁白' },
  { id: 's2', type: 'number', eyebrow: '体力上限', headline: '时间有上限', voiceover: '旁白' },
  { id: 's3', type: 'flow', eyebrow: '错误扩张', headline: '加人不等于机制', voiceover: '旁白' },
  { id: 's4', type: 'timeline', eyebrow: '身份换挡', headline: '四次身份变化', voiceover: '旁白' },
  { id: 's5', type: 'steps', eyebrow: '岗位机制', headline: '拆出关键岗位', voiceover: '旁白' },
  { id: 's6', type: 'summary', eyebrow: '两条路径', headline: '只剩两条路', voiceover: '旁白' },
  { id: 's7', type: 'quote', eyebrow: '最终选择', headline: '换身份', voiceover: '旁白' },
  { id: 's8', type: 'summary', eyebrow: '行动收束', headline: '现在就行动', voiceover: '旁白' },
])
assert.deepEqual(horizontalChapters, [
  { title: '体力上限', startScene: 0, endScene: 1 },
  { title: '身份换挡', startScene: 2, endScene: 3 },
  { title: '两条路径', startScene: 4, endScene: 5 },
  { title: '行动收束', startScene: 6, endScene: 7 },
])
assert.equal(core.articleVideoHorizontalChapters(horizontalChapters.slice(0, 5).map((chapter, index) => ({
  id: `c${index}`,
  type: 'quote',
  headline: chapter.title,
  voiceover: '旁白',
}))).length, 3)
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

const windowsTextFile = 'C:\\Users\\lenovo\\AppData\\Local\\Temp\\AI 霖子\\voice.txt'
const windowsAudioFile = 'C:\\Users\\lenovo\\AppData\\Local\\Temp\\AI 霖子\\voice.wav'
const windowsSpeech = processCore.windowsSpeechInvocation(windowsTextFile, windowsAudioFile)
assert.equal(windowsSpeech.command, 'powershell.exe')
assert.deepEqual(windowsSpeech.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
assert.equal(windowsSpeech.args.length, 5, 'PowerShell -Command 后不得追加文件路径')
assert.doesNotMatch(windowsSpeech.args.join('\n'), /C:\\Users\\lenovo/u)
assert.equal(windowsSpeech.environment[processCore.WINDOWS_SPEECH_TEXT_ENV], windowsTextFile)
assert.equal(windowsSpeech.environment[processCore.WINDOWS_SPEECH_OUTPUT_ENV], windowsAudioFile)
assert.match(windowsSpeech.args[4], /GetEnvironmentVariable/)
assert.match(windowsSpeech.args[4], /OutputEncoding/)
assert.match(windowsSpeech.args[4], /没有找到可用的中文系统语音/)
assert.match(windowsSpeech.args[4], /finally/)
assert.match(windowsSpeech.args[4], /Dispose/)
assert.doesNotMatch(windowsSpeech.args[4], /\$args/u)
const macAttempts = processCore.macSayAttempts('Tingting', '/tmp/AI 霖子.txt', '/tmp/AI 霖子.aiff')
assert.equal(macAttempts.length, 3)
assert.deepEqual(macAttempts[0], ['-v', 'Tingting', '--file-format=AIFF', '-o', '/tmp/AI 霖子.aiff', '-f', '/tmp/AI 霖子.txt'])
const macFallback = processCore.macSpeechFallbackInvocation('/tmp/AI 霖子.txt', '/tmp/AI 霖子.aiff')
assert.equal(macFallback.command, '/usr/bin/osascript')
assert.deepEqual(macFallback.args.slice(-2), ['/tmp/AI 霖子.txt', '/tmp/AI 霖子.aiff'])
assert.equal(processCore.hasValidLocalSpeechSize(4096), false)
assert.equal(processCore.hasValidLocalSpeechSize(8192), true)
const failureDetail = processCore.articleVideoProcessFailureDetail(
  'Layout\ncontent_overlap #scene-6 .quote-mark',
  '[hyperframes] browserGpuMode probe -> hardware',
  'Command failed',
)
assert.match(failureDetail, /content_overlap #scene-6/)
assert.ok(
  failureDetail.indexOf('browserGpuMode') < failureDetail.indexOf('content_overlap'),
  '真正的布局报告必须保留在 GPU 探测信息之后，避免错误卡片只显示无关 stderr',
)

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
const crossDurationStoryboard = core.parseArticleVideoStoryboard(JSON.stringify({ ...valid, durationTarget: 120 }), 120)
assert.ok(crossDurationStoryboard, '120 秒修改稿保留 5 幕时仍应可渲染')
assert.equal(crossDurationStoryboard.durationTarget, 120)
const missingTypedPayload = {
  ...valid,
  scenes: valid.scenes.map((scene) => scene.id === 's2'
    ? { id: 's2', type: 'number', headline: scene.headline, voiceover: scene.voiceover }
    : scene),
}
const fallbackStoryboard = core.parseArticleVideoStoryboard(JSON.stringify(missingTypedPayload), 120)
assert.ok(fallbackStoryboard, '单幕类型字段缺失时不应丢掉整幕')
assert.equal(fallbackStoryboard.scenes[1]?.type, 'quote')
const readable = core.articleVideoStoryboardMarkdown(storyboard)
assert.match(readable, /第 1 幕｜开场钩子/)
assert.match(readable, /屏幕主文案/)
assert.match(readable, /旁白/)
assert.match(readable, /最终时长以确认后的真实配音为准/)
assert.match(readable, /达不到 60 秒目标（至少需要约 285 字）/, '旁白明显不足时必须在脚本卡上直接提示')
const longEnough = core.parseArticleVideoStoryboard(JSON.stringify({
  ...valid,
  scenes: valid.scenes.map((scene) => ({ ...scene, voiceover: '这是一段足够长的旁白。'.repeat(8) })),
}), 60)
assert.ok(longEnough)
const longEnoughReadable = core.articleVideoStoryboardMarkdown(longEnough)
assert.doesNotMatch(longEnoughReadable, /达不到/)
assert.match(longEnoughReadable, /按真人配音语速预计约 \d+ 秒/)

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const runtime = await readFile(new URL('../src/article-video-runtime.ts', import.meta.url), 'utf8')
const processSource = await readFile(new URL('../src/article-video-process.ts', import.meta.url), 'utf8')
assert.match(main, /id: 'article-to-video'/)
assert.match(main, /id: 'article-to-video-horizontal'/)
assert.match(main, /p\.runArticleToVideo\('vertical'\)/)
assert.match(main, /p\.runArticleToVideo\('horizontal'\)/)
assert.match(main, /isBuiltInArticleVideoIntent\(typedText\)/)
assert.match(main, /await this\.startArticleVideoWorkflow\(typedText, true, format\)/)
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
assert.match(runtime, /class ArticleVideoSourceModal extends FuzzySuggestModal<TFile>/)
assert.match(runtime, /选择一篇文章/)
assert.match(runtime, /输入文件名或 Vault 路径搜索文章/)
assert.match(runtime, /readLocalDocumentText\([\s\S]{0,200}ARTICLE_VIDEO_SOURCE_MAX_CHARS/)
assert.match(runtime, /isArticleVideoSourceExtension\(file\.extension\)/)
assert.doesNotMatch(runtime, /请先打开要制作成视频的 Markdown 文章/)
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
assert.match(processSource, /--file-format=AIFF/)
assert.match(runtime, /tmpdir\(\)/)
assert.match(runtime, /copyFile\(temporaryAudio, output\)/)
assert.match(processSource, /\/usr\/bin\/osascript/)
assert.match(processSource, /NSSpeechSynthesizer/)
assert.match(processSource, /startSpeakingStringToURL/)
assert.match(processSource, /System\.Speech\.Synthesis\.SpeechSynthesizer/)
assert.match(runtime, /windowsSpeechInvocation\(textFile, temporaryAudio\)/)
assert.doesNotMatch(runtime, /'\-Command', command, textFile, temporaryAudio/)
assert.match(runtime, /hasValidLocalSpeechSize/)
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
assert.match(runtime, /assertServerDurationTarget\(rawStoryboard, draft\.draftTarget\)/)
assert.match(runtime, /assertServerDurationTarget\(rawStoryboard, draftTarget\)/)
assert.match(runtime, /当前云端版本还不支持这个时长档位/)
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
assert.match(runtime, /data-width="1280" data-height="720"/)
assert.match(runtime, /data-no-timeline data-start="0" data-width="1280"/)
assert.match(runtime, /articleVideoVerticalNumberLayout\(scene\.number \?\? ''\)/)
assert.match(runtime, /--vertical-number-size:/)
assert.match(runtime, /#scene-\$\{index \+ 1\} \.number/)
assert.match(runtime, /function horizontalSceneBody\(scene: ArticleVideoScene\)/)
assert.match(runtime, /class="flow-stage"/)
assert.match(runtime, /class="semantic-timeline"/)
assert.match(runtime, /class="steps-stage"/)
assert.match(runtime, /class="fork-stage"/)
assert.match(runtime, /class="hook-signal"/)
assert.match(runtime, /\.quote-stage\{margin-top:18px\}\.quote-mark\{font-size:168px;line-height:\.62\}/)
assert.match(runtime, /articleVideoHorizontalNumberLayout\(scene\.number \?\? ''\)/)
assert.match(runtime, /\.number\.number-wide\{align-items:flex-start;flex-direction:column/)
assert.match(runtime, /horizontal-ai-explainer/)
assert.match(runtime, /format: draft\.format/)
assert.match(runtime, /--scene-start:\$\{sceneStart\}s/)
assert.match(runtime, /articleVideoHorizontalChapters\(storyboard\.scenes\)/)
assert.match(runtime, /class="timeline chapter-timeline" aria-label="视频章节进度"/)
assert.match(runtime, /class="chapter-label\$\{state\}"/)
assert.match(runtime, /class="chapter-dividers"/)
assert.match(runtime, /class="capacity-meter"/)
assert.match(runtime, /class="flow-pulse"/)
assert.match(runtime, /class="timeline-cursor"/)
assert.match(runtime, /class="step-spark"/)
assert.match(runtime, /class="fork-pulse"/)
assert.match(runtime, /linear-gradient\(90deg,var\(--blue\),var\(--blue-soft\) 55%,var\(--orange\)\)/)
assert.match(runtime, /animation:cameraDrift var\(--scene-duration\) ease-in-out var\(--scene-start\) both/)
assert.match(runtime, /animation:pulse var\(--scene-duration\) ease-in-out var\(--scene-start\) both/)
assert.doesNotMatch(runtime, /animation:pulse[^;}]*infinite/)
assert.match(runtime, /transform:scaleX\(var\(--progress-start\)\)/)
assert.match(runtime, /to\{transform:scaleX\(var\(--progress-end\)\)\}/)
assert.match(runtime, /\{ kind: 'keepsMoving', maxStaticSec: 1 \}/)
assert.doesNotMatch(runtime, /timeline[\s\S]{0,200}(?:avatar|头像|<img)/i)
assert.match(runtime, /\.horizontal-caption span\{max-width:1040px;padding:0;color:var\(--warm\);font-family:InfoSerif/)
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

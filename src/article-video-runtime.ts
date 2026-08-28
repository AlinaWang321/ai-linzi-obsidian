import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import {
  FileSystemAdapter,
  Modal,
  Notice,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  type App,
} from 'obsidian'
import {
  ARTICLE_VIDEO_DISPLAY_NAME,
  articleVideoPlatform,
  articleVideoDurationFromText,
  parseArticleVideoStoryboard,
  safeArticleVideoName,
  type ArticleVideoDuration,
  type ArticleVideoLaunchOptions,
  type ArticleVideoScene,
  type ArticleVideoReviewState,
  type ArticleVideoSetupState,
  type ArticleVideoStoryboard,
  type ArticleVideoVoiceProvider,
} from './article-video-core'

const HYPERFRAMES_VERSION = '0.8.15'
const PROCESS_OUTPUT_LIMIT = 12 * 1024 * 1024

export interface ArticleVideoPluginHost {
  app: App
  settings: {
    outputFolder: string
    articleVideoFishVoiceId: string
    articleVideoFishModel: 's2.1-pro-free' | 's2.1-pro'
  }
  rememberCurrentMarkdownFile(): TFile | null
  getFishAudioApiKey(): string
  setFishAudioApiKey(value: string): Promise<void>
  saveSettings(): Promise<void>
  apiText(path: string, body: unknown, signal?: AbortSignal): Promise<string>
  reportSkillStatus(text: string, replaceId?: string): string | undefined
}

interface CommandInfo {
  ok: boolean
  command?: string
  version?: string
}

export interface ArticleVideoEnvironmentReport {
  ok: boolean
  node: CommandInfo
  npx: CommandInfo
  ffmpeg: CommandInfo
  ffprobe: CommandInfo
  hyperframes: CommandInfo
  chrome: CommandInfo
  missing: Array<'node' | 'ffmpeg' | 'hyperframes'>
}

interface ArticleVideoRunOptions {
  draftTarget: ArticleVideoDuration
  storyboard: ArticleVideoStoryboard
  voiceProvider: ArticleVideoVoiceProvider
  apiKey?: string
  voiceId?: string
  model: 's2.1-pro-free' | 's2.1-pro'
}

export interface ArticleVideoDraftRequest extends ArticleVideoLaunchOptions {
  sourcePath: string
  sourceName: string
  sourceHash: string
  draftTarget: ArticleVideoDuration
}

export type ArticleVideoGenerationResult =
  | { status: 'setup-required'; setup: ArticleVideoSetupState }
  | { status: 'complete'; outputPath: string }

interface ProcessResult {
  stdout: string
  stderr: string
}

interface WorkflowRecord {
  version: 2
  sourcePath: string
  sourceHash: string
  requestedDuration: ArticleVideoDuration
  voiceProvider: ArticleVideoVoiceProvider
  voiceConfigHash: string
  stage: 'storyboard' | 'narration' | 'build' | 'render' | 'complete' | 'failed'
  updatedAt: string
  output?: string
  error?: string
}

interface NarrationTimeline {
  totalDuration: number
  scenes: Array<{ id: string; start: number; duration: number; end: number }>
}

function commandCandidates(name: 'node' | 'npx' | 'ffmpeg' | 'ffprobe'): string[] {
  const executable = process.platform === 'win32' ? `${name}.cmd` : name
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`)
  }
  if (process.platform === 'win32' && (name === 'node' || name === 'npx')) {
    const root = process.env.ProgramFiles
    if (root) candidates.push(join(root, 'nodejs', name === 'node' ? 'node.exe' : 'npx.cmd'))
  }
  if (process.platform === 'win32' && (name === 'ffmpeg' || name === 'ffprobe')) {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      candidates.push(
        join(localAppData, 'Microsoft', 'WinGet', 'Links', `${name}.exe`),
        join(localAppData, 'Microsoft', 'WindowsApps', `${name}.exe`),
      )
    }
  }
  // 包管理器安装路径优先，避免系统 PATH 里残留的旧 Node.js 抢先命中。
  candidates.push(executable)
  return [...new Set(candidates)]
}

function safeProcessEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
    'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd,
      env: safeProcessEnvironment(extraEnvironment),
      timeout: timeoutMs,
      maxBuffer: PROCESS_OUTPUT_LIMIT,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const processError = error
      if (processError) {
        const detail = `${stderr || stdout || processError.message}`.trim().slice(-2_000)
        const message = processError.killed
          ? `本机步骤超时：${basename(command)}`
          : `${basename(command)} 执行失败${detail ? `：${detail}` : ''}`
        reject(Object.assign(new Error(message), { code: processError.code }))
        return
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function probeCommand(
  name: 'node' | 'npx' | 'ffmpeg' | 'ffprobe',
): Promise<CommandInfo> {
  const args = name === 'ffmpeg' || name === 'ffprobe' ? ['-version'] : ['--version']
  for (const command of commandCandidates(name)) {
    try {
      const result = await runProcess(command, args, process.cwd(), 8_000)
      const version = `${result.stdout || result.stderr}`.trim().split('\n')[0]
      return { ok: true, command, version }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') continue
    }
  }
  return { ok: false }
}

async function cachedHyperframes(): Promise<string | undefined> {
  const root = join(homedir(), '.npm', '_npx')
  try {
    for (const entry of await fs.readdir(root)) {
      const packagePath = join(root, entry, 'node_modules', 'hyperframes', 'package.json')
      const binary = join(
        root,
        entry,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes',
      )
      try {
        const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { version?: string }
        await fs.access(binary)
        if (pkg.version === HYPERFRAMES_VERSION) return binary
      } catch {
        // 继续看下一条 npx 缓存。
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function detectChrome(): Promise<CommandInfo> {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return { ok: true, command: candidate, version: '已找到' }
    } catch {
      // 继续。
    }
  }
  return { ok: false, version: '未在常见位置找到（HyperFrames 可使用自带浏览器）' }
}

async function detectHyperframes(): Promise<CommandInfo> {
  const executable = process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes'
  const candidates = [
    ...(process.platform === 'darwin'
      ? [
          `/opt/homebrew/bin/${executable}`,
          `/usr/local/bin/${executable}`,
          join(homedir(), '.npm-global', 'bin', executable),
        ]
      : []),
    executable,
  ]
  for (const command of [...new Set(candidates)]) {
    try {
      const result = await runProcess(command, ['--version'], process.cwd(), 8_000)
      return { ok: true, command, version: result.stdout.trim().split('\n')[0] || '已安装' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') continue
    }
  }
  const cached = await cachedHyperframes()
  return cached
    ? { ok: true, command: cached, version: `已安装 ${HYPERFRAMES_VERSION}` }
    : { ok: false, version: '未安装' }
}

export async function detectArticleVideoEnvironment(): Promise<ArticleVideoEnvironmentReport> {
  const [node, npx, ffmpeg, ffprobe, hyperframes, chrome] = await Promise.all([
    probeCommand('node'),
    probeCommand('npx'),
    probeCommand('ffmpeg'),
    probeCommand('ffprobe'),
    detectHyperframes(),
    detectChrome(),
  ])
  const major = Number(node.version?.match(/v?(\d+)/u)?.[1] ?? 0)
  node.ok = node.ok && major >= 22
  const missing: Array<'node' | 'ffmpeg' | 'hyperframes'> = []
  if (!node.ok || !npx.ok) missing.push('node')
  if (!ffmpeg.ok || !ffprobe.ok) missing.push('ffmpeg')
  if (!hyperframes.ok) missing.push('hyperframes')
  return {
    ok: node.ok && npx.ok && ffmpeg.ok && ffprobe.ok && hyperframes.ok,
    node,
    npx,
    ffmpeg,
    ffprobe,
    hyperframes,
    chrome,
    missing,
  }
}

function storyboardFingerprint(storyboard: ArticleVideoStoryboard): string {
  return createHash('sha256').update(JSON.stringify(storyboard)).digest('hex')
}

class ArticleVideoSetupModal extends Modal {
  private resolvePromise: (value: ArticleVideoLaunchOptions | null) => void = () => undefined
  private submitted = false
  private readonly options: ArticleVideoLaunchOptions
  private enteredApiKey = ''
  private readonly hasStoredFishKey: boolean
  private storedVoiceId: string
  private fishSettingsEl?: HTMLElement
  readonly result: Promise<ArticleVideoLaunchOptions | null>

  constructor(
    app: App,
    private readonly sourceName: string,
    defaults: ArticleVideoLaunchOptions,
    private readonly plugin: ArticleVideoPluginHost,
  ) {
    super(app)
    this.options = { ...defaults }
    this.hasStoredFishKey = Boolean(plugin.getFishAudioApiKey())
    this.storedVoiceId = plugin.settings.articleVideoFishVoiceId.trim()
    this.result = new Promise((resolvePromise) => { this.resolvePromise = resolvePromise })
  }

  private refreshFishSettings(): void {
    if (this.fishSettingsEl) this.fishSettingsEl.toggle(this.options.voiceProvider === 'fish')
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    this.modalEl.addClass('ai-linzi-article-video-setup-modal')
    contentEl.createEl('h2', { text: ARTICLE_VIDEO_DISPLAY_NAME })
    contentEl.createEl('p', {
      text: `已锁定当前文章《${this.sourceName}》。确认下面 4 项后，完整脚本会直接出现在主对话；这里不编辑第几幕。`,
      cls: 'setting-item-description',
    })

    new Setting(contentEl)
      .setName('短视频名字')
      .setDesc('只用于本机项目文件夹，系统已经按文章标题预填。')
      .addText((input) => {
        input.inputEl.maxLength = 48
        input.setValue(this.options.projectName)
          .onChange((value) => { this.options.projectName = value.trim() })
      })

    new Setting(contentEl)
      .setName('视频标题')
      .setDesc('会显示在成片底部；不加 Article to Video 或 AI霖子水印。')
      .addText((input) => {
        input.inputEl.maxLength = 40
        input.setValue(this.options.videoTitle)
          .onChange((value) => { this.options.videoTitle = value.trim() })
      })

    new Setting(contentEl)
      .setName('视频主题')
      .setDesc('告诉 AI 这条视频最想讲透什么；脚本事实仍只来自当前文章。')
      .addTextArea((input) => {
        input.inputEl.rows = 3
        input.inputEl.maxLength = 160
        input.setValue(this.options.theme)
          .onChange((value) => { this.options.theme = value.trim() })
      })

    new Setting(contentEl)
      .setName('配音方式')
      .setDesc('没有 Fish Audio API 时，直接使用电脑自带的免费配音。')
      .addDropdown((dropdown) => dropdown
        .addOption('local', '本机免费配音（默认，无需 API）')
        .addOption('fish', 'Fish Audio（音质更好，需要 API）')
        .setValue(this.options.voiceProvider)
        .onChange((value) => {
          this.options.voiceProvider = value === 'fish' ? 'fish' : 'local'
          this.refreshFishSettings()
        }))

    this.fishSettingsEl = contentEl.createDiv({ cls: 'ai-linzi-article-video-fish-settings' })
    new Setting(this.fishSettingsEl)
      .setName('Fish Audio API Key')
      .setDesc(this.hasStoredFishKey
        ? '当前设备已有安全配置；留空即可继续使用，输入新值会替换。'
        : '只保存在当前设备 SecretStorage，不进入文章、脚本、日志或 AI 对话。')
      .addText((input) => {
        input.inputEl.type = 'password'
        input.inputEl.autocomplete = 'off'
        input.setPlaceholder(this.hasStoredFishKey ? '已安全配置（无需重复填写）' : '粘贴自己的 Fish Audio API Key')
          .onChange((value) => { this.enteredApiKey = value.trim() })
      })
    new Setting(this.fishSettingsEl)
      .setName('Fish Audio 音色 ID')
      .setDesc('使用自己的声音、公开声音或已获得授权的声音。')
      .addText((input) => input
        .setPlaceholder('Fish Audio voice / reference ID')
        .setValue(this.storedVoiceId)
        .onChange((value) => { this.storedVoiceId = value.trim() }))
    this.refreshFishSettings()

    contentEl.createEl('p', {
      text: '下一步只生成脚本到主对话，不会立即配音、安装环境或渲染视频。脚本确认后才连续完成后续步骤。',
      cls: 'setting-item-description',
    })

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) => {
        button.setCta().setButtonText('确认，生成脚本')
        button.onClick(async () => {
          this.options.projectName = safeArticleVideoName(this.options.projectName)
          this.options.videoTitle = this.options.videoTitle.trim().slice(0, 40)
          this.options.theme = this.options.theme.trim().slice(0, 160)
          if (!this.options.projectName || !this.options.videoTitle || !this.options.theme) {
            new Notice('请确认短视频名字、视频标题和主题。系统已经预填，通常不需要重新写。', 7000)
            return
          }
          if (this.options.voiceProvider === 'fish' && !this.hasStoredFishKey && !this.enteredApiKey) {
            new Notice('选择 Fish Audio 时需要填写自己的 API Key；也可以改选“本机免费配音”。', 7000)
            return
          }
          if (this.options.voiceProvider === 'fish' && !this.storedVoiceId) {
            new Notice('选择 Fish Audio 时还需要填写音色 ID；也可以改选“本机免费配音”。', 7000)
            return
          }
          if (this.enteredApiKey) await this.plugin.setFishAudioApiKey(this.enteredApiKey)
          if (this.options.voiceProvider === 'fish') {
            this.plugin.settings.articleVideoFishVoiceId = this.storedVoiceId
            await this.plugin.saveSettings()
          }
          this.submitted = true
          this.resolvePromise({ ...this.options })
          this.close()
        })
      })
  }

  onClose(): void {
    this.contentEl.empty()
    if (!this.submitted) this.resolvePromise(null)
  }
}

function dateStamp(date = new Date()): string {
  const pad = (value: number) => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

function vaultBasePath(plugin: ArticleVideoPluginHost): string {
  const adapter = plugin.app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error('文章转短视频只支持桌面端本地 Vault。')
  }
  return adapter.getBasePath()
}

function articleVideoOutputRoot(plugin: ArticleVideoPluginHost): string {
  const base = vaultBasePath(plugin)
  const outputFolder = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
    .replace(/^\/+|\/+$/gu, '')
  const root = resolve(base, outputFolder, '文章转短视频')
  const relativeRoot = relative(base, root)
  if (
    !outputFolder ||
    outputFolder.split('/').some((part) => !part || part === '..' || part.startsWith('.')) ||
    !relativeRoot ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativeRoot)
  ) {
    throw new Error('“AI霖子输出文件夹”设置不安全，请改为 Vault 内的普通相对路径。')
  }
  return root
}

async function uniqueProjectPath(plugin: ArticleVideoPluginHost, title: string): Promise<string> {
  const root = articleVideoOutputRoot(plugin)
  await fs.mkdir(root, { recursive: true })
  const stem = `${dateStamp()}_${safeArticleVideoName(title)}`
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = join(root, suffix === 0 ? stem : `${stem}_${String(suffix + 1).padStart(2, '0')}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('今天的同名视频项目过多，请稍后换一个标题再试。')
}

async function writeWorkflow(project: string, record: WorkflowRecord): Promise<void> {
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(join(project, 'workflow.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function projectVaultPath(plugin: ArticleVideoPluginHost, project: string): string {
  return normalizePath(relative(vaultBasePath(plugin), project).replaceAll('\\', '/'))
}

async function findResumableProject(
  plugin: ArticleVideoPluginHost,
  sourcePath: string,
  sourceHash: string,
  requestedDuration: ArticleVideoDuration,
  voiceProvider: ArticleVideoVoiceProvider,
  voiceConfigHash: string,
): Promise<{ project: string; storyboard: ArticleVideoStoryboard; timings: NarrationTimeline } | null> {
  const root = articleVideoOutputRoot(plugin)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
  for (const name of directories) {
    const project = join(root, name)
    try {
      const workflow = JSON.parse(await fs.readFile(join(project, 'workflow.json'), 'utf8')) as WorkflowRecord
      if (
        workflow.version !== 2 ||
        workflow.stage === 'complete' ||
        workflow.sourcePath !== sourcePath ||
        workflow.sourceHash !== sourceHash ||
        workflow.requestedDuration !== requestedDuration ||
        workflow.voiceProvider !== voiceProvider ||
        workflow.voiceConfigHash !== voiceConfigHash
      ) continue
      const storyboard = parseArticleVideoStoryboard(
        await fs.readFile(join(project, 'storyboard.json'), 'utf8'),
        requestedDuration,
      )
      if (!storyboard) continue
      const timings = JSON.parse(await fs.readFile(join(project, 'timings.json'), 'utf8')) as NarrationTimeline
      if (
        !Number.isFinite(timings.totalDuration) ||
        timings.totalDuration <= 0 ||
        !Array.isArray(timings.scenes) ||
        timings.scenes.length !== storyboard.scenes.length ||
        timings.scenes.some((scene) => !Number.isFinite(scene.start) || !Number.isFinite(scene.duration) || scene.duration <= 0)
      ) continue
      await fs.access(join(project, 'audio', 'narration.wav'))
      return { project, storyboard, timings }
    } catch {
      // 这不是可无损续跑的项目，继续检查下一个；绝不猜测或覆盖。
    }
  }
  return null
}

async function fishSpeech(
  text: string,
  output: string,
  options: ArticleVideoRunOptions,
): Promise<void> {
  if (!options.apiKey || !options.voiceId) throw new Error('Fish Audio 配置不完整，请重新选择配音方式。')
  let lastError = 'Fish Audio 请求失败'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await requestUrl({
        url: 'https://api.fish.audio/v1/tts',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          model: options.model,
        },
        body: JSON.stringify({
          text,
          reference_id: options.voiceId,
          format: 'wav',
          normalize: true,
          latency: 'normal',
          prosody: { speed: 1, volume: 0 },
        }),
        throw: false,
      })
      if (response.status >= 200 && response.status < 300) {
        await fs.writeFile(output, Buffer.from(response.arrayBuffer))
        return
      }
      lastError = `Fish Audio 请求失败（HTTP ${response.status}）：${response.text.slice(0, 500)}`
      if (response.status < 500) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1_500))
  }
  throw new Error(lastError)
}

async function macChineseVoice(project: string): Promise<string | undefined> {
  try {
    const result = await runProcess('/usr/bin/say', ['-v', '?'], project, 10_000)
    const voices = result.stdout.split(/\r?\n/gu)
      .map((line) => /^(.+?)\s+(zh_(?:CN|TW|HK))\s+#/u.exec(line.trim()))
      .filter((match): match is RegExpExecArray => Boolean(match))
    // Tingting is the long-standing system Mandarin voice and is more reliable
    // for file export than some of the newer novelty voices listed first.
    const preferred = voices.find((match) => match[1]?.trim() === 'Tingting')
      ?? voices.find((match) => match[2] === 'zh_CN')
      ?? voices[0]
    return preferred?.[1]?.trim()
  } catch {
    return undefined
  }
}

async function localSpeech(
  text: string,
  output: string,
  project: string,
  index: number,
): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}-${index}`
  const textFile = join(tmpdir(), `ai-linzi-local-voice-${nonce}.txt`)
  const temporaryAudio = join(tmpdir(), `ai-linzi-local-voice-${nonce}.${process.platform === 'win32' ? 'wav' : 'aiff'}`)
  await fs.writeFile(textFile, text, 'utf8')
  try {
    if (process.platform === 'darwin') {
      const voice = await macChineseVoice(project)
      const attempts = [
        [...(voice ? ['-v', voice] : []), '--file-format=AIFF', '-o', temporaryAudio, '-f', textFile],
        [...(voice ? ['-v', voice] : []), '-o', temporaryAudio, '-f', textFile],
        ['--file-format=AIFF', '-o', temporaryAudio, '-f', textFile],
      ]
      let lastError: unknown
      for (const args of attempts) {
        try {
          await fs.rm(temporaryAudio, { force: true })
          await runProcess('/usr/bin/say', args, tmpdir(), 120_000)
          const file = await fs.stat(temporaryAudio)
          if (file.size <= 64) throw new Error('系统配音没有写入有效音频')
          await fs.copyFile(temporaryAudio, output)
          return
        } catch (error) {
          lastError = error
        }
      }
      try {
        await fs.rm(temporaryAudio, { force: true })
        await runProcess('/usr/bin/osascript', [
          '-l', 'JavaScript',
          '-e', [
            "ObjC.import('AppKit')",
            'function run(argv) {',
            '  const readError = Ref()',
            '  const source = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, readError)',
            '  const synthesizer = $.NSSpeechSynthesizer.alloc.init',
            '  const target = $.NSURL.fileURLWithPath(argv[1])',
            '  const started = synthesizer.startSpeakingStringToURL(ObjC.unwrap(source), target)',
            "  if (!started) throw new Error('macOS 系统声音启动失败')",
            '  while (synthesizer.isSpeaking) {',
            '    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))',
            '  }',
            '  return true',
            '}',
          ].join('; '),
          textFile,
          temporaryAudio,
        ], tmpdir(), 120_000)
        const file = await fs.stat(temporaryAudio)
        if (file.size <= 64) throw new Error('macOS 系统配音没有写入有效音频')
        await fs.copyFile(temporaryAudio, output)
        return
      } catch (error) {
        lastError = error
      }
      throw lastError instanceof Error ? lastError : new Error('macOS 系统配音失败')
    }
    if (process.platform === 'win32') {
      const command = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1",
        'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
        '$s.SetOutputToWaveFile($args[1])',
        '$s.Speak([IO.File]::ReadAllText($args[0], [Text.Encoding]::UTF8))',
        '$s.Dispose()',
      ].join('; ')
      await runProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command, textFile, temporaryAudio],
        tmpdir(),
        120_000,
      )
      await fs.copyFile(temporaryAudio, output)
      return
    }
    throw new Error('当前系统没有可用的本机免费配音。请改用 macOS、Windows，或在启动弹框选择 Fish Audio。')
  } finally {
    await Promise.allSettled([
      fs.rm(textFile, { force: true }),
      fs.rm(temporaryAudio, { force: true }),
    ])
  }
}

async function audioDuration(ffprobe: string, file: string, cwd: string): Promise<number> {
  const result = await runProcess(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    cwd,
    30_000,
  )
  const value = Number(result.stdout.trim())
  if (!Number.isFinite(value) || value <= 0) throw new Error(`无法测量配音时长：${basename(file)}`)
  return value
}

async function buildNarration(
  project: string,
  storyboard: ArticleVideoStoryboard,
  environment: ArticleVideoEnvironmentReport,
  options: ArticleVideoRunOptions,
  progress: (current: number, total: number) => void,
): Promise<NarrationTimeline> {
  const ffmpeg = environment.ffmpeg.command
  const ffprobe = environment.ffprobe.command
  if (!ffmpeg || !ffprobe) throw new Error('FFmpeg / FFprobe 路径丢失，请重新运行环境检测。')
  const audioDir = join(project, 'audio')
  const rawDir = join(audioDir, '.voice-parts')
  await fs.mkdir(rawDir, { recursive: true })
  const normalizedFiles: string[] = []
  const timings: Array<{ id: string; start: number; duration: number; end: number }> = []
  let cursor = 0
  for (let index = 0; index < storyboard.scenes.length; index += 1) {
    progress(index + 1, storyboard.scenes.length)
    const scene = storyboard.scenes[index]
    const prefix = `${String(index + 1).padStart(2, '0')}-${scene.id}`
    const raw = join(rawDir, `${prefix}.${options.voiceProvider === 'fish' || process.platform === 'win32' ? 'wav' : 'aiff'}`)
    const normalized = join(audioDir, `${prefix}.wav`)
    if (options.voiceProvider === 'fish') {
      await fishSpeech(scene.voiceover, raw, options)
    } else {
      await localSpeech(scene.voiceover, raw, project, index)
    }
    await runProcess(
      ffmpeg,
      ['-nostdin', '-y', '-i', raw, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', normalized],
      project,
      90_000,
    )
    const duration = await audioDuration(ffprobe, normalized, project)
    timings.push({ id: scene.id, start: cursor, duration, end: cursor + duration })
    cursor += duration
    normalizedFiles.push(normalized)
  }
  const concatInputs = normalizedFiles.flatMap((file) => ['-i', file])
  await runProcess(
    ffmpeg,
    [
      '-nostdin', '-y', ...concatInputs,
      '-filter_complex', `concat=n=${normalizedFiles.length}:v=0:a=1[outa]`,
      '-map', '[outa]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le',
      join(audioDir, 'narration.wav'),
    ],
    project,
    180_000,
  )
  const result = { totalDuration: cursor, scenes: timings }
  await fs.writeFile(join(project, 'timings.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

function escapeHtml(value: unknown): string {
  const safeValue = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : ''
  return safeValue
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sceneBody(scene: ArticleVideoScene): string {
  if (scene.type === 'number') {
    return `<div class="number">${escapeHtml(scene.number)}<small>${escapeHtml(scene.unit)}</small></div><h1>${escapeHtml(scene.headline)}</h1><p>${escapeHtml(scene.support)}</p>`
  }
  if (scene.type === 'comparison') {
    return `<h1>${escapeHtml(scene.headline)}</h1><div class="compare"><article><b>${escapeHtml(scene.left?.label)}</b><strong>${escapeHtml(scene.left?.value)}</strong></article><i>VS</i><article class="right"><b>${escapeHtml(scene.right?.label)}</b><strong>${escapeHtml(scene.right?.value)}</strong></article></div>`
  }
  if (scene.type === 'quote') {
    return `<div class="quote-mark">“</div><h1 class="quote">${escapeHtml(scene.headline)}</h1><p>${escapeHtml(scene.support)}</p>`
  }
  if (scene.items && scene.items.length > 0) {
    return `<h1>${escapeHtml(scene.headline)}</h1><p>${escapeHtml(scene.support)}</p><div class="items">${scene.items.map((entry, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(entry.title)}</strong>${entry.detail ? `<small>${escapeHtml(entry.detail)}</small>` : ''}</div></article>`).join('')}</div>`
  }
  return `<div class="accent"></div><h1>${escapeHtml(scene.headline)}</h1><p>${escapeHtml(scene.support)}</p>`
}

function splitCaption(text: string, max = 18): string[] {
  const clauses = `${text}`.split(/(?<=[，。！？；：])/u).filter(Boolean)
  const chunks: string[] = []
  for (const clause of clauses) {
    let rest = clause.trim()
    while (rest.length > max) {
      chunks.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    if (rest) chunks.push(rest)
  }
  return chunks.length > 0 ? chunks : [text]
}

function srtTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1_000))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const secs = Math.floor((total % 60_000) / 1_000)
  const ms = total % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

async function buildProjectHtml(
  project: string,
  storyboard: ArticleVideoStoryboard,
  timings: NarrationTimeline,
): Promise<void> {
  const captions: Array<{ text: string; start: number; end: number }> = []
  storyboard.scenes.forEach((scene, index) => {
    const timing = timings.scenes[index]
    const chunks = splitCaption(scene.voiceover)
    const weights = chunks.map((chunk) => Math.max(3, chunk.replace(/[，。！？；：]/gu, '').length))
    const totalWeight = weights.reduce((sum, value) => sum + value, 0)
    let cursor = timing.start
    chunks.forEach((chunk, part) => {
      const duration = timing.duration * weights[part] / totalWeight
      captions.push({ text: chunk, start: cursor, end: cursor + duration })
      cursor += duration
    })
  })
  const sceneHtml = storyboard.scenes.map((scene, index) => {
    const timing = timings.scenes[index]
    return `<section id="scene-${index + 1}" class="clip scene scene-${scene.type}" data-start="${timing.start.toFixed(3)}" data-duration="${timing.duration.toFixed(3)}" data-track-index="1"><div class="grid"></div><header><b>${String(index + 1).padStart(2, '0')} / ${String(storyboard.scenes.length).padStart(2, '0')}</b></header><main>${sceneBody(scene)}</main><footer><span>${escapeHtml(storyboard.title)}</span></footer></section>`
  }).join('\n')
  const captionHtml = captions.map((caption, index) => `<div id="caption-${index + 1}" class="clip caption" data-start="${caption.start.toFixed(3)}" data-duration="${Math.max(0.2, caption.end - caption.start - 0.02).toFixed(3)}" data-track-index="2"><span>${escapeHtml(caption.text)}</span></div>`).join('\n')
  const brand = storyboard.brand
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=1080,height=1440"><title>${escapeHtml(storyboard.title)}</title><style>
@font-face{font-family:InfoSans;src:local("PingFang SC"),local("Microsoft YaHei"),local("Noto Sans CJK SC")}@font-face{font-family:InfoSerif;src:local("Songti SC"),local("STSong")}
:root{--bg:${brand.background};--ink:${brand.primary};--accent:${brand.accent}}*{box-sizing:border-box;margin:0;padding:0}html,body,#root{width:1080px;height:1440px;overflow:hidden;background:var(--bg);color:var(--ink);font-family:InfoSans,sans-serif}.scene{position:absolute;inset:0;background:radial-gradient(circle at 86% 12%,rgba(242,140,40,.13),transparent 24%),var(--bg);overflow:hidden}.grid{position:absolute;inset:0;opacity:.08;background-image:linear-gradient(var(--ink) 1px,transparent 1px),linear-gradient(90deg,var(--ink) 1px,transparent 1px);background-size:72px 72px;mask-image:linear-gradient(to bottom,black,transparent 72%)}header{position:absolute;z-index:2;top:66px;left:78px;right:78px;padding-bottom:22px;border-bottom:2px solid rgba(23,59,108,.18);display:flex;justify-content:flex-end;font-size:24px;font-weight:850;letter-spacing:2px}main{position:absolute;z-index:2;left:78px;right:78px;top:174px;bottom:250px;display:flex;flex-direction:column;justify-content:center;gap:32px}h1{font-size:84px;line-height:1.18;letter-spacing:-3px;text-wrap:balance}p{font-size:35px;line-height:1.5;font-weight:620;max-width:900px}.accent{width:180px;height:12px;background:var(--accent);transform:skewX(-26deg)}.quote-mark{font-family:InfoSerif,serif;font-size:240px;line-height:.35;color:var(--accent)}h1.quote{font-family:InfoSerif,serif;font-size:78px;line-height:1.34}.number{display:flex;align-items:flex-end;gap:20px;color:var(--accent);font-size:310px;line-height:.8;font-weight:950;letter-spacing:-16px}.number small{font-size:58px;letter-spacing:0;margin-bottom:30px}.compare{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:stretch}.compare article{height:470px;padding:42px 34px;border:3px solid var(--ink);border-radius:26px;display:flex;flex-direction:column;justify-content:center;gap:34px;background:#fffdf5}.compare article.right{background:var(--ink);color:var(--bg);box-shadow:14px 16px 0 var(--accent)}.compare b{font-size:27px;letter-spacing:3px}.compare strong{font-size:48px;line-height:1.36}.compare i{position:absolute;z-index:3;left:50%;top:50%;transform:translate(-50%,-50%);width:88px;height:88px;border:4px solid var(--ink);border-radius:50%;display:grid;place-items:center;background:var(--accent);font-style:normal;font-size:25px;font-weight:950}.items{display:grid;grid-template-columns:1fr 1fr;gap:20px}.items article{min-height:170px;padding:24px;border:2px solid var(--ink);border-radius:18px;background:#fffdf5;display:flex;gap:20px;align-items:center;box-shadow:7px 8px 0 rgba(23,59,108,.12)}.items span{flex:none;width:58px;height:58px;border:2px solid var(--ink);border-radius:12px;display:grid;place-items:center;background:var(--accent);font-weight:900}.items strong{display:block;font-size:34px;line-height:1.22}.items small{display:block;margin-top:8px;font-size:22px;line-height:1.35;opacity:.72}footer{position:absolute;z-index:2;left:78px;right:78px;bottom:54px;display:flex;justify-content:flex-end;text-align:right;font-size:19px;font-weight:700;opacity:.62;white-space:nowrap;overflow:hidden}.caption{position:absolute;z-index:10;left:78px;right:78px;bottom:120px;height:88px;display:flex;align-items:center;justify-content:center;text-align:center}.caption span{max-width:900px;padding:15px 28px;border-radius:14px;background:rgba(23,59,108,.93);color:white;font-size:34px;line-height:1.35;font-weight:800;box-shadow:0 8px 24px rgba(0,0,0,.12)}.scene main>*{animation:rise .7s cubic-bezier(.22,.85,.3,1) both}.scene main>*:nth-child(2){animation-delay:.12s}.scene main>*:nth-child(3){animation-delay:.24s}@keyframes rise{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:translateY(0)}}
</style></head><body><div id="root" data-composition-id="main" data-no-timeline data-width="1080" data-height="1440" data-duration="${timings.totalDuration.toFixed(3)}" data-fps="30">${sceneHtml}${captionHtml}<audio id="narration-audio" src="audio/narration.wav" data-start="0" data-duration="${timings.totalDuration.toFixed(3)}" data-track-index="10" data-volume="1"></audio></div></body></html>`
  await fs.writeFile(join(project, 'index.html'), html, 'utf8')
  await fs.writeFile(
    join(project, 'captions.srt'),
    captions.map((caption, index) => `${index + 1}\n${srtTime(caption.start)} --> ${srtTime(caption.end)}\n${caption.text}\n`).join('\n'),
    'utf8',
  )
  await fs.writeFile(join(project, 'index.motion.json'), `${JSON.stringify({
    duration: Number(timings.totalDuration.toFixed(3)),
    assertions: [
      { kind: 'staysInFrame', selector: '.scene:first-of-type h1' },
      { kind: 'staysInFrame', selector: '.caption:first-of-type' },
    ],
  }, null, 2)}\n`, 'utf8')
}

async function renderProject(
  project: string,
  environment: ArticleVideoEnvironmentReport,
  expectedDuration: number,
): Promise<{ output: string; validation: Record<string, unknown> }> {
  const command = environment.hyperframes.command
  if (!command) throw new Error('没有找到已安装的 HyperFrames，请按首次设置卡片完成安装后重试。')
  const env = { HYPERFRAMES_NO_TELEMETRY: '1' }
  await runProcess(command, ['check', project, '--snapshots'], project, 5 * 60_000, env)
  const output = join(project, 'renders', 'final.mp4')
  await fs.mkdir(dirname(output), { recursive: true })
  await runProcess(
    command,
    ['render', project, '--output', output, '--fps', '30', '--quality', 'standard', '--format', 'mp4'],
    project,
    15 * 60_000,
    env,
  )
  const ffprobe = environment.ffprobe.command
  if (!ffprobe) throw new Error('FFprobe 路径丢失，无法核验成片。')
  const probe = await runProcess(
    ffprobe,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
    project,
    30_000,
  )
  const media = JSON.parse(probe.stdout) as {
    format?: { duration?: string; size?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>
  }
  const video = media.streams?.find((stream) => stream.codec_type === 'video')
  const audio = media.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = Number(media.format?.duration ?? 0)
  const checks = {
    outputExists: true,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    correctDimensions: video?.width === 1080 && video?.height === 1440,
    durationClose: Math.abs(duration - expectedDuration) <= 0.45,
  }
  const validation = {
    ok: Object.values(checks).every(Boolean),
    generatedAt: new Date().toISOString(),
    renderer: `hyperframes@${HYPERFRAMES_VERSION}`,
    output: 'renders/final.mp4',
    expectedDuration,
    media: { duration, sizeBytes: Number(media.format?.size ?? 0), video, audio },
    checks,
    note: '技术核验通过不等于用户已经完成观看验收。',
  }
  await fs.writeFile(join(project, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`, 'utf8')
  if (!validation.ok) throw new Error('MP4 已生成，但尺寸、音轨或时长核验未全部通过。')
  return { output, validation }
}

function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, 'Bearer [已隐藏]')
    .replace(/[A-Za-z0-9_-]{30,}/gu, '[已隐藏]')
    .slice(0, 1_000)
}

async function readLockedSource(
  plugin: ArticleVideoPluginHost,
  locked: Pick<ArticleVideoReviewState, 'sourcePath' | 'sourceName' | 'sourceHash'>,
): Promise<string> {
  const file = plugin.app.vault.getAbstractFileByPath(locked.sourcePath)
  if (!(file instanceof TFile)) {
    throw new Error(`已锁定的文章《${locked.sourceName}》被移动或删除，请重新发起视频任务。`)
  }
  const sourceText = await plugin.app.vault.read(file)
  const sourceHash = createHash('sha256').update(sourceText).digest('hex')
  if (sourceHash !== locked.sourceHash) {
    throw new Error(`已锁定的文章《${locked.sourceName}》在审稿期间发生了变化。为避免脚本与原文错位，请重新发起视频任务。`)
  }
  return sourceText
}

async function readLockedArticle(
  plugin: ArticleVideoPluginHost,
  review: ArticleVideoReviewState,
): Promise<string> {
  return readLockedSource(plugin, review)
}

function articleTitleDefaults(sourceName: string, sourceText: string): { title: string; theme: string } {
  const heading = sourceText.match(/^\s*#\s+(.+)$/mu)?.[1]
  const title = (heading || sourceName)
    .replace(/^\d{4}[._-]\d{1,2}[._-]\d{1,2}[_\s-]*/u, '')
    .replace(/[《》]/gu, '')
    .trim()
    .slice(0, 40) || '我的短视频'
  return {
    title,
    theme: `讲清楚“${title}”最核心的观点与行动建议`.slice(0, 160),
  }
}

export async function requestArticleVideoDraft(
  plugin: ArticleVideoPluginHost,
  requestText = '',
): Promise<ArticleVideoDraftRequest | null> {
  const current = plugin.rememberCurrentMarkdownFile()
  if (!(current instanceof TFile)) {
    throw new Error(`请先打开要制作成视频的 Markdown 文章，再调用“${ARTICLE_VIDEO_DISPLAY_NAME}”。`)
  }
  const sourceText = await plugin.app.vault.read(current)
  if (sourceText.trim().length < 100) throw new Error('当前文章内容太少，至少需要 100 字才能生成短视频。')
  const sourcePath = current.path
  const sourceName = current.basename
  const sourceHash = createHash('sha256').update(sourceText).digest('hex')
  const defaults = articleTitleDefaults(sourceName, sourceText)
  const hasFish = Boolean(plugin.getFishAudioApiKey() && plugin.settings.articleVideoFishVoiceId.trim())
  const launch: ArticleVideoLaunchOptions = {
    projectName: safeArticleVideoName(defaults.title),
    videoTitle: defaults.title,
    theme: defaults.theme,
    voiceProvider: hasFish ? 'fish' : 'local',
  }
  const modal = new ArticleVideoSetupModal(plugin.app, sourceName, launch, plugin)
  modal.open()
  const approved = await modal.result
  if (!approved) return null
  await readLockedSource(plugin, { sourcePath, sourceName, sourceHash })
  return {
    ...approved,
    sourcePath,
    sourceName,
    sourceHash,
    draftTarget: articleVideoDurationFromText(requestText),
  }
}

export async function prepareArticleVideoDraft(
  plugin: ArticleVideoPluginHost,
  draft: ArticleVideoDraftRequest,
): Promise<ArticleVideoReviewState> {
  const sourceText = await readLockedSource(plugin, draft)
  const rawStoryboard = await plugin.apiText('/api/plugin/v1/skills/article-to-video', {
    mode: 'draft',
    text: sourceText,
    sourceTitle: draft.sourceName,
    videoTitle: draft.videoTitle,
    theme: draft.theme,
    duration: draft.draftTarget,
    style: 'minimal-infographic',
  })
  const parsed = parseArticleVideoStoryboard(rawStoryboard, draft.draftTarget) ?? undefined
  const storyboard = parsed ? { ...parsed, title: draft.videoTitle } : undefined
  if (!storyboard) {
    throw new Error('AI 返回的脚本没有通过结构校验，系统已停止；没有创建项目，也没有消耗 Fish Audio 额度。')
  }
  return {
    kind: 'article-video-review',
    sourcePath: draft.sourcePath,
    sourceName: draft.sourceName,
    sourceHash: draft.sourceHash,
    draftTarget: draft.draftTarget,
    projectName: draft.projectName,
    theme: draft.theme,
    voiceProvider: draft.voiceProvider,
    storyboard,
    revision: 0,
    phase: 'draft',
  }
}

export async function reviseArticleVideoDraft(
  plugin: ArticleVideoPluginHost,
  review: ArticleVideoReviewState,
  instruction: string,
): Promise<ArticleVideoReviewState> {
  const change = instruction.trim()
  if (!change || change.length > 1_000) throw new Error('请用 1–1000 字说明要修改哪一幕或哪句话。')
  const sourceText = await readLockedArticle(plugin, review)
  const rawStoryboard = await plugin.apiText('/api/plugin/v1/skills/article-to-video', {
    mode: 'revise',
    text: sourceText,
    sourceTitle: review.sourceName,
    theme: review.theme,
    duration: review.draftTarget,
    style: 'minimal-infographic',
    currentStoryboard: review.storyboard,
    instruction: change,
  })
  const storyboard = parseArticleVideoStoryboard(rawStoryboard, review.draftTarget)
  if (!storyboard) throw new Error('修改后的脚本没有通过结构校验，上一版脚本仍然保留，请换一种说法再试。')
  return {
    ...review,
    storyboard,
    revision: review.revision + 1,
    phase: 'draft',
    setup: undefined,
    error: undefined,
  }
}

export async function generateConfirmedArticleVideo(
  plugin: ArticleVideoPluginHost,
  review: ArticleVideoReviewState,
): Promise<ArticleVideoGenerationResult> {
  await readLockedArticle(plugin, review)
  const apiKey = plugin.getFishAudioApiKey()
  const voiceId = plugin.settings.articleVideoFishVoiceId.trim()
  if (review.voiceProvider === 'fish' && (!apiKey || !voiceId)) {
    return {
      status: 'setup-required',
      setup: {
        kind: 'fish-audio',
        message: '这版脚本选择了 Fish Audio，但当前设备缺少 API Key 或音色 ID。可以补充配置后继续，也可以重新发起并选择本机免费配音。',
      },
    }
  }
  const statusId = plugin.reportSkillStatus('🔎 脚本已确认，正在自动检测本机视频环境…')
  let environment = await detectArticleVideoEnvironment()
  if (!environment.ok) {
    return {
      status: 'setup-required',
      setup: {
        kind: 'environment',
        platform: articleVideoPlatform(process.platform),
        missing: environment.missing.map((item) => item === 'node'
          ? 'Node.js 22+'
          : item === 'ffmpeg'
            ? 'FFmpeg / FFprobe'
            : `HyperFrames ${HYPERFRAMES_VERSION}`),
        message: '正式市场版不会代替用户安装或更新本机依赖。请按下面的官方步骤完成一次安装，再点击“安装完成，重新检测并继续”；文章和脚本不会丢失。',
      },
    }
  }

  const storyboard = review.storyboard
  const model = plugin.settings.articleVideoFishModel
  const voiceConfigHash = createHash('sha256')
    .update(`${review.voiceProvider}|${review.voiceProvider === 'fish' ? `${voiceId}|${model}` : process.platform}`)
    .digest('hex')
  const options: ArticleVideoRunOptions = {
    draftTarget: review.draftTarget,
    storyboard,
    voiceProvider: review.voiceProvider,
    apiKey,
    voiceId,
    model,
  }
  const resumable = await findResumableProject(
    plugin,
    review.sourcePath,
    review.sourceHash,
    review.draftTarget,
    review.voiceProvider,
    voiceConfigHash,
  )
  let project = ''
  const workflowBase: Omit<WorkflowRecord, 'stage' | 'updatedAt'> = {
    version: 2,
    sourcePath: review.sourcePath,
    sourceHash: review.sourceHash,
    requestedDuration: review.draftTarget,
    voiceProvider: review.voiceProvider,
    voiceConfigHash,
  }
  try {
    let timings: NarrationTimeline
    const canReuseNarration = Boolean(
      resumable && storyboardFingerprint(resumable.storyboard) === storyboardFingerprint(storyboard),
    )
    if (canReuseNarration && resumable) {
      project = resumable.project
      timings = resumable.timings
      plugin.reportSkillStatus('♻️ 脚本和配音方式与上次完全一致，正在复用已有配音，不会重复消耗配音额度。', statusId)
      await writeWorkflow(project, {
        ...workflowBase,
        stage: 'narration',
        updatedAt: new Date().toISOString(),
      })
    } else {
      project = await uniqueProjectPath(plugin, review.projectName || storyboard.title || review.sourceName)
      await fs.mkdir(project, { recursive: false })
      await fs.writeFile(join(project, 'storyboard.json'), `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8')
      await writeWorkflow(project, {
        ...workflowBase,
        stage: 'storyboard',
        updatedAt: new Date().toISOString(),
      })
      const voiceLabel = review.voiceProvider === 'fish' ? 'Fish Audio' : '本机免费声音'
      plugin.reportSkillStatus(`🎙️ 1/3 正在用${voiceLabel}生成 ${storyboard.scenes.length} 段配音…`, statusId)
      timings = await buildNarration(
        project,
        storyboard,
        environment,
        options,
        (currentIndex, total) => plugin.reportSkillStatus(
          `🎙️ 1/3 ${voiceLabel}配音 ${currentIndex}/${total}：《${storyboard.scenes[currentIndex - 1]?.headline ?? ''}》`,
          statusId,
        ),
      )
      await writeWorkflow(project, {
        ...workflowBase,
        stage: 'narration',
        updatedAt: new Date().toISOString(),
      })
    }

    plugin.reportSkillStatus('🎨 2/3 正在本机构建无水印的淡黄极简信息图和字幕…', statusId)
    await buildProjectHtml(project, storyboard, timings)
    await writeWorkflow(project, {
      ...workflowBase,
      stage: 'build',
      updatedAt: new Date().toISOString(),
    })
    plugin.reportSkillStatus('🎬 3/3 正在本机渲染 MP4 并核验尺寸、时长和音轨…', statusId)
    await writeWorkflow(project, {
      ...workflowBase,
      stage: 'render',
      updatedAt: new Date().toISOString(),
    })
    const result = await renderProject(project, environment, timings.totalDuration)
    const outputPath = normalizePath(relative(vaultBasePath(plugin), result.output).replaceAll('\\', '/'))
    await writeWorkflow(project, {
      ...workflowBase,
      stage: 'complete',
      updatedAt: new Date().toISOString(),
      output: outputPath,
    })
    plugin.reportSkillStatus(
      `✅ ${ARTICLE_VIDEO_DISPLAY_NAME} 已完成\n\n成片：${outputPath}\n分镜：${normalizePath(`${projectVaultPath(plugin, project)}/storyboard.json`)}\n字幕：${normalizePath(`${projectVaultPath(plugin, project)}/captions.srt`)}\n技术核验：通过（1080×1440、含音轨）。请完整观看后再验收。`,
      statusId,
    )
    new Notice('✅ 视频已生成。', 8000)
    return { status: 'complete', outputPath }
  } catch (error) {
    const message = userFacingError(error)
    if (project) {
      try {
        await writeWorkflow(project, {
          ...workflowBase,
          stage: 'failed',
          updatedAt: new Date().toISOString(),
          error: message,
        })
      } catch {
        // 不用诊断文件写入失败覆盖真正错误。
      }
    }
    plugin.reportSkillStatus(
      `❌ ${ARTICLE_VIDEO_DISPLAY_NAME} 已停止：${message}${project ? `\n\n已保留可检查项目：${projectVaultPath(plugin, project)}` : '\n\n没有创建视频项目。'}\n修复后在原脚本卡片点击继续即可。`,
      statusId,
    )
    throw error
  }
}

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { homedir } from 'os'
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
  ARTICLE_VIDEO_DURATIONS,
  articleVideoDurationFromText,
  parseArticleVideoStoryboard,
  safeArticleVideoName,
  type ArticleVideoDuration,
  type ArticleVideoScene,
  type ArticleVideoStoryboard,
} from './article-video-core'

const HYPERFRAMES_VERSION = '0.8.15'
const PROCESS_OUTPUT_LIMIT = 12 * 1024 * 1024

interface ArticleVideoPluginHost {
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

type ArticleVideoPackageManager = 'homebrew' | 'winget' | 'none'
type ArticleVideoPackage = 'node' | 'ffmpeg'

interface ArticleVideoInstallerInfo {
  manager: ArticleVideoPackageManager
  command?: string
  missing: ArticleVideoPackage[]
  canAutoInstall: boolean
}

export interface ArticleVideoEnvironmentReport {
  ok: boolean
  node: CommandInfo
  npx: CommandInfo
  ffmpeg: CommandInfo
  ffprobe: CommandInfo
  hyperframes: CommandInfo
  chrome: CommandInfo
  installer: ArticleVideoInstallerInfo
}

interface ArticleVideoRunOptions {
  duration: ArticleVideoDuration
  apiKey: string
  voiceId: string
  model: 's2.1-pro-free' | 's2.1-pro'
  installMissing: boolean
}

interface ProcessResult {
  stdout: string
  stderr: string
}

interface WorkflowRecord {
  version: 1
  sourcePath: string
  sourceHash: string
  requestedDuration: ArticleVideoDuration
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

async function detectPackageManager(): Promise<Pick<ArticleVideoInstallerInfo, 'manager' | 'command'>> {
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', 'brew']
    : process.platform === 'win32'
      ? ['winget.exe', 'winget']
      : []
  for (const command of candidates) {
    try {
      await runProcess(command, ['--version'], process.cwd(), 8_000)
      return { manager: process.platform === 'darwin' ? 'homebrew' : 'winget', command }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') continue
    }
  }
  return { manager: 'none' }
}

export async function detectArticleVideoEnvironment(): Promise<ArticleVideoEnvironmentReport> {
  const [node, npx, ffmpeg, ffprobe, cached, chrome, packageManager] = await Promise.all([
    probeCommand('node'),
    probeCommand('npx'),
    probeCommand('ffmpeg'),
    probeCommand('ffprobe'),
    cachedHyperframes(),
    detectChrome(),
    detectPackageManager(),
  ])
  const major = Number(node.version?.match(/v?(\d+)/u)?.[1] ?? 0)
  node.ok = node.ok && major >= 22
  const hyperframes: CommandInfo = cached
    ? { ok: true, command: cached, version: `已缓存 ${HYPERFRAMES_VERSION}` }
    : { ok: true, version: `首次生成时自动下载 ${HYPERFRAMES_VERSION}` }
  const missing: ArticleVideoPackage[] = []
  if (!node.ok || !npx.ok) missing.push('node')
  if (!ffmpeg.ok || !ffprobe.ok) missing.push('ffmpeg')
  const installer: ArticleVideoInstallerInfo = {
    ...packageManager,
    missing,
    canAutoInstall: missing.length > 0 && packageManager.manager !== 'none' && Boolean(packageManager.command),
  }
  return {
    ok: node.ok && npx.ok && ffmpeg.ok && ffprobe.ok,
    node,
    npx,
    ffmpeg,
    ffprobe,
    hyperframes,
    chrome,
    installer,
  }
}

async function installArticleVideoEnvironment(
  environment: ArticleVideoEnvironmentReport,
  progress: (message: string) => void,
): Promise<void> {
  const { installer } = environment
  if (!installer.canAutoInstall || !installer.command || installer.missing.length === 0) {
    throw new Error('本机没有可用的安全自动安装入口，请先按弹窗中的官方说明安装后再重试。')
  }
  if (installer.manager === 'homebrew') {
    const formulas = installer.missing.map((item) => item === 'node' ? 'node' : 'ffmpeg')
    progress(`正在通过 Homebrew 安装：${formulas.join('、')}。请不要关闭 Obsidian。`)
    await runProcess(
      installer.command,
      ['install', ...formulas],
      process.cwd(),
      30 * 60_000,
      { HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_AUTO_UPDATE: '1' },
    )
    return
  }
  const packages = installer.missing.map((item) => item === 'node'
    ? { id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS' }
    : { id: 'Gyan.FFmpeg', label: 'FFmpeg' })
  for (let index = 0; index < packages.length; index += 1) {
    const pkg = packages[index]
    progress(`正在通过 WinGet 安装 ${pkg.label}（${index + 1}/${packages.length}）。Windows 可能弹出一次系统授权。`)
    await runProcess(
      installer.command,
      [
        'install', '--id', pkg.id, '--exact', '--source', 'winget',
        '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity',
      ],
      process.cwd(),
      30 * 60_000,
    )
  }
}

class ArticleVideoConfirmModal extends Modal {
  private resolvePromise: (value: ArticleVideoRunOptions | null) => void = () => undefined
  private submitted = false
  private readonly options: ArticleVideoRunOptions
  readonly result: Promise<ArticleVideoRunOptions | null>

  constructor(
    app: App,
    private readonly sourceName: string,
    duration: ArticleVideoDuration,
    apiKey: string,
    voiceId: string,
    model: 's2.1-pro-free' | 's2.1-pro',
    private readonly environment: ArticleVideoEnvironmentReport,
  ) {
    super(app)
    this.options = { duration, apiKey, voiceId, model, installMissing: false }
    this.result = new Promise((resolvePromise) => { this.resolvePromise = resolvePromise })
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h2', { text: ARTICLE_VIDEO_DISPLAY_NAME })
    contentEl.createEl('p', {
      text: `已锁定当前文章《${this.sourceName}》。确认后会自动完成分镜、Fish Audio 配音、字幕、HTML 动效、MP4 渲染和技术核验，中途不再反复提问。`,
      cls: 'setting-item-description',
    })
    const checks = [
      ['Node.js 22+', this.environment.node],
      ['FFmpeg', this.environment.ffmpeg],
      ['FFprobe', this.environment.ffprobe],
      ['npx', this.environment.npx],
      ['HyperFrames', this.environment.hyperframes],
      ['Chrome（可选）', this.environment.chrome],
    ] as const
    contentEl.createEl('p', {
      text: `环境检测：${checks.map(([label, value]) => `${value.ok ? '✅' : label.includes('可选') ? '⚠️' : '❌'} ${label}`).join(' · ')}`,
      cls: 'setting-item-description',
    })
    if (!this.environment.ok) {
      const missingLabels = this.environment.installer.missing
        .map((item) => item === 'node' ? 'Node.js 22+' : 'FFmpeg / FFprobe')
      contentEl.createEl('p', {
        text: this.environment.installer.canAutoInstall
          ? `AI霖子已检测出缺少：${missingLabels.join('、')}。点击一次“同意安装环境并继续”，系统会安装、复检并接着生成，不会再问第二次。`
          : `AI霖子已检测出缺少：${missingLabels.join('、')}。这台电脑还没有可用的 Homebrew（Mac）或 WinGet（Windows），为避免越权，不能静默安装系统包管理器。请先使用下面的官方入口安装。`,
        cls: 'setting-item-description',
      })
      if (!this.environment.installer.canAutoInstall) {
        new Setting(contentEl)
          .setName('首次安装帮助')
          .setDesc('Mac 建议先安装 Homebrew；Windows 建议先确认 WinGet 可用。Node.js 与 FFmpeg 均只使用官方页面。')
          .addButton((button) => button.setButtonText('Homebrew').onClick(() => {
            window.open('https://docs.brew.sh/Installation', '_blank', 'noopener')
          }))
          .addButton((button) => button.setButtonText('Node.js').onClick(() => {
            window.open('https://nodejs.org/en/download/', '_blank', 'noopener')
          }))
          .addButton((button) => button.setButtonText('FFmpeg').onClick(() => {
            window.open('https://ffmpeg.org/download.html', '_blank', 'noopener')
          }))
      }
    }

    new Setting(contentEl)
      .setName('视频时长')
      .setDesc('默认 60 秒；如果原指令写了 30/90/120 秒，会自动带入。')
      .addDropdown((dropdown) => {
        for (const value of ARTICLE_VIDEO_DURATIONS) dropdown.addOption(`${value}`, `${value} 秒`)
        dropdown.setValue(`${this.options.duration}`).onChange((value) => {
          this.options.duration = Number(value) as ArticleVideoDuration
        })
      })

    new Setting(contentEl)
      .setName('Fish Audio API Key')
      .setDesc('只存当前设备 SecretStorage，不写入文章、项目文件、日志或 AI 对话。')
      .addText((input) => {
        input.inputEl.type = 'password'
        input.inputEl.autocomplete = 'off'
        input.setPlaceholder('粘贴自己的 Fish Audio API Key')
          .setValue(this.options.apiKey)
          .onChange((value) => { this.options.apiKey = value.trim() })
      })

    new Setting(contentEl)
      .setName('Fish Audio 音色 ID')
      .setDesc('使用自己的声音、公开声音或已经获得授权的声音。')
      .addText((input) => input
        .setPlaceholder('Fish Audio voice / reference ID')
        .setValue(this.options.voiceId)
        .onChange((value) => { this.options.voiceId = value.trim() }))

    new Setting(contentEl)
      .setName('Fish Audio 模型')
      .setDesc('课堂默认免费开发模型；稳定生产时可改付费模型。')
      .addDropdown((dropdown) => dropdown
        .addOption('s2.1-pro-free', '免费开发模型（默认）')
        .addOption('s2.1-pro', '付费生产模型')
        .setValue(this.options.model)
        .onChange((value) => {
          this.options.model = value === 's2.1-pro' ? 's2.1-pro' : 's2.1-pro-free'
        }))

    contentEl.createEl('p', {
      text: '输出：AI霖子输出/文章转短视频/新的项目文件夹。不会覆盖已有成片；Fish 配音会联网并使用你的 Fish 额度。首次没有 HyperFrames 缓存时，会在这一次总授权内自动下载。',
      cls: 'setting-item-description',
    })

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) => {
        button.setCta().setButtonText(
          this.environment.ok ? '确认并生成 MP4' : '同意安装环境并继续',
        )
        button.setDisabled(!this.environment.ok && !this.environment.installer.canAutoInstall)
        button.onClick(() => {
          if (!this.options.apiKey || !this.options.voiceId) {
            new Notice('请先填写 Fish Audio API Key 和音色 ID；只需在这个窗口填一次。', 7000)
            return
          }
          this.options.installMissing = !this.environment.ok
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
        workflow.stage === 'complete' ||
        workflow.sourcePath !== sourcePath ||
        workflow.sourceHash !== sourceHash ||
        workflow.requestedDuration !== requestedDuration
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
  const rawDir = join(audioDir, '.fish-parts')
  await fs.mkdir(rawDir, { recursive: true })
  const normalizedFiles: string[] = []
  const timings: Array<{ id: string; start: number; duration: number; end: number }> = []
  let cursor = 0
  for (let index = 0; index < storyboard.scenes.length; index += 1) {
    progress(index + 1, storyboard.scenes.length)
    const scene = storyboard.scenes[index]
    const prefix = `${String(index + 1).padStart(2, '0')}-${scene.id}`
    const raw = join(rawDir, `${prefix}.wav`)
    const normalized = join(audioDir, `${prefix}.wav`)
    await fishSpeech(scene.voiceover, raw, options)
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
    return `<section id="scene-${index + 1}" class="clip scene scene-${scene.type}" data-start="${timing.start.toFixed(3)}" data-duration="${timing.duration.toFixed(3)}" data-track-index="1"><div class="grid"></div><header><span>ARTICLE TO VIDEO</span><b>${String(index + 1).padStart(2, '0')} / ${String(storyboard.scenes.length).padStart(2, '0')}</b></header><main>${sceneBody(scene)}</main><footer><span>${escapeHtml(storyboard.brand.name)}</span><i></i><span>${escapeHtml(storyboard.title)}</span></footer></section>`
  }).join('\n')
  const captionHtml = captions.map((caption, index) => `<div id="caption-${index + 1}" class="clip caption" data-start="${caption.start.toFixed(3)}" data-duration="${Math.max(0.2, caption.end - caption.start - 0.02).toFixed(3)}" data-track-index="2"><span>${escapeHtml(caption.text)}</span></div>`).join('\n')
  const brand = storyboard.brand
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=1080,height=1440"><title>${escapeHtml(storyboard.title)}</title><style>
@font-face{font-family:InfoSans;src:local("PingFang SC"),local("Microsoft YaHei"),local("Noto Sans CJK SC")}@font-face{font-family:InfoSerif;src:local("Songti SC"),local("STSong")}
:root{--bg:${brand.background};--ink:${brand.primary};--accent:${brand.accent}}*{box-sizing:border-box;margin:0;padding:0}html,body,#root{width:1080px;height:1440px;overflow:hidden;background:var(--bg);color:var(--ink);font-family:InfoSans,sans-serif}.scene{position:absolute;inset:0;background:radial-gradient(circle at 86% 12%,rgba(242,140,40,.13),transparent 24%),var(--bg);overflow:hidden}.grid{position:absolute;inset:0;opacity:.08;background-image:linear-gradient(var(--ink) 1px,transparent 1px),linear-gradient(90deg,var(--ink) 1px,transparent 1px);background-size:72px 72px;mask-image:linear-gradient(to bottom,black,transparent 72%)}header{position:absolute;z-index:2;top:66px;left:78px;right:78px;padding-bottom:22px;border-bottom:2px solid rgba(23,59,108,.18);display:flex;justify-content:space-between;font-size:24px;font-weight:850;letter-spacing:2px}header span{padding:9px 16px;border:2px solid var(--ink);border-radius:999px;background:#fffdf2}main{position:absolute;z-index:2;left:78px;right:78px;top:174px;bottom:250px;display:flex;flex-direction:column;justify-content:center;gap:32px}h1{font-size:84px;line-height:1.18;letter-spacing:-3px;text-wrap:balance}p{font-size:35px;line-height:1.5;font-weight:620;max-width:900px}.accent{width:180px;height:12px;background:var(--accent);transform:skewX(-26deg)}.quote-mark{font-family:InfoSerif,serif;font-size:240px;line-height:.35;color:var(--accent)}h1.quote{font-family:InfoSerif,serif;font-size:78px;line-height:1.34}.number{display:flex;align-items:flex-end;gap:20px;color:var(--accent);font-size:310px;line-height:.8;font-weight:950;letter-spacing:-16px}.number small{font-size:58px;letter-spacing:0;margin-bottom:30px}.compare{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:stretch}.compare article{height:470px;padding:42px 34px;border:3px solid var(--ink);border-radius:26px;display:flex;flex-direction:column;justify-content:center;gap:34px;background:#fffdf5}.compare article.right{background:var(--ink);color:var(--bg);box-shadow:14px 16px 0 var(--accent)}.compare b{font-size:27px;letter-spacing:3px}.compare strong{font-size:48px;line-height:1.36}.compare i{position:absolute;z-index:3;left:50%;top:50%;transform:translate(-50%,-50%);width:88px;height:88px;border:4px solid var(--ink);border-radius:50%;display:grid;place-items:center;background:var(--accent);font-style:normal;font-size:25px;font-weight:950}.items{display:grid;grid-template-columns:1fr 1fr;gap:20px}.items article{min-height:170px;padding:24px;border:2px solid var(--ink);border-radius:18px;background:#fffdf5;display:flex;gap:20px;align-items:center;box-shadow:7px 8px 0 rgba(23,59,108,.12)}.items span{flex:none;width:58px;height:58px;border:2px solid var(--ink);border-radius:12px;display:grid;place-items:center;background:var(--accent);font-weight:900}.items strong{display:block;font-size:34px;line-height:1.22}.items small{display:block;margin-top:8px;font-size:22px;line-height:1.35;opacity:.72}footer{position:absolute;z-index:2;left:78px;right:78px;bottom:54px;display:flex;align-items:center;gap:18px;font-size:19px;font-weight:700;opacity:.62;white-space:nowrap;overflow:hidden}footer i{height:2px;background:var(--ink);flex:1}.caption{position:absolute;z-index:10;left:78px;right:78px;bottom:120px;height:88px;display:flex;align-items:center;justify-content:center;text-align:center}.caption span{max-width:900px;padding:15px 28px;border-radius:14px;background:rgba(23,59,108,.93);color:white;font-size:34px;line-height:1.35;font-weight:800;box-shadow:0 8px 24px rgba(0,0,0,.12)}.scene main>*{animation:rise .7s cubic-bezier(.22,.85,.3,1) both}.scene main>*:nth-child(2){animation-delay:.12s}.scene main>*:nth-child(3){animation-delay:.24s}@keyframes rise{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:translateY(0)}}
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
  const cached = await cachedHyperframes()
  const npx = environment.npx.command
  if (!cached && !npx) throw new Error('没有找到 npx，无法首次下载 HyperFrames。')
  const command = cached ?? npx ?? 'npx'
  const prefix = cached ? [] : ['--yes', `hyperframes@${HYPERFRAMES_VERSION}`]
  const env = { HYPERFRAMES_NO_TELEMETRY: '1', npm_config_prefer_offline: 'true' }
  await runProcess(command, [...prefix, 'check', project, '--snapshots'], project, 5 * 60_000, env)
  const output = join(project, 'renders', 'final.mp4')
  await fs.mkdir(dirname(output), { recursive: true })
  await runProcess(
    command,
    [...prefix, 'render', project, '--output', output, '--fps', '30', '--quality', 'standard', '--format', 'mp4'],
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

export async function runArticleToVideo(
  plugin: ArticleVideoPluginHost,
  requestText = '',
): Promise<void> {
  // 用插件已有的“当前笔记”选择器：对话面板获得焦点时，
  // getActiveFile() 不足以证明用户指的是哪篇文章，也绝不能随便取第一个打开标签。
  const current = plugin.rememberCurrentMarkdownFile()
  if (!(current instanceof TFile)) {
    new Notice(`请先打开要制作成视频的 Markdown 文章，再调用“${ARTICLE_VIDEO_DISPLAY_NAME}”。`, 7000)
    return
  }
  const sourceText = await plugin.app.vault.read(current)
  if (sourceText.trim().length < 100) {
    new Notice('当前文章内容太少，至少需要 100 字才能生成短视频。', 7000)
    return
  }
  const sourcePath = current.path
  const sourceName = current.basename
  const requestedDuration = articleVideoDurationFromText(requestText)
  const statusId = plugin.reportSkillStatus(
    `🔒 ${ARTICLE_VIDEO_DISPLAY_NAME} · 已锁定当前文章《${sourceName}》，正在自动检查本机环境…`,
  )
  let environment = await detectArticleVideoEnvironment()
  plugin.reportSkillStatus(
    environment.ok
      ? `✅ ${ARTICLE_VIDEO_DISPLAY_NAME} · 已锁定《${sourceName}》并完成环境检测。请在弹窗中一次确认，之后自动生成到 MP4。`
      : `⚠️ ${ARTICLE_VIDEO_DISPLAY_NAME} · 已自动完成环境检测。弹窗会列出缺失项和可用的一键安装方式，不需要你自己运行检测命令。`,
    statusId,
  )
  const confirmModal = new ArticleVideoConfirmModal(
    plugin.app,
    sourceName,
    requestedDuration,
    plugin.getFishAudioApiKey(),
    plugin.settings.articleVideoFishVoiceId,
    plugin.settings.articleVideoFishModel,
    environment,
  )
  confirmModal.open()
  const options = await confirmModal.result
  if (!options) {
    plugin.reportSkillStatus(`已取消“${ARTICLE_VIDEO_DISPLAY_NAME}”，《${sourceName}》没有生成任何新项目。`, statusId)
    return
  }
  if (options.installMissing) {
    try {
      await installArticleVideoEnvironment(environment, (message) => {
        plugin.reportSkillStatus(`🧰 ${message}`, statusId)
      })
      plugin.reportSkillStatus('🔎 安装完成，正在自动重新检测环境…', statusId)
      environment = await detectArticleVideoEnvironment()
      if (!environment.ok) {
        throw new Error('安装命令已结束，但环境仍未通过复检。请重启 Obsidian 后再次调用；原文章和参数不需要重填。')
      }
      plugin.reportSkillStatus('✅ 本机环境安装并复检通过，正在继续生成视频…', statusId)
    } catch (error) {
      const message = userFacingError(error)
      plugin.reportSkillStatus(
        `❌ ${ARTICLE_VIDEO_DISPLAY_NAME} 已停止：${message}\n\n没有创建视频项目，也没有消耗 Fish Audio 额度。`,
        statusId,
      )
      new Notice(`❌ 环境安装失败：${message}`, 10_000)
      return
    }
  }
  await plugin.setFishAudioApiKey(options.apiKey)
  plugin.settings.articleVideoFishVoiceId = options.voiceId
  plugin.settings.articleVideoFishModel = options.model
  await plugin.saveSettings()

  let project = ''
  const sourceHash = createHash('sha256').update(sourceText).digest('hex')
  const workflowBase: Omit<WorkflowRecord, 'stage' | 'updatedAt'> = {
    version: 1,
    sourcePath,
    sourceHash,
    requestedDuration: options.duration,
  }
  try {
    const resumable = await findResumableProject(
      plugin,
      sourcePath,
      sourceHash,
      options.duration,
    )
    let storyboard: ArticleVideoStoryboard
    let timings: NarrationTimeline
    if (resumable) {
      project = resumable.project
      storyboard = resumable.storyboard
      timings = resumable.timings
      plugin.reportSkillStatus(
        `♻️ 已找到同一文章、同一时长的失败项目，正在复用已有分镜和 Fish Audio 配音；不会重复调用或消耗配音额度。`,
        statusId,
      )
      await writeWorkflow(project, { ...workflowBase, stage: 'narration', updatedAt: new Date().toISOString() })
    } else {
      plugin.reportSkillStatus(`🤖 1/4 正在把《${sourceName}》压缩成 ${options.duration} 秒分镜…`, statusId)
      const rawStoryboard = await plugin.apiText('/api/plugin/v1/skills/article-to-video', {
        text: sourceText,
        sourceTitle: sourceName,
        duration: options.duration,
        style: 'minimal-infographic',
      })
      const parsedStoryboard = parseArticleVideoStoryboard(rawStoryboard, options.duration)
      if (!parsedStoryboard) throw new Error('AI 返回的分镜没有通过结构校验，系统已停止，未消耗 Fish Audio 额度。')
      storyboard = parsedStoryboard
      project = await uniqueProjectPath(plugin, storyboard.title || sourceName)
      await fs.mkdir(project, { recursive: false })
      await fs.writeFile(join(project, 'storyboard.json'), `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8')
      await writeWorkflow(project, { ...workflowBase, stage: 'storyboard', updatedAt: new Date().toISOString() })

      plugin.reportSkillStatus(`🎙️ 2/4 分镜已完成，正在用 Fish Audio 生成 ${storyboard.scenes.length} 段配音…`, statusId)
      timings = await buildNarration(
        project,
        storyboard,
        environment,
        options,
        (currentIndex, total) => plugin.reportSkillStatus(
          `🎙️ 2/4 Fish Audio 配音 ${currentIndex}/${total}：《${storyboard.scenes[currentIndex - 1]?.headline ?? ''}》`,
          statusId,
        ),
      )
      await writeWorkflow(project, { ...workflowBase, stage: 'narration', updatedAt: new Date().toISOString() })
    }

    plugin.reportSkillStatus('🎨 3/4 配音与时间轴已完成，正在本机构建淡黄极简信息图和字幕…', statusId)
    await buildProjectHtml(project, storyboard, timings)
    await writeWorkflow(project, { ...workflowBase, stage: 'build', updatedAt: new Date().toISOString() })

    plugin.reportSkillStatus('🎬 4/4 正在本机渲染 MP4 并核验尺寸、时长和音轨；请保持 Obsidian 打开…', statusId)
    await writeWorkflow(project, { ...workflowBase, stage: 'render', updatedAt: new Date().toISOString() })
    const result = await renderProject(project, environment, timings.totalDuration)
    const outputPath = normalizePath(relative(vaultBasePath(plugin), result.output).replaceAll('\\', '/'))
    await writeWorkflow(project, {
      ...workflowBase,
      stage: 'complete',
      updatedAt: new Date().toISOString(),
      output: outputPath,
    })
    plugin.reportSkillStatus(
      `✅ ${ARTICLE_VIDEO_DISPLAY_NAME} 已自动完成\n\n成片：${outputPath}\n分镜：${normalizePath(`${projectVaultPath(plugin, project)}/storyboard.json`)}\n字幕：${normalizePath(`${projectVaultPath(plugin, project)}/captions.srt`)}\n技术核验：通过（1080×1440、含音轨）。请完整观看后再做视觉验收。`,
      statusId,
    )
    new Notice('✅ 视频已生成，正在用系统播放器打开…', 8000)
    try {
      const opener = plugin.app as unknown as { openWithDefaultApp?: (path: string) => Promise<void> }
      await opener.openWithDefaultApp?.(outputPath)
    } catch {
      // 文件路径已经写在对话区；系统播放器打不开不改变生成结果。
    }
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
        // 不用一个诊断文件写入失败盖住真正错误。
      }
    }
    plugin.reportSkillStatus(
      `❌ ${ARTICLE_VIDEO_DISPLAY_NAME} 已停止：${message}${project ? `\n\n已保留可检查项目：${projectVaultPath(plugin, project)}` : '\n\n没有创建视频项目。'}\n不需要重新说明文章和参数；修复该问题后再次调用即可。`,
      statusId,
    )
    new Notice(`❌ 文章转短视频失败：${message}`, 10_000)
  }
}

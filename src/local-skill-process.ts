import { execFile, type ExecFileException } from 'child_process'
import type { LocalSkillActionProgram } from './local-skill-execution-core'

const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024

interface CommandCandidate {
  command: string
  prefixArgs: string[]
}

export interface LocalSkillProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * Starts a fixed executable with an argument array. There is deliberately no
 * shell string here: separators such as ;, &&, | and $() stay ordinary data.
 */
export async function runLocalSkillProcess(
  program: LocalSkillActionProgram,
  args: string[],
  cwd: string,
  timeout: number,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<LocalSkillProcessResult> {
  for (const candidate of commandCandidates(program)) {
    try {
      return await runCommand(
        candidate.command,
        [...candidate.prefixArgs, ...args],
        cwd,
        timeout,
        extraEnvironment,
      )
    } catch (error) {
      if (!isMissingExecutable(error)) throw error
    }
  }
  throw new Error(
    `${programLabel(program)} 未安装，或 Obsidian 无法在系统 PATH/常见安装位置中找到它。`,
  )
}

export function commandCandidates(program: LocalSkillActionProgram): CommandCandidate[] {
  if (program === 'python') {
    return process.platform === 'win32'
      ? [{ command: 'py', prefixArgs: ['-3'] }, { command: 'python', prefixArgs: [] }]
      : uniqueCandidates([
          { command: 'python3', prefixArgs: [] },
          { command: '/opt/homebrew/bin/python3', prefixArgs: [] },
          { command: '/usr/local/bin/python3', prefixArgs: [] },
          { command: 'python', prefixArgs: [] },
        ])
  }
  if (program === 'ffmpeg') {
    return uniqueCandidates([
      { command: 'ffmpeg', prefixArgs: ['-nostdin'] },
      { command: '/opt/homebrew/bin/ffmpeg', prefixArgs: ['-nostdin'] },
      { command: '/usr/local/bin/ffmpeg', prefixArgs: ['-nostdin'] },
    ])
  }
  if (program === 'ffprobe') {
    return uniqueCandidates([
      { command: 'ffprobe', prefixArgs: [] },
      { command: '/opt/homebrew/bin/ffprobe', prefixArgs: [] },
      { command: '/usr/local/bin/ffprobe', prefixArgs: [] },
    ])
  }
  if (program === 'node') {
    return uniqueCandidates([
      { command: 'node', prefixArgs: [] },
      { command: '/opt/homebrew/bin/node', prefixArgs: [] },
      { command: '/usr/local/bin/node', prefixArgs: [] },
      ...(process.platform === 'win32' && process.env.ProgramFiles
        ? [{ command: `${process.env.ProgramFiles}\\nodejs\\node.exe`, prefixArgs: [] }]
        : []),
    ])
  }
  return [{ command: program, prefixArgs: [] }]
}

function uniqueCandidates(candidates: CommandCandidate[]): CommandCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.command, candidate])).values()]
}

function programLabel(program: LocalSkillActionProgram): string {
  return program === 'python' ? 'Python 3' : program === 'node' ? 'Node.js' : program
}

const SAFE_EXTRA_ENVIRONMENT_KEYS = new Set([
  'ARTICLE_VIDEO_TTS_PROVIDER',
  'ARTICLE_VIDEO_VOICE_SPEED',
  'FISH_API_KEY',
  'FISH_AUDIO_VOICE_ID',
  'FISH_AUDIO_MODEL',
])

function safeEnvironment(extraEnvironment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
    'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PYTHONUTF8',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const [key, value] of Object.entries(extraEnvironment)) {
    if (SAFE_EXTRA_ENVIRONMENT_KEYS.has(key) && value) env[key] = value
  }
  env.PYTHONUTF8 = '1'
  return env
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  extraEnvironment: Readonly<Record<string, string>>,
): Promise<LocalSkillProcessResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: safeEnvironment(extraEnvironment),
        timeout,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (isMissingExecutable(error)) {
          reject(error instanceof Error ? error : new Error('本机没有找到所需程序'))
          return
        }
        const processError: (ExecFileException & { killed?: boolean }) | null = error
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof processError?.code === 'number' ? processError.code : error ? 1 : 0,
          timedOut: Boolean(processError?.killed),
        })
      },
    )
  })
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

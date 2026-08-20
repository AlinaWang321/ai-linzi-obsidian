export const LOCAL_SKILL_ACTION_PROGRAMS = ['node', 'python', 'ffmpeg', 'ffprobe'] as const
export type LocalSkillActionProgram = (typeof LOCAL_SKILL_ACTION_PROGRAMS)[number]

export const LOCAL_SKILL_ACTION_MIN_TIMEOUT_SECONDS = 5
export const LOCAL_SKILL_ACTION_MAX_TIMEOUT_SECONDS = 30 * 60
export const LOCAL_SKILL_ACTION_MAX_ARGS = 48
export const LOCAL_SKILL_ACTION_MAX_TOTAL_ARG_CHARS = 8_000
export const LOCAL_SKILL_ACTION_MAX_OUTPUTS = 20

export interface LocalSkillActionProposal {
  label: string
  program: LocalSkillActionProgram
  args: string[]
  cwd: string
  timeoutSeconds: number
  writes: string[]
  usesNetwork: boolean
  /** Explicit opt-in: a bounded stdout/stderr excerpt may be sent to the model for this run. */
  shareOutputWithAi: boolean
}

export type LocalSkillActionPreparation =
  | { ok: true; action: LocalSkillActionProposal }
  | { ok: false; error: string }

const PROGRAMS = new Set<string>(LOCAL_SKILL_ACTION_PROGRAMS)
const PORTABLE_ROOT_RE = /^\$(SKILL|VAULT|OUTPUT|TEMP)(?:\/(.*))?$/
const URL_OR_PIPE_RE = /(?:https?:|ftp:|sftp:|rtmp:|concat:|pipe:|data:)/i
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function portablePath(value: unknown, allowedRoots: string[]): string | null {
  const raw = text(value, 500).replace(/\\/g, '/')
  const match = PORTABLE_ROOT_RE.exec(raw)
  if (!match || !allowedRoots.includes(match[1])) return null
  const suffix = match[2] ?? ''
  if (!suffix) return `$${match[1]}`
  const parts = suffix.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        // eslint-disable-next-line no-control-regex -- 本机动作参数路径必须拒绝控制字符。
        /[\u0000-\u001f:*?"<>|]/.test(part) ||
        /[. ]$/.test(part) ||
        WINDOWS_RESERVED_RE.test(part),
    )
  ) return null
  return `$${match[1]}/${parts.join('/')}`
}

function cleanArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > LOCAL_SKILL_ACTION_MAX_ARGS) return null
  const args: string[] = []
  let totalChars = 0
  for (const item of value) {
    // eslint-disable-next-line no-control-regex -- 进程参数不能包含 NUL 或换行。
    if (typeof item !== 'string' || item.length > 1_000 || /[\u0000\r\n]/.test(item)) return null
    totalChars += item.length
    if (totalChars > LOCAL_SKILL_ACTION_MAX_TOTAL_ARG_CHARS) return null
    args.push(item)
  }
  return args
}

function looksLikeFileArgument(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value) ||
    /^[.~]/.test(value) ||
    /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(value)
  )
}

function validateProgramArgs(program: LocalSkillActionProgram, args: string[]): string | null {
  if (program === 'node' || program === 'python') {
    if (args.length === 0) return `${program === 'node' ? 'Node' : 'Python'} 动作缺少脚本路径`
    const script = portablePath(args[0], ['SKILL'])
    if (!script) return `${program === 'node' ? 'Node' : 'Python'} 只能运行当前 Skill 内的脚本`
    const extension = script.split('.').at(-1)?.toLocaleLowerCase()
    const allowed = program === 'node'
      ? ['js', 'mjs', 'cjs']
      : ['py']
    if (!extension || !allowed.includes(extension)) return `脚本类型与 ${program} 不匹配`
    const forbiddenFlags = program === 'node'
      ? new Set(['-e', '--eval', '-p', '--print', '-r', '--require'])
      : new Set(['-c', '-m'])
    if (args.some((arg) => forbiddenFlags.has(arg))) return `${program} 动作禁止内联代码或动态加载参数`
    for (const arg of args.slice(1)) {
      if (looksLikeFileArgument(arg) && !portablePath(arg, ['SKILL', 'VAULT', 'OUTPUT', 'TEMP'])) {
        return `${program} 文件参数必须使用 $SKILL/$VAULT/$OUTPUT/$TEMP 路径`
      }
    }
  }
  if (program === 'ffmpeg' || program === 'ffprobe') {
    if (args.length === 0) return `${program} 动作缺少参数`
    if (args.some((arg) => URL_OR_PIPE_RE.test(arg))) return `${program} 动作禁止远程 URL、管道和协议输入`
    if (args.includes('-y')) return 'FFmpeg 动作禁止静默覆盖已有文件，请使用新的输出文件名'
    for (const arg of args) {
      if (looksLikeFileArgument(arg) && !portablePath(arg, ['SKILL', 'VAULT', 'OUTPUT', 'TEMP'])) {
        return `${program} 文件参数必须使用 $SKILL/$VAULT/$OUTPUT/$TEMP 路径`
      }
    }
  }
  return null
}

export function prepareLocalSkillAction(raw: unknown): LocalSkillActionPreparation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '本地动作格式不正确' }
  }
  const record = raw as Record<string, unknown>
  const label = text(record.label, 80)
  const program = text(record.program, 20) as LocalSkillActionProgram
  const args = cleanArgs(record.args)
  const cwd = portablePath(record.cwd ?? '$VAULT', ['SKILL', 'VAULT', 'OUTPUT', 'TEMP'])
  const timeoutRaw = Number(record.timeoutSeconds)
  const timeoutSeconds = Number.isFinite(timeoutRaw)
    ? Math.max(
        LOCAL_SKILL_ACTION_MIN_TIMEOUT_SECONDS,
        Math.min(LOCAL_SKILL_ACTION_MAX_TIMEOUT_SECONDS, Math.trunc(timeoutRaw)),
      )
    : 120
  const rawWrites = record.writes === undefined ? [] : record.writes
  if (!label) return { ok: false, error: '本地动作缺少用户可读的名称' }
  if (!PROGRAMS.has(program)) return { ok: false, error: '本地动作使用了未开放的程序' }
  if (!args) return { ok: false, error: '本地动作参数格式不正确或数量过多' }
  if (!cwd) return { ok: false, error: '本地动作工作目录必须使用安全的可移植路径' }
  if (!Array.isArray(rawWrites) || rawWrites.length > LOCAL_SKILL_ACTION_MAX_OUTPUTS) {
    return { ok: false, error: '本地动作声明的输出文件过多' }
  }
  const writes: string[] = []
  for (const value of rawWrites) {
    const path = portablePath(value, ['VAULT', 'OUTPUT'])
    if (!path || path === '$VAULT' || path === '$OUTPUT') {
      return { ok: false, error: '输出文件必须位于 $VAULT 或 $OUTPUT 的具体路径中' }
    }
    if (!/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path)) {
      return { ok: false, error: '输出必须是带扩展名的具体文件，不能声明文件夹' }
    }
    if (writes.includes(path)) return { ok: false, error: '本地动作包含重复输出文件' }
    writes.push(path)
  }
  const programError = validateProgramArgs(program, args)
  if (programError) return { ok: false, error: programError }
  if (program === 'ffmpeg' && writes.length === 0) {
    return { ok: false, error: 'FFmpeg 动作必须声明预期生成的文件' }
  }
  if (program === 'ffmpeg' && writes.some((path) => !args.includes(path))) {
    return { ok: false, error: 'FFmpeg 的每个声明输出都必须出现在参数中' }
  }
  return {
    ok: true,
    action: {
      label,
      program,
      args,
      cwd,
      timeoutSeconds,
      writes,
      usesNetwork: record.usesNetwork === true,
      shareOutputWithAi: record.shareOutputWithAi === true,
    },
  }
}

export function localSkillActionSummary(action: LocalSkillActionProposal): string {
  const program = action.program === 'python'
    ? 'Python'
    : action.program === 'node'
      ? 'Node.js'
      : action.program
  return `${action.label} · ${program} · 最长 ${action.timeoutSeconds} 秒`
}

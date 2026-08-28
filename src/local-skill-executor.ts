import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'path'
import { App, FileSystemAdapter, TFile, normalizePath } from 'obsidian'
import type { ActiveLocalSkillContext } from './local-skills'
import {
  prepareLocalSkillAction,
  type LocalSkillActionPreparation,
  type LocalSkillActionProgram,
  type LocalSkillActionProposal,
} from './local-skill-execution-core'
import { runLocalSkillProcess } from './local-skill-process'

const { access, mkdir, realpath, stat } = fs

const MAX_RESULT_CHARS = 16_000
const MAX_SHARED_PROCESS_OUTPUT_CHARS = 4_000

export interface LocalSkillRunRecord {
  id: string
  skillName: string
  label: string
  program: LocalSkillActionProgram
  startedAt: number
  durationMs: number
  status: 'success' | 'failed' | 'cancelled' | 'timed_out'
  exitCode: number | null
  declaredOutputs: string[]
  createdOutputs: LocalSkillCreatedOutput[]
  undoneAt?: number
}

export interface LocalSkillCreatedOutput {
  path: string
  size: number
  mtime: number
}

export interface LocalSkillExecutionResult {
  record: LocalSkillRunRecord
  output: string
}

interface ExpandedAction {
  action: LocalSkillActionProposal
  cwd: string
  args: string[]
  declaredOutputs: { absolute: string; vaultPath: string }[]
}

export type LocalSkillEnvironmentProvider = (
  skillName: string,
  proposal: LocalSkillActionProposal,
  context: ActiveLocalSkillContext,
) => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>

export class LocalSkillExecutor {
  constructor(
    private readonly app: App,
    private readonly outputFolder: () => string,
    private readonly environmentForAction: LocalSkillEnvironmentProvider = () => ({}),
  ) {}

  prepare(raw: unknown): LocalSkillActionPreparation {
    return prepareLocalSkillAction(raw)
  }

  /**
   * Return the Skill-relative script path that still needs a complete read.
   *
   * This is intentionally checked before showing the execution confirmation:
   * proposing an action is not an execution attempt, so an unread script must
   * route the model back to read_skill_file without creating a red 0 ms run.
   */
  requiredScriptRead(
    proposal: LocalSkillActionProposal,
    context: ActiveLocalSkillContext,
  ): string | undefined {
    if (proposal.program !== 'node' && proposal.program !== 'python') return undefined
    const portable = proposal.args[0]?.replace(/\\/g, '/') ?? ''
    if (!portable.startsWith('$SKILL/')) return undefined
    const relativeScriptPath = portable.slice('$SKILL/'.length)
    const vaultPath = normalizePath(`${context.directory}/${relativeScriptPath}`)
    return context.fullyReadPaths.includes(vaultPath) ? undefined : relativeScriptPath
  }

  async run(
    skillName: string,
    proposal: LocalSkillActionProposal,
    context: ActiveLocalSkillContext,
  ): Promise<LocalSkillExecutionResult> {
    this.enforceNetworkPolicy(proposal, context)
    const expanded = await this.expand(proposal, context)
    const extraEnvironment = await this.environmentForAction(skillName, proposal, context)
    const startedAt = Date.now()
    const result = await runLocalSkillProcess(
      proposal.program,
      expanded.args,
      expanded.cwd,
      proposal.timeoutSeconds * 1_000,
      extraEnvironment,
    )
    const createdOutputs = await this.createdOutputs(expanded.declaredOutputs)
    const missingDeclaredOutputs = expanded.declaredOutputs
      .filter((expected) => !createdOutputs.some((created) => created.path === expected.vaultPath))
      .map((expected) => expected.vaultPath)
    const status = result.timedOut
      ? 'timed_out'
      : result.exitCode === 0 && missingDeclaredOutputs.length === 0
        ? 'success'
        : 'failed'
    const record: LocalSkillRunRecord = {
      id: `skill-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillName,
      label: proposal.label,
      program: proposal.program,
      startedAt,
      durationMs: Date.now() - startedAt,
      status,
      exitCode: result.exitCode,
      declaredOutputs: expanded.declaredOutputs.map((item) => item.vaultPath),
      createdOutputs,
    }
    return {
      record,
      output: sanitizeResult(
        {
          status,
          exitCode: result.exitCode,
          durationMs: record.durationMs,
          stdout: proposal.shareOutputWithAi
            ? result.stdout.slice(0, MAX_SHARED_PROCESS_OUTPUT_CHARS)
            : undefined,
          stderr: proposal.shareOutputWithAi
            ? result.stderr.slice(0, MAX_SHARED_PROCESS_OUTPUT_CHARS)
            : undefined,
          outputSharedWithAi: proposal.shareOutputWithAi,
          declaredOutputs: record.declaredOutputs,
          createdOutputs: createdOutputs.map((output) => output.path),
          missingDeclaredOutputs,
        },
        this.vaultBasePath(),
        resolve(this.vaultBasePath(), context.directory),
      ),
    }
  }

  private enforceNetworkPolicy(
    proposal: LocalSkillActionProposal,
    context: ActiveLocalSkillContext,
  ): void {
    if (!proposal.usesNetwork) return
    const network = context.runtimePolicy?.network
    if (network === 'none') throw new Error('当前 Skill 的权限清单明确禁止联网，已拒绝执行')
    if (
      network === 'user-configured-tts' &&
      !/^(?:\$SKILL\/)?scripts\/narrate\.mjs$/i.test(proposal.args[0]?.replace(/\\/g, '/') ?? '')
    ) {
      throw new Error('当前 Skill 只允许配音脚本连接用户配置的 TTS 服务')
    }
  }

  cancelledRecord(skillName: string, proposal: LocalSkillActionProposal): LocalSkillRunRecord {
    return {
      id: `skill-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillName,
      label: proposal.label,
      program: proposal.program,
      startedAt: Date.now(),
      durationMs: 0,
      status: 'cancelled',
      exitCode: null,
      declaredOutputs: proposal.writes,
      createdOutputs: [],
    }
  }

  failedRecord(
    skillName: string,
    proposal: LocalSkillActionProposal,
    startedAt = Date.now(),
  ): LocalSkillRunRecord {
    return {
      id: `skill-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillName,
      label: proposal.label,
      program: proposal.program,
      startedAt,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      exitCode: null,
      declaredOutputs: proposal.writes,
      createdOutputs: [],
    }
  }

  safeError(error: unknown, context: ActiveLocalSkillContext): string {
    const message = error instanceof Error ? error.message : String(error)
    const vaultBase = this.vaultBasePath()
    return message
      .replaceAll(resolve(vaultBase, context.directory), '$SKILL')
      .replaceAll(vaultBase, '$VAULT')
      .replaceAll(resolve(tmpdir(), 'ai-linzi'), '$TEMP')
      .slice(0, 1_000)
  }

  async undoCreatedOutputs(record: LocalSkillRunRecord): Promise<void> {
    if (record.undoneAt) throw new Error('这次生成文件已经撤销过了')
    if (record.createdOutputs.length === 0) throw new Error('这次执行没有可撤销的生成文件')
    for (const output of record.createdOutputs) {
      const file = this.app.vault.getAbstractFileByPath(output.path)
      if (!(file instanceof TFile)) throw new Error(`生成文件已经不存在：${output.path}`)
      if (file.stat.size !== output.size || Math.trunc(file.stat.mtime) !== output.mtime) {
        throw new Error(`生成后文件已被修改，为避免误删已停止撤销：${output.path}`)
      }
    }
    for (const output of record.createdOutputs) {
      const file = this.app.vault.getAbstractFileByPath(output.path)
      if (!(file instanceof TFile)) throw new Error(`生成文件已经不存在：${output.path}`)
      await this.app.fileManager.trashFile(file)
    }
    record.undoneAt = Date.now()
  }

  private async expand(
    action: LocalSkillActionProposal,
    context: ActiveLocalSkillContext,
  ): Promise<ExpandedAction> {
    const vaultBase = this.vaultBasePath()
    const roots = {
      SKILL: resolve(vaultBase, context.directory),
      VAULT: vaultBase,
      OUTPUT: resolve(vaultBase, this.outputFolder()),
      TEMP: resolve(tmpdir(), 'ai-linzi'),
    }
    if (!isWithin(roots.OUTPUT, vaultBase)) throw new Error('插件输出目录不能离开当前 Vault')
    await mkdir(roots.TEMP, { recursive: true })
    await ensureRealBoundary(roots.SKILL, roots.VAULT)
    const expand = (value: string): string => expandPortableValue(value, roots)
    const cwd = expand(action.cwd)
    await ensureDirectory(cwd)
    await ensureRealBoundary(cwd, realBoundaryRoot(action.cwd, roots))
    const args = action.args.map(expand)
    for (let index = 0; index < action.args.length; index++) {
      const boundary = realBoundaryRoot(action.args[index], roots)
      if (boundary) await ensureRealBoundary(args[index], boundary)
    }
    if (action.program === 'node' || action.program === 'python') {
      const scriptPath = args[0]
      const scriptVaultPath = normalizePath(relative(vaultBase, scriptPath).split(sep).join('/'))
      const authorized = isWithin(scriptPath, roots.SKILL) || context.linkedPaths.some(
        (path) => resolve(vaultBase, path) === normalize(scriptPath),
      )
      if (!authorized) throw new Error('脚本不在当前 Skill 的授权范围内')
      if (!context.fullyReadPaths.includes(scriptVaultPath)) {
        throw new Error('AI 尚未完整读取这个脚本，已拒绝执行')
      }
      await access(scriptPath)
    }
    const declaredOutputs: { absolute: string; vaultPath: string }[] = []
    for (const portable of action.writes) {
      const absolute = expand(portable)
      if (!isWithin(absolute, vaultBase)) throw new Error('声明输出必须位于当前 Vault 内')
      try {
        await stat(absolute)
        throw new Error(`输出文件已经存在，拒绝覆盖：${portable}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      declaredOutputs.push({
        absolute,
        vaultPath: normalizePath(relative(vaultBase, absolute).split(sep).join('/')),
      })
      await ensureRealBoundary(absolute, vaultBase)
    }
    const declaredAbsolute = new Set(declaredOutputs.map((output) => normalize(output.absolute)))
    for (let index = 0; index < action.args.length; index++) {
      if (!/^\$(?:VAULT|OUTPUT)(?:[\\/]|$)/.test(action.args[index])) continue
      const absolute = normalize(args[index])
      try {
        await stat(absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const containsDeclaredOutput = declaredOutputs.some(
          (output) => normalize(output.absolute) !== absolute && isWithin(output.absolute, absolute),
        )
        if (!declaredAbsolute.has(absolute) && !containsDeclaredOutput) {
          throw new Error(`尚不存在的 Vault 文件必须声明为预计生成：${action.args[index]}`)
        }
      }
    }
    return { action, cwd, args, declaredOutputs }
  }

  private async createdOutputs(
    outputs: { absolute: string; vaultPath: string }[],
  ): Promise<LocalSkillCreatedOutput[]> {
    const created: LocalSkillCreatedOutput[] = []
    for (const output of outputs) {
      try {
        const info = await stat(output.absolute)
        if (info.isFile()) {
          created.push({
            path: output.vaultPath,
            size: info.size,
            mtime: Math.trunc(info.mtimeMs),
          })
        }
      } catch {
        // Missing declared output is reported to the model through createdOutputs.
      }
    }
    return created
  }

  private vaultBasePath(): string {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('“我的 Skills”程序执行只支持桌面版 Obsidian Vault')
    }
    return normalize(adapter.getBasePath())
  }
}

function expandPortableValue(
  value: string,
  roots: Record<'SKILL' | 'VAULT' | 'OUTPUT' | 'TEMP', string>,
): string {
  const match = /^\$(SKILL|VAULT|OUTPUT|TEMP)(?:[\\/](.*))?$/.exec(value)
  if (!match) return value
  const root = roots[match[1] as keyof typeof roots]
  const suffix = match[2] ?? ''
  const expanded = suffix ? resolve(root, ...suffix.split(/[\\/]/)) : root
  if (!isWithin(expanded, root)) throw new Error(`路径离开了允许范围：${value}`)
  return expanded
}

function isWithin(path: string, root: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(root)) return false
  const result = relative(normalize(root), normalize(path))
  return result === '' || (!result.startsWith('..') && !isAbsolute(result))
}

function realBoundaryRoot(
  portable: string,
  roots: Record<'SKILL' | 'VAULT' | 'OUTPUT' | 'TEMP', string>,
): string | null {
  const match = /^\$(SKILL|VAULT|OUTPUT|TEMP)(?:[\\/]|$)/.exec(portable)
  if (!match) return null
  const name = match[1] as keyof typeof roots
  // OUTPUT is a Vault subfolder and may not exist yet; its real boundary is the Vault itself.
  return name === 'OUTPUT' ? roots.VAULT : roots[name]
}

async function ensureRealBoundary(path: string, root: string | null): Promise<void> {
  if (!root) return
  const realRoot = await realpath(root)
  let ancestor = path
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor)
      if (!isWithin(realAncestor, realRoot)) {
        throw new Error('路径通过符号链接离开了允许范围，已拒绝执行')
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('无法确认本地动作的真实路径范围')
      ancestor = parent
    }
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹：${path}`)
}

function sanitizeResult(
  value: Record<string, unknown>,
  vaultBase: string,
  skillBase: string,
): string {
  const replacement = JSON.stringify(value)
    .replaceAll(skillBase, '$SKILL')
    .replaceAll(vaultBase, '$VAULT')
    .replaceAll(resolve(tmpdir(), 'ai-linzi'), '$TEMP')
  if (replacement.length <= MAX_RESULT_CHARS) return replacement
  return `${replacement.slice(0, MAX_RESULT_CHARS)}…(本机输出已截断)`
}

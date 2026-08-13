import { App, TFile, parseYaml } from 'obsidian'
import {
  LOCAL_SKILL_MAX_CONTENT_CHARS,
  LOCAL_SKILL_MAX_ENTRY_CHARS,
  buildLocalSkillDescriptor,
  isLocalSkillPath,
  localSkillLinkedPathCandidates,
  matchLocalSkillInvocation,
  normalizeLocalSkillRoot,
  type LocalSkillDescriptor,
  type LocalSkillMatch,
  type LocalSkillOutput,
} from './local-skill-core'

interface CachedLocalSkill {
  mtime: number
  size: number
  descriptor: LocalSkillDescriptor
  content: string
}

export interface ResolvedLocalSkill {
  name: string
  description: string
  output: LocalSkillOutput
  content: string
  entryChars: number
  entryTruncated: boolean
  /** Only used locally to authorize files explicitly linked by this Skill. */
  fullContent: string
  /** 仅用于本地检索去重，绝不发送到服务端。 */
  path: string
}

export interface ActiveLocalSkillContext {
  root: string
  directory: string
  entryPath: string
  linkedPaths: string[]
  /** Mutable, process-only authorization: scripts must be completely read before execution. */
  fullyReadPaths: string[]
  /** Continuous read coverage from character zero; skipped ranges never authorize execution. */
  readThroughByPath: Record<string, number>
}

export type ResolvedLocalSkillMatch =
  | Exclude<LocalSkillMatch, { kind: 'matched' }>
  | { kind: 'matched'; skill: ResolvedLocalSkill }

function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
  if (!match) return {}
  try {
    const parsed = parseYaml(match[1])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 本地 Skill 注册表只存在当前 Obsidian 进程内：
 * - 不写 data.json；
 * - 不上传目录清单；
 * - 只在用户明确调用后发送被命中的单个 Skill 正文。
 */
export class LocalSkillRegistry {
  private cache = new Map<string, CachedLocalSkill>()

  constructor(
    private readonly app: App,
    private readonly configuredRoot: () => string = () => 'system/skills',
  ) {}

  root(): string {
    return normalizeLocalSkillRoot(this.configuredRoot())
  }

  context(skill: ResolvedLocalSkill): ActiveLocalSkillContext {
    const entryPath = skill.path.replace(/\\/g, '/')
    const directory = entryPath.split('/').slice(0, -1).join('/')
    return {
      root: this.root(),
      directory,
      entryPath,
      linkedPaths: extractLinkedVaultPaths(
        skill.fullContent,
        directory,
        this.root(),
        this.app,
      ),
      fullyReadPaths: skill.entryTruncated ? [] : [entryPath],
      readThroughByPath: {
        [entryPath]: skill.entryTruncated ? skill.content.length : skill.fullContent.length,
      },
    }
  }

  private async refresh(): Promise<CachedLocalSkill[]> {
    const root = this.root()
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => isLocalSkillPath(file.path, root))
    const livePaths = new Set(files.map((file) => file.path))
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) this.cache.delete(path)
    }

    const records: CachedLocalSkill[] = []
    for (const file of files) {
      const cached = this.cache.get(file.path)
      if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
        records.push(cached)
        continue
      }
      const content = await this.app.vault.cachedRead(file)
      const descriptor = buildLocalSkillDescriptor(file.path, parseFrontmatter(content), content, root)
      if (!descriptor) continue
      const next = {
        mtime: file.stat.mtime,
        size: file.stat.size,
        descriptor,
        content,
      }
      this.cache.set(file.path, next)
      records.push(next)
    }
    return records.sort((left, right) =>
      left.descriptor.name.localeCompare(right.descriptor.name, 'zh-CN'),
    )
  }

  async list(): Promise<LocalSkillDescriptor[]> {
    return (await this.refresh()).map((record) => record.descriptor)
  }

  async resolve(message: string): Promise<ResolvedLocalSkillMatch> {
    const records = await this.refresh()
    const match = matchLocalSkillInvocation(
      message,
      records.map((record) => record.descriptor),
    )
    if (match.kind !== 'matched') return match
    const record = records.find((item) => item.descriptor.path === match.skill.path)
    if (!record) return { kind: 'missing' }
    if (record.content.length > LOCAL_SKILL_MAX_ENTRY_CHARS) {
      throw new Error(
        `本地 Skill《${record.descriptor.name}》有 ${record.content.length.toLocaleString('zh-CN')} 字，` +
          `超过 ${LOCAL_SKILL_MAX_ENTRY_CHARS.toLocaleString('zh-CN')} 字的本地安全上限，请拆分到 references/ 后再试。`,
      )
    }
    return {
      kind: 'matched',
      skill: {
        name: record.descriptor.name,
        description: record.descriptor.description,
        output: record.descriptor.output,
        content: record.content.slice(0, LOCAL_SKILL_MAX_CONTENT_CHARS),
        entryChars: record.content.length,
        entryTruncated: record.content.length > LOCAL_SKILL_MAX_CONTENT_CHARS,
        fullContent: record.content,
        path: record.descriptor.path,
      },
    }
  }
}

function extractLinkedVaultPaths(
  content: string,
  directory: string,
  root: string,
  app: App,
): string[] {
  const candidates = new Set<string>()
  const add = (raw: string) => {
    const cleaned = raw.trim().replace(/^<|>$/g, '').split('|', 1)[0].trim()
    if (!cleaned || /^(?:https?:|file:)/i.test(cleaned)) return
    for (const path of localSkillLinkedPathCandidates(cleaned, directory, root)) {
      const file = app.vault.getAbstractFileByPath(path)
      if (file instanceof TFile) candidates.add(path)
    }
  }
  for (const match of content.matchAll(/\[\[([^\]\r\n]+\.(?:md|txt|json|ya?ml|toml|csv|html?|css|[cm]?js|tsx?|jsx?|py|ps1|sh))(?:\|[^\]]*)?\]\]/giu)) {
    add(match[1])
  }
  for (const match of content.matchAll(/[`(]([^`)\r\n]+\.(?:md|txt|json|ya?ml|toml|csv|html?|css|[cm]?js|tsx?|jsx?|py|ps1|sh))[`)]/giu)) {
    add(match[1])
  }
  return [...candidates]
}

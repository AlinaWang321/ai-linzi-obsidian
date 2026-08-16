/**
 * 对话直接创建本地 Skill · 标记块协议(v0.6.47，v0.7.28 扩展文件夹)。
 *
 * 服务端只在用户明确要求创建工作流/Skill 时输出：
 *   <<<新建Skill name=consultation-brief>>>
 *   ---
 *   name: consultation-brief
 *   description: 把咨询逐字稿整理成客户可读简报
 *   ---
 *   # 咨询简报
 *   ...
 *   <<<新建Skill结束>>>
 *
 * 插件剥离标记并渲染确认卡；用户点击后才写入
 * `<设置的 AI 工作流目录>/<name>/SKILL.md`。只新建、不覆盖。
 *
 * 为兼容 Agent Skills / Codex / Claude Code，frontmatter 只允许 name 与
 * description 两个标准字段。AI霖子自己的输出方式写在普通 Markdown 正文中。
 */

import { LOCAL_SKILL_MAX_CONTENT_CHARS } from './local-skill-core'

export interface CreateLocalSkillBlock {
  name: string
  description: string
  content: string
  files: { path: string; content: string }[]
}

export interface CreateLocalSkillExtraction {
  cleanText: string
  blocks: CreateLocalSkillBlock[]
}

export const CREATE_LOCAL_SKILL_MAX_BLOCKS = 1
export const CREATE_LOCAL_SKILL_MAX_FILES = 12
export const CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS = 60_000
export const PORTABLE_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const BLOCK_RE =
  /<<<新建Skill\s+name=([^>\n]{1,100})>>>\r?\n?([\s\S]*?)\r?\n?<<<新建Skill结束>>>/giu
const FILE_BLOCK_RE =
  /<<<Skill文件\s+path=([^>\n]{1,160})>>>\r?\n?([\s\S]*?)\r?\n?<<<Skill文件结束>>>/giu
const TEXT_FILE_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'html', 'htm', 'css', 'svg',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'ps1', 'sh',
])

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed.trim() : ''
    } catch {
      return ''
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'").trim()
  }
  return trimmed
}

export function isPortableSkillName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && PORTABLE_SKILL_NAME_RE.test(value)
}

export function normalizeSkillBundlePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f:*?"<>|]/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null
  if (normalized.toLocaleLowerCase() === 'skill.md') return 'SKILL.md'
  if (!['references', 'scripts', 'assets'].includes(parts[0].toLocaleLowerCase())) return null
  if (parts.length < 2 || parts.length > 4) return null
  const extension = parts.at(-1)?.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  return TEXT_FILE_EXTENSIONS.has(extension) ? parts.join('/') : null
}

/**
 * 只接受最小可移植 frontmatter。复杂 YAML、额外私有字段或 name 不一致时，
 * 宁可不出确认卡，也不把“看似 Skill、实际跨端不兼容”的文件写进 Vault。
 */
export function parsePortableSkillContent(
  markerName: string,
  rawContent: string,
): CreateLocalSkillBlock | null {
  const name = markerName.trim()
  const content = rawContent.replace(/^\uFEFF/, '').trim()
  if (!isPortableSkillName(name) || !content || content.length > LOCAL_SKILL_MAX_CONTENT_CHARS) {
    return null
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content)
  if (!match) return null

  const values = new Map<string, string>()
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!field || !['name', 'description'].includes(field[1]) || values.has(field[1])) {
      return null
    }
    values.set(field[1], unquoteYamlScalar(field[2]))
  }

  const frontmatterName = values.get('name') ?? ''
  const description = values.get('description') ?? ''
  const body = match[2].trim()
  if (
    frontmatterName !== name ||
    !description ||
    description.length > 240 ||
    !body
  ) {
    return null
  }
  return { name, description, content, files: [{ path: 'SKILL.md', content }] }
}

export function parsePortableSkillBundle(
  markerName: string,
  rawContent: string,
): CreateLocalSkillBlock | null {
  if (!/<<<Skill文件/iu.test(rawContent)) {
    return parsePortableSkillContent(markerName, rawContent)
  }
  const files: { path: string; content: string }[] = []
  let invalidFile = false
  const remainder = rawContent.replace(FILE_BLOCK_RE, (_match, rawPath: string, rawFile: string) => {
    const path = normalizeSkillBundlePath(rawPath)
    const content = rawFile.replace(/^\uFEFF/, '').trim()
    if (!path || !content || files.some((file) => file.path.toLocaleLowerCase() === path.toLocaleLowerCase())) {
      invalidFile = true
    } else {
      files.push({ path, content })
    }
    return ''
  }).trim()
  if (
    invalidFile ||
    remainder ||
    files.length === 0 ||
    files.length > CREATE_LOCAL_SKILL_MAX_FILES ||
    files.reduce((sum, file) => sum + file.content.length, 0) > CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS
  ) {
    return null
  }
  const entry = files.find((file) => file.path === 'SKILL.md')
  if (!entry) return null
  const parsedEntry = parsePortableSkillContent(markerName, entry.content)
  if (!parsedEntry) return null
  return {
    ...parsedEntry,
    files,
  }
}

export function extractCreateLocalSkillBlocks(text: string): CreateLocalSkillExtraction {
  const blocks: CreateLocalSkillBlock[] = []
  const cleanText = text
    .replace(BLOCK_RE, (_match, rawName: string, rawContent: string) => {
      if (blocks.length < CREATE_LOCAL_SKILL_MAX_BLOCKS) {
        const block = parsePortableSkillBundle(rawName, rawContent)
        if (block) blocks.push(block)
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, blocks }
}

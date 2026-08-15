/**
 * 对话直接创建文件夹 · 标记块协议(v0.6.42,2026-07-30 Alina 拍板)
 *
 * 目标场景:打卡营 Day 1,学员对 AI霖子说「帮我搭好知识库框架」→ Luna 根据
 * 用户场景规划目录与插件绑定 → 确认卡允许“只创建”或“创建并应用设置”。
 *
 * 服务端渠道指令教模型输出(每行一个路径):
 *   <<<新建文件夹>>>
 *   inbox
 *   raw/逐字稿
 *   <<<新建文件夹结束>>>
 * 插件剥离标记渲染确认卡;**用户点击后才**逐级 vault.createFolder(已存在跳过)。
 * 安全边界:路径在这里净化——每段去危险字符与前导点(防隐藏目录/穿越),
 * 深度 ≤3,单块最多 8 个,总长 ≤120 字符;绝不删除或移动任何已有内容。
 */

export const CREATE_FOLDER_MAX = 8
export const CREATE_FOLDER_MAX_DEPTH = 3

const BLOCK_RE = /<<<新建文件夹>>>\r?\n?([\s\S]*?)\r?\n?<<<新建文件夹结束>>>/g
const STRUCTURE_BLOCK_RE =
  /<<<AI_LINZI_VAULT_STRUCTURE>>>\s*([\s\S]*?)\s*<<<AI_LINZI_VAULT_STRUCTURE_END>>>/g

export type VaultStructureBindingKey =
  | 'inbox'
  | 'sources'
  | 'knowledge'
  | 'output'
  | 'localSkills'

export interface VaultStructurePlan {
  title: string
  folders: string[]
  bindings: Partial<Record<VaultStructureBindingKey, string>>
}

export interface VaultStructureSettingPatch {
  cockpitInboxFolder?: string
  cockpitSourcesFolder?: string
  cockpitKnowledgeFolder?: string
  cockpitOutputFolder?: string
  localSkillsFolder?: string
}

const BINDING_TO_SETTING: Record<VaultStructureBindingKey, keyof VaultStructureSettingPatch> = {
  inbox: 'cockpitInboxFolder',
  sources: 'cockpitSourcesFolder',
  knowledge: 'cockpitKnowledgeFolder',
  output: 'cockpitOutputFolder',
  localSkills: 'localSkillsFolder',
}

export const VAULT_STRUCTURE_BINDING_LABELS: Record<VaultStructureBindingKey, string> = {
  inbox: '驾驶舱 · 收件箱',
  sources: '驾驶舱 · 原始素材',
  knowledge: '驾驶舱 · 知识库',
  output: '驾驶舱 · 对外输出',
  localSkills: '我的 Skills',
}

/** 单段净化与 create-note 的标题净化同规:危险字符换空格、折叠、剥前导点 */
function sanitizeSegment(raw: string): string {
  return raw
    .replace(/[:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .trim()
}

export function sanitizeFolderPath(raw: string): string {
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .map(sanitizeSegment)
    .filter((seg) => seg.length > 0)
    .slice(0, CREATE_FOLDER_MAX_DEPTH)
  return segments.join('/').slice(0, 120).replace(/\/+$/, '')
}

export interface CreateFolderExtraction {
  cleanText: string
  folders: string[]
  plans: VaultStructurePlan[]
  invalidStructurePlan: boolean
}

function sanitizePlanTitle(value: unknown): string {
  if (typeof value !== 'string') return '知识库目录方案'
  return value.replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '知识库目录方案'
}

function parseVaultStructurePlan(raw: string): VaultStructurePlan | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.folders)) return null

  const folders: string[] = []
  const seen = new Set<string>()
  for (const candidate of record.folders) {
    if (folders.length >= CREATE_FOLDER_MAX) break
    if (typeof candidate !== 'string') continue
    const path = sanitizeFolderPath(candidate)
    if (!path || seen.has(path)) continue
    seen.add(path)
    folders.push(path)
  }
  if (folders.length === 0) return null

  const bindings: Partial<Record<VaultStructureBindingKey, string>> = {}
  if (record.bindings && typeof record.bindings === 'object' && !Array.isArray(record.bindings)) {
    const source = record.bindings as Record<string, unknown>
    for (const key of Object.keys(BINDING_TO_SETTING) as VaultStructureBindingKey[]) {
      if (typeof source[key] !== 'string') continue
      const path = sanitizeFolderPath(source[key] as string)
      // 绑定路径必须同时出现在本次确认清单中，避免模型把未展示的任意路径写进设置。
      if (path && seen.has(path)) bindings[key] = path
    }
  }
  return { title: sanitizePlanTitle(record.title), folders, bindings }
}

export function vaultStructureSettingPatch(plan: VaultStructurePlan): VaultStructureSettingPatch {
  const patch: VaultStructureSettingPatch = {}
  for (const [key, path] of Object.entries(plan.bindings) as [VaultStructureBindingKey, string][]) {
    patch[BINDING_TO_SETTING[key]] = path
  }
  return patch
}

/** 从助手回复中提取新建文件夹块;展示文本剥离标记,越界/重复丢弃 */
export function extractCreateFolderBlocks(text: string): CreateFolderExtraction {
  const plans: VaultStructurePlan[] = []
  let invalidStructurePlan = false
  const folders: string[] = []
  const seen = new Set<string>()
  let withoutStructurePlans = text.replace(STRUCTURE_BLOCK_RE, (_match, body: string) => {
    if (plans.length >= 1) return ''
    const plan = parseVaultStructurePlan(body.trim())
    if (!plan) {
      invalidStructurePlan = true
      return ''
    }
    plans.push(plan)
    for (const path of plan.folders) {
      if (!seen.has(path)) {
        seen.add(path)
        folders.push(path)
      }
    }
    return ''
  })
  const hangingStructureAt = withoutStructurePlans.indexOf('<<<AI_LINZI_VAULT_STRUCTURE>>>')
  if (hangingStructureAt >= 0) {
    invalidStructurePlan = true
    withoutStructurePlans = withoutStructurePlans.slice(0, hangingStructureAt)
  }
  const cleanText = withoutStructurePlans
    .replace(BLOCK_RE, (_match, body: string) => {
      for (const line of body.split(/\r?\n/)) {
        if (folders.length >= CREATE_FOLDER_MAX) break
        const path = sanitizeFolderPath(line)
        if (path && !seen.has(path)) {
          seen.add(path)
          folders.push(path)
        }
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, folders, plans, invalidStructurePlan }
}

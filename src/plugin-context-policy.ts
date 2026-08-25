export type PluginContextMode =
  | 'source-only'
  | 'personalized-content'
  | 'business-coach'
  | 'vault-data'

const CONTENT_CREATION =
  /(?:公众号|小红书|朋友圈|文章|文案|口播|脚本|播客|邮件|newsletter|blog|copywriting|content\s*(?:creation|writing)|rewrite|polish|润色|改写|仿写|写作风格)/iu

const VAULT_DATA_TASK =
  /(?:经营周报|周报看板|经营看板|仪表盘|dashboard|inventory|目录清单|文件清单|统计(?:数量|文件|笔记)|批量归档|全库盘点)/iu

const COACH_TASK =
  /(?:商业教练|创业教练|生意诊断|商业诊断|商业咨询|定位诊断|商业模式|销售教练|business\s*coach)/iu

const PERSONAL_CONTEXT =
  /(?:个人知识库|我的知识库|用户档案|学员档案|跨对话记忆|长期记忆|结合.*(?:记忆|档案|知识库)|按我的(?:风格|口吻|品牌))/iu

/**
 * Skill 的 Vault 权限与提示词预加载是两件事：前者仍可覆盖整个 Vault，
 * 后者默认只给完成任务所需的最小上下文，避免当前笔记被人设/记忆/RAG 污染。
 */
export function inferPluginSkillContextMode(text: string): PluginContextMode {
  const normalized = text.normalize('NFKC')
  if (CONTENT_CREATION.test(normalized)) return 'personalized-content'
  if (VAULT_DATA_TASK.test(normalized)) return 'vault-data'
  if (COACH_TASK.test(normalized) && PERSONAL_CONTEXT.test(normalized)) return 'business-coach'
  return 'source-only'
}

export function pluginContextModeForTurn(input: {
  currentNoteOnly: boolean
  skillManagement: boolean
  localSkillText?: string
  manifestMode?: PluginContextMode
}): PluginContextMode | undefined {
  if (input.skillManagement) return 'source-only'
  if (input.localSkillText) {
    return input.manifestMode ?? inferPluginSkillContextMode(input.localSkillText)
  }
  if (input.currentNoteOnly) return 'source-only'
  return undefined
}

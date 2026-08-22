import type { LocalSkillOutput } from './local-skill-core'
import { isVaultMutationExplicitlyDenied } from './vault-agent-core'

export interface LocalSkillTurnPolicy {
  /** 只覆盖当前一轮请求，不修改 Vault 中的 Skill 定义。 */
  output: LocalSkillOutput
  /** 只有本轮确实允许落盘时，才强制安全循环收尾到确认卡。 */
  forceOrganize: boolean
  readOnly: boolean
}

/**
 * 用户本轮的明确只读要求，优先于 Skill 声明的默认输出方式。
 *
 * 例如 create-note Skill 仍可搜索、读取并在聊天里列出结果；但当用户说
 * “先不要写入”时，不能把它强制送进 organize 流程并等待一张不需要的写入卡。
 */
export function resolveLocalSkillTurnPolicy(
  declaredOutput: LocalSkillOutput,
  question: string,
): LocalSkillTurnPolicy {
  const readOnly = isVaultMutationExplicitlyDenied(question)
  if (readOnly) {
    return { output: 'chat', forceOrganize: false, readOnly: true }
  }
  return {
    output: declaredOutput,
    forceOrganize: declaredOutput === 'create-note' || declaredOutput === 'create-artifact',
    readOnly: false,
  }
}

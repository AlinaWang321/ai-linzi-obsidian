export interface LocalSkillRunState {
  kind: 'sales-review'
  state: 'running' | 'completed' | 'failed'
  startedAt: number
  updatedAt: number
}

export interface RecoveredLocalSkillStatus {
  text: string
  run?: LocalSkillRunState
  recovered: boolean
}

const LEGACY_SALES_REVIEW_RUNNING = /^🤖 正在生成谈单诊断：《/

/**
 * 插件重载后，内存里的 fetch 已经不存在；本机历史却会原样恢复。
 * 把没有活跃执行器的“生成中”状态收口为可操作的失败态，避免永久假进度。
 */
export function recoverLocalSkillStatus(
  text: string,
  run: LocalSkillRunState | undefined,
  active: boolean,
  now = Date.now(),
): RecoveredLocalSkillStatus {
  const interruptedStructuredRun =
    run?.kind === 'sales-review' && run.state === 'running' && !active
  const interruptedLegacyRun = !run && LEGACY_SALES_REVIEW_RUNNING.test(text) && !active
  if (!interruptedStructuredRun && !interruptedLegacyRun) {
    return { text, run, recovered: false }
  }

  return {
    text: '⚠️ 上次销售复盘在 Obsidian 关闭、重载或连接中断后停止了，不能自动续跑。请重新发起“销售复盘”。',
    run: {
      kind: 'sales-review',
      state: 'failed',
      startedAt: run?.startedAt ?? 0,
      updatedAt: now,
    },
    recovered: true,
  }
}

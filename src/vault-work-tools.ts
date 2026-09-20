import type { VaultRunJournal } from './vault-run-journal'

export const VAULT_WORK_NAMES = new Set(['set_task_plan', 'save_research_note', 'stage_note_draft', 'propose_staged_notes'])
export function safeWorkPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('需要准确的 Vault 相对路径')
  const path = value.trim().replace(/\\/g, '/')
  if (!path || path.length > 500 || path.startsWith('/') || /[:\0]/.test(path) ||
    path.split('/').some(x => !x || x === '..' || x.startsWith('.') || /^(AGENTS|CLAUDE)\.md$/i.test(x))) {
    throw new Error('资料路径无效或属于保护目录')
  }
  return path
}
export function recordWorkRead(journal: VaultRunJournal, path: string, output: string) {
  const data = JSON.parse(output) as { offset?: number; nextOffset?: number | null; totalChars?: number; text?: string; content?: string; truncated?: boolean }
  if (!Number.isFinite(data.totalChars) || data.nextOffset === undefined) return
  const start = data.offset ?? 0
  const old = journal.reads[path]
  const covered = old?.nextOffset === null ? old.totalChars : old?.nextOffset ?? 0
  if (start > covered) return // Reading the last page alone is not reading the entire file.
  const end = data.nextOffset === null ? data.totalChars! : data.nextOffset
  const next = Math.max(covered, end)
  journal.reads[path] = { nextOffset: next >= data.totalChars! ? null : next, totalChars: data.totalChars! }
}
export function runVaultWorkTool(journal: VaultRunJournal, name: string, args: Record<string, unknown>,
  exists: (path: string) => boolean): { output: string; plan?: string; compact?: boolean } {
  if (name === 'set_task_plan') {
    if (!Array.isArray(args.sourcePaths) || args.sourcePaths.length < 1 || args.sourcePaths.length > 100) throw new Error('资料清单需要 1–100 份准确来源')
    const paths = [...new Set(args.sourcePaths.map(safeWorkPath))]
    const missing = paths.filter(p => !exists(p))
    if (missing.length) throw new Error(`尚未找到这些来源：${missing.join('、')}`)
    journal.plan = paths
    return { output: JSON.stringify({ ok: true, sources: paths.map(path => ({ path, ...journal.reads[path] })) }) }
  }
  if (name === 'save_research_note') {
    const path = safeWorkPath(args.sourcePath)
    if (journal.reads[path]?.nextOffset !== null) throw new Error(`这份资料尚未完整读取，请从 ${journal.reads[path]?.nextOffset ?? 0} 继续：${path}`)
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 10_000) throw new Error('研究笔记需为完整的有效文字，最多 10,000 字')
    journal.summaries[path] = args.summary
    if (Object.values(journal.summaries).join('').length > 80_000) {
      delete journal.summaries[path]
      throw new Error('研究笔记总量已达到本批预算，请先交付当前批次并明确剩余范围')
    }
    return { output: JSON.stringify({ ok: true, sourcePath: path, saved: true }), compact: true }
  }
  if (name === 'stage_note_draft') {
    const path = safeWorkPath(args.path)
    if (!path.endsWith('.md')) throw new Error('草稿必须是 Markdown 文件')
    if (exists(path)) throw new Error('目标文件已存在，请真实读取后通过修改方案更新，不能覆盖新建')
    if (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 30_000) throw new Error('草稿需要完整正文，单篇最多 30,000 字')
    if (!journal.drafts[path] && Object.keys(journal.drafts).length >= 12) throw new Error('一批最多暂存 12 篇草稿，请先交付本批')
    journal.drafts[path] = args.content
    return { output: JSON.stringify({ ok: true, path, chars: args.content.length, staged: true, written: false }) }
  }
  if (name === 'propose_staged_notes') {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 12) throw new Error('请选择 1–12 篇已暂存草稿')
    const paths = [...new Set(args.paths.map(safeWorkPath))]
    if (paths.some(p => !journal.drafts[p] || exists(p))) throw new Error('草稿缺失或目标文件已经存在，请先核对')
    const unread = journal.plan.filter(path => journal.reads[path]?.nextOffset !== null)
    if (unread.length) throw new Error(`指定来源尚未完整读取，不能提交全部完成的综合结果：${unread.join('、')}`)
    const plan = { title: typeof args.title === 'string' ? args.title : '文档处理结果',
      summary: typeof args.summary === 'string' ? args.summary : '',
      operations: paths.map(path => ({ type: 'create_note', path, content: journal.drafts[path], reason: '根据已核实来源生成' })),
      notes: ['已逐篇暂存完整草稿；确认后才写入 Vault。'] }
    return { output: '已生成待确认方案', plan: `<<<VAULT_ORGANIZE_PLAN>>>\n${JSON.stringify(plan)}\n<<<VAULT_ORGANIZE_PLAN_END>>>` }
  }
  throw new Error('不支持的文件任务动作')
}

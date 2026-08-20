/**
 * 主对话当前笔记的最小授权判断。
 *
 * v0.7.18 起不再让用户维护一个长期勾选状态。只有本轮文字明确要求处理当前
 * 打开的内容，或正在继续上一轮已经读取过的当前笔记任务，才读取单篇正文。
 */

const EXPLICIT_CURRENT_NOTE =
  /(?:(?:当前|这篇|这份|这个|正在打开的|刚打开的|我打开的|屏幕上的).{0,8}(?:笔记|文档|文件|文章|逐字稿|稿子|内容|记录|会议|周报|日报|复盘)|这段(?:文字|内容)?)/u

const CURRENT_NOTE_ACTION =
  /(?:读|读取|看看|查看|分析|总结|整理|提炼|检查|评价|诊断|建议|判断|回答|规划|设计|生成|做|写|修改|改写|润色|续写|翻译|压缩|扩写|优化|排版|配图|处理|覆盖|替换全文|整篇替换|写回|更新到|更新进|删除|删掉|移入回收站|移入废纸篓)/u

const CONTINUING_CURRENT_NOTE =
  /^(?:继续|接着|再(?:帮我)?|然后|按这个|基于这个|把它|把这篇|把这段|改成|修改为|再改|再优化|再润色|再短一点|再长一点|同样)/u

export interface OpenMarkdownSelection {
  activePath?: string
  recentRootPath?: string
  lastActivePath?: string
  openPaths: string[]
}

/**
 * “最近打开过”不等于“当前仍授权”。只有仍存在于 Markdown 标签页里的文件，
 * 才能成为当前笔记；所有标签页关闭后必须返回 undefined。
 */
export function selectCurrentOpenMarkdownPath(
  selection: OpenMarkdownSelection,
): string | undefined {
  const open = new Set(selection.openPaths)
  for (const candidate of [
    selection.activePath,
    selection.recentRootPath,
    selection.lastActivePath,
  ]) {
    if (candidate && open.has(candidate)) return candidate
  }
  return selection.openPaths.length === 1 ? selection.openPaths[0] : undefined
}

export function isExplicitCurrentNoteIntent(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '')
  if (!EXPLICIT_CURRENT_NOTE.test(normalized)) return false
  return CURRENT_NOTE_ACTION.test(normalized)
}

export function shouldUseCurrentNote(text: string, continuingCurrentNoteTask = false): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '')
  if (isExplicitCurrentNoteIntent(normalized)) return true
  return continuingCurrentNoteTask && CONTINUING_CURRENT_NOTE.test(normalized)
}

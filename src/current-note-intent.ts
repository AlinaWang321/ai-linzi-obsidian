/**
 * 主对话当前笔记的最小授权判断。
 *
 * v0.7.18 起不再让用户维护一个长期勾选状态。只有本轮文字明确要求处理当前
 * 打开的内容，或正在继续上一轮已经读取过的当前笔记任务，才读取单篇正文。
 */

const EXPLICIT_CURRENT_NOTE =
  /(?:(?:当前|这篇|这份|这个|正在打开的|刚打开的|我打开的|屏幕上的).{0,8}(?:笔记|文档|文件|文章|逐字稿|稿子|内容)|这段(?:文字|内容)?)/u

const CURRENT_NOTE_ACTION =
  /(?:读|读取|看看|查看|分析|总结|整理|提炼|检查|评价|诊断|建议|判断|回答|规划|设计|生成|写|修改|改写|润色|续写|翻译|压缩|扩写|优化|排版|配图|处理)/u

const CONTINUING_CURRENT_NOTE =
  /^(?:继续|接着|再(?:帮我)?|然后|按这个|基于这个|把它|把这篇|把这段|改成|修改为|再改|再优化|再润色|再短一点|再长一点|同样)/u

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

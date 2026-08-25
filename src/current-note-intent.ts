/**
 * 主对话当前笔记的最小授权判断。
 *
 * v0.7.18 起不再让用户维护一个长期勾选状态。只有本轮文字明确要求处理当前
 * 打开的内容，或正在继续上一轮已经读取过的当前笔记任务，才读取单篇正文。
 */

const EXPLICIT_CURRENT_NOTE =
  /(?:(?:当前|这篇|这份|这个|正在打开的|刚打开的|我打开的|屏幕上的).{0,8}(?:笔记|文档|文件|文章|逐字稿|稿子|内容|记录|会议|周报|日报|复盘)|这段(?:文字|内容)?)/u

const CURRENT_NOTE_ACTION =
  /(?:读|读取|看看|查看|分析|总结|整理|提炼|检查|评价|诊断|建议|判断|回答|规划|设计|生成|变成|转成|转换(?:成|为)|做|写|修改|改写|润色|续写|翻译|压缩|扩写|优化|排版|配图|处理|覆盖|替换全文|整篇替换|写回|更新到|更新进|删除|删掉|移入回收站|移入废纸篓)/u

const CONTINUING_CURRENT_NOTE =
  /^(?:继续|接着|再(?:帮我)?|然后|按这个|基于这个|把它|把这篇|把这段|改成|修改为|再改|再优化|再润色|再短一点|再长一点|同样)/u

const ACTIVE_CURRENT_NOTE_REFERENCE =
  /(?:当前|正在打开的|刚打开的|我打开的|屏幕上的).{0,8}(?:笔记|文档|文件|文章|逐字稿|稿子|内容|记录|会议|周报|日报|复盘)/u

const CURRENT_NOTE_RECOVERY =
  /^(?:(?:就是|(?:这|它)(?:就是|明明是|已经是)?)(?:完整(?:版|的)?|全文|全部内容)|(?:你)?为什么(?:读|看|找|识别)(?:不|没)(?:到|了)?|(?:你)?(?:读|看|找)(?:错|漏)(?:了|的)?|重新(?:读|看|处理)(?:这篇|这份|这个|刚才|上面)|就是(?:这篇|这份|这个)|按(?:刚才|上面|前面)(?:那篇|那份|的内容)?继续)/u

export type CurrentNoteReference = 'active' | 'locked' | 'none'

const BROADER_VAULT_SCOPE =
  /(?:(?:整个|全部|全库|全仓库).{0,4}(?:vault|obsidian|知识库|仓库|文件|笔记|资料)|(?:其他|相关|更多).{0,4}(?:笔记|文档|文件|资料|内容)|(?:vault|obsidian|知识库|仓库|文件夹|目录)(?:里|中|内|下)?)/iu

const BROADER_VAULT_ACTION =
  /(?:搜索|查找|检索|遍历|扫描|对照|结合|参考|关联|补充)/u

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

/**
 * 当前笔记来源优先级：
 * 1. “当前/正在打开”明确指向此刻的编辑器标签；
 * 2. “这篇/继续/为什么读不到”在已有来源时沿用上文锁定路径；
 * 3. 上文没有来源时，“这篇笔记”回退到当前打开的 Markdown。
 */
export function resolveCurrentNoteReference(
  text: string,
  hasLockedContext: boolean,
): CurrentNoteReference {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '')
  if (isExplicitCurrentNoteIntent(normalized)) {
    if (ACTIVE_CURRENT_NOTE_REFERENCE.test(normalized)) return 'active'
    return hasLockedContext ? 'locked' : 'active'
  }
  if (hasLockedContext && (
    CONTINUING_CURRENT_NOTE.test(normalized) ||
    CURRENT_NOTE_RECOVERY.test(normalized)
  )) return 'locked'
  return 'none'
}

/**
 * “处理这篇笔记”已经把正文锁定，不应再自动把同名/相似文件搜一遍。
 * 只有用户同时明确要求把搜索范围扩到知识库、目录、其他资料时，才进入 Vault 工具循环。
 */
export function shouldSearchVaultBeyondCurrentNote(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '')
  return BROADER_VAULT_SCOPE.test(normalized) && BROADER_VAULT_ACTION.test(normalized)
}

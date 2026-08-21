/**
 * `/` 命令面板的触发判定（0.7.71）。
 *
 * 抽成纯函数的原因和 activity-feed-core 一样：这条判定有四个容易踩的边界
 * （真实路径里的斜杠、中文输入法合成期、修饰键、访谈模式），
 * 放在 main.ts 里只能靠源码 grep「代码还在」，证明不了「行为还对」。
 * 逻辑在这里，真跑测试见 scripts/test-slash-menu-core.mjs。
 *
 * 这里不碰 DOM、不认识 Obsidian，只看一组标量状态。
 */

export interface SlashMenuKeyState {
  key: string
  /** 中文/日文输入法合成中（IME composition）。 */
  isComposing: boolean
  /** 部分浏览器在合成期只给 keyCode 229，不给 isComposing。 */
  keyCode?: number
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

export interface SlashMenuInputState {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  /** 访谈写作模式下输入框语义不同，不接管 `/`。 */
  interviewMode: boolean
}

/**
 * 是否应当由 `/` 面板接管这次按键。
 *
 * 只在「输入框为空」或「光标停在开头且没有选区」时接管，
 * 这样 `02_Wiki/客户档案.md` 这类真实路径输入不会被打断。
 */
export function shouldOpenSlashMenu(
  ev: SlashMenuKeyState,
  input: SlashMenuInputState,
): boolean {
  if (ev.key !== '/') return false
  // 合成期间的按键属于输入法，抢过来会打断候选词。
  if (ev.isComposing || ev.keyCode === 229) return false
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false
  if (input.interviewMode) return false
  if (input.value.length === 0) return true
  return input.selectionStart === 0 && input.selectionEnd === 0
}

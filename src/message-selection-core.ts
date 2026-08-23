export interface MessageTextSelectionHost {
  getSelection: () => Selection | null
  showCopyMenu: (event: MouseEvent, selectedText: string) => void
}

/**
 * Obsidian 的面板拖拽会吞掉消息气泡的鼠标事件。这里只停止冒泡，
 * 绝不 preventDefault，因此浏览器仍然能用鼠标原生拖选并用 ⌘C/Ctrl+C 复制。
 */
export function installMessageTextSelection(
  body: HTMLElement,
  host: MessageTextSelectionHost,
): void {
  const stopPropagation = (event: Event) => event.stopPropagation()
  body.addEventListener('pointerdown', stopPropagation)
  body.addEventListener('mousedown', stopPropagation)
  body.addEventListener('selectstart', stopPropagation)
  body.addEventListener('contextmenu', (event) => {
    const selection = host.getSelection()
    const selectedText = selection?.toString() ?? ''
    const anchorInside = Boolean(selection?.anchorNode && body.contains(selection.anchorNode))
    const focusInside = Boolean(selection?.focusNode && body.contains(selection.focusNode))
    if (!selectedText || (!anchorInside && !focusInside)) return
    event.preventDefault()
    event.stopPropagation()
    host.showCopyMenu(event, selectedText)
  })
}

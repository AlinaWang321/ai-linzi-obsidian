import { App, Modal } from 'obsidian'
import {
  CONVERSATION_TITLE_OVERRIDE_MAX,
  normalizeConversationTitleOverride,
} from './conversation-title-core'

/** undefined=取消；null=清空自定义标题；string=保存新标题。 */
export function requestConversationTitle(
  app: App,
  currentTitle: string,
): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    new ConversationTitleModal(app, currentTitle, resolve).open()
  })
}

export class ConversationTitleModal extends Modal {
  private resolved = false
  private inputEl?: HTMLInputElement

  constructor(
    app: App,
    private readonly currentTitle: string,
    private readonly resolve: (value: string | null | undefined) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-conversation-title-modal')
    this.setTitle('修改对话标题')
    this.contentEl.createEl('p', {
      text: '标题只用于整理历史，不会发给 AI。留空保存会恢复为第一条问题自动生成的标题。',
    })
    this.inputEl = this.contentEl.createEl('input', {
      cls: 'ai-linzi-conversation-title-input',
      attr: {
        type: 'text',
        maxlength: String(CONVERSATION_TITLE_OVERRIDE_MAX),
        'aria-label': '对话标题',
      },
    })
    this.inputEl.value = this.currentTitle
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        this.finish(normalizeConversationTitleOverride(this.inputEl?.value ?? ''))
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.finish(undefined)
      }
    })
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
    const cancel = actions.createEl('button', { text: '取消' })
    cancel.onclick = () => this.finish(undefined)
    const save = actions.createEl('button', { text: '保存标题', cls: 'mod-cta' })
    save.onclick = () => this.finish(normalizeConversationTitleOverride(this.inputEl?.value ?? ''))
    window.setTimeout(() => {
      this.inputEl?.focus()
      this.inputEl?.select()
    }, 0)
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true
      this.resolve(undefined)
    }
    this.contentEl.empty()
  }

  private finish(value: string | null | undefined): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(value)
    this.close()
  }
}

/**
 * 小红书卡片风格选择卡。
 *
 * 「小红书图文卡片」与「多平台分发」生成卡片前共用;放在服务端改写调用之前,
 * 取消即中止、零积分消耗。选 X 推文风且昵称/@账号未配置时,直接在卡内补填,
 * 确认时一并存入设置;头像在 设置 → AI霖子 → 小红书卡片 里选择(可选)。
 */
import { Modal, Notice, type App } from 'obsidian'
import type AiLinziPlugin from './main'
import { XHS_CARD_STYLES, getXhsCardStyle } from './xhs-card-styles'
import type { XhsCardStyleId } from './xhs-card-render'

export interface XhsStyleChoice {
  styleId: XhsCardStyleId
}

class XhsStylePickerModal extends Modal {
  private selectedId: XhsCardStyleId
  private submitted = false
  private resolve!: (choice: XhsStyleChoice | null) => void
  readonly result: Promise<XhsStyleChoice | null>
  private nicknameInput!: HTMLInputElement
  private handleInput!: HTMLInputElement
  private identityEl!: HTMLElement

  constructor(app: App, private plugin: AiLinziPlugin) {
    super(app)
    this.selectedId = getXhsCardStyle(plugin.settings.xhsCardStyleId).id
    this.result = new Promise((r) => (this.resolve = r))
    this.open()
  }

  onOpen() {
    this.titleEl.setText('选择小红书卡片风格')
    this.modalEl.addClass('ai-linzi-wtheme-modal')
    const list = this.contentEl.createDiv({ cls: 'ai-linzi-wtheme-list' })
    const cards = new Map<string, HTMLElement>()

    for (const style of XHS_CARD_STYLES) {
      const card = list.createDiv({ cls: 'ai-linzi-wtheme-card' })
      cards.set(style.id, card)
      const head = card.createDiv({ cls: 'ai-linzi-wtheme-head' })
      for (const color of style.swatch) {
        const dot = head.createSpan({ cls: 'ai-linzi-wtheme-dot' })
        dot.setAttribute('style', `background:${color};`)
      }
      head.createSpan({ cls: 'ai-linzi-wtheme-name', text: style.name })
      head.createSpan({ cls: 'ai-linzi-wtheme-tagline', text: style.tagline })

      if (style.id === 'x-dark') {
        this.identityEl = card.createDiv({ cls: 'ai-linzi-xhs-identity' })
        const nickRow = this.identityEl.createDiv({ cls: 'ai-linzi-xhs-identity-row' })
        nickRow.createSpan({ text: '昵称' })
        this.nicknameInput = nickRow.createEl('input', {
          attr: { type: 'text', placeholder: '例如:Alina霖子' },
        })
        this.nicknameInput.value = this.plugin.settings.xhsCardNickname
        const handleRow = this.identityEl.createDiv({ cls: 'ai-linzi-xhs-identity-row' })
        handleRow.createSpan({ text: '@账号' })
        this.handleInput = handleRow.createEl('input', {
          attr: { type: 'text', placeholder: '例如:alinalinzi(不用带@)' },
        })
        this.handleInput.value = this.plugin.settings.xhsCardHandle
        this.identityEl.createDiv({
          cls: 'ai-linzi-wtheme-hint',
          text: '填一次会记住,随时可在 设置 → AI霖子 → 小红书卡片 修改;头像也在那里选择(可选,不设则用首字圆标)。',
        })
        // 点输入框不应触发卡片切换以外的行为;仍允许冒泡选中本卡
      }

      card.addEventListener('click', () => {
        this.selectedId = style.id
        for (const [id, el] of cards) el.toggleClass('is-selected', id === this.selectedId)
        this.identityEl?.toggleClass('is-visible', this.selectedId === 'x-dark')
      })
    }
    for (const [id, el] of cards) el.toggleClass('is-selected', id === this.selectedId)
    this.identityEl?.toggleClass('is-visible', this.selectedId === 'x-dark')

    this.contentEl.createDiv({
      cls: 'ai-linzi-wtheme-hint',
      text: '选择会被记住,下次默认用它;取消不产生任何积分消耗。',
    })
    const actions = this.contentEl.createDiv({ cls: 'ai-linzi-wtheme-actions' })
    actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close())
    actions.createEl('button', { text: '就用这个风格', cls: 'mod-cta' }).addEventListener('click', async () => {
      if (this.selectedId === 'x-dark') {
        const nickname = this.nicknameInput.value.trim()
        const handle = this.handleInput.value.trim().replace(/^@+/, '')
        if (!nickname || !handle) {
          new Notice('X 推文风需要先填昵称和 @账号(只填一次,以后记住)')
          return
        }
        this.plugin.settings.xhsCardNickname = nickname
        this.plugin.settings.xhsCardHandle = handle
      }
      this.submitted = true
      if (this.plugin.settings.xhsCardStyleId !== this.selectedId) {
        this.plugin.settings.xhsCardStyleId = this.selectedId
      }
      await this.plugin.saveSettings()
      this.close()
      this.resolve({ styleId: this.selectedId })
    })
  }

  onClose() {
    this.contentEl.empty()
    if (!this.submitted) this.resolve(null)
  }
}

/** 弹出风格选择卡;确认返回所选风格并记住,取消/关闭返回 null。 */
export function pickXhsCardStyle(plugin: AiLinziPlugin): Promise<XhsStyleChoice | null> {
  return new XhsStylePickerModal(plugin.app, plugin).result
}

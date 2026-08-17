/**
 * 公众号排版主题选择卡。
 *
 * 「一键复制」与「发到草稿箱」动作前共用:预选上次使用的主题,确认即记住
 * (settings.wechatThemeId,设置页可改默认),取消/关闭返回 null 中止动作。
 * 迷你预览与正式排版共用 wechat-themes.ts 同一份内联样式,只按比例缩小
 * 字号,颜色与结构所见即所得。
 */
import { Modal, type App } from 'obsidian'
import type AiLinziPlugin from './main'
import {
  WECHAT_THEMES,
  type WechatTheme,
  getWechatTheme,
  h2Style,
  paragraphStyle,
  pillStyle,
  quoteStyle,
  strongStyle,
} from './wechat-themes'

function renderMiniPreview(parent: HTMLElement, t: WechatTheme): void {
  const box = parent.createDiv({ cls: 'ai-linzi-wtheme-preview' })
  const pill = box.createEl('p', { text: 'PART 01' })
  pill.setAttribute('style', `${pillStyle(t)}margin:0 0 8px;font-size:12px;padding:4px 10px;`)
  const h2 = box.createEl('h2', { text: '清晰就是力量' })
  h2.setAttribute('style', `${h2Style(t)}margin:0 0 10px;font-size:17px;`)
  const p = box.createEl('p')
  p.setAttribute('style', `${paragraphStyle(t)}margin:0 0 8px;font-size:13px;line-height:1.8;`)
  p.appendText('正文段落,')
  const strong = p.createEl('strong', { text: '关键金句会这样强调' })
  strong.setAttribute('style', strongStyle(t))
  p.appendText('。')
  const quote = box.createEl('blockquote', { text: '引用块:先跑通商业闭环,再迭代定位。' })
  quote.setAttribute('style', `${quoteStyle(t)}margin:0;font-size:12px;line-height:1.7;padding:8px 12px;`)
}

class WechatThemePickerModal extends Modal {
  private selectedId: string
  private submitted = false
  private resolve!: (theme: WechatTheme | null) => void
  readonly result: Promise<WechatTheme | null>

  constructor(app: App, private plugin: AiLinziPlugin) {
    super(app)
    this.selectedId = getWechatTheme(plugin.settings.wechatThemeId).id
    this.result = new Promise((r) => (this.resolve = r))
    this.open()
  }

  onOpen() {
    this.titleEl.setText('选择公众号排版主题')
    this.modalEl.addClass('ai-linzi-wtheme-modal')
    const list = this.contentEl.createDiv({ cls: 'ai-linzi-wtheme-list' })
    const cards = new Map<string, HTMLElement>()

    for (const theme of WECHAT_THEMES) {
      const card = list.createDiv({ cls: 'ai-linzi-wtheme-card' })
      cards.set(theme.id, card)
      const head = card.createDiv({ cls: 'ai-linzi-wtheme-head' })
      for (const color of theme.swatch) {
        const dot = head.createSpan({ cls: 'ai-linzi-wtheme-dot' })
        dot.setAttribute('style', `background:${color};`)
      }
      head.createSpan({ cls: 'ai-linzi-wtheme-name', text: theme.name })
      head.createSpan({ cls: 'ai-linzi-wtheme-tagline', text: theme.tagline })
      renderMiniPreview(card, theme)
      card.addEventListener('click', () => {
        this.selectedId = theme.id
        for (const [id, el] of cards) el.toggleClass('is-selected', id === this.selectedId)
      })
    }
    for (const [id, el] of cards) el.toggleClass('is-selected', id === this.selectedId)

    this.contentEl.createDiv({
      cls: 'ai-linzi-wtheme-hint',
      text: '选择会被记住,下次默认用它;「一键复制」和「发到草稿箱」用同一套主题。',
    })
    const actions = this.contentEl.createDiv({ cls: 'ai-linzi-wtheme-actions' })
    actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close())
    actions.createEl('button', { text: '就用这个排版', cls: 'mod-cta' }).addEventListener('click', async () => {
      this.submitted = true
      const theme = getWechatTheme(this.selectedId)
      if (this.plugin.settings.wechatThemeId !== theme.id) {
        this.plugin.settings.wechatThemeId = theme.id
        await this.plugin.saveSettings()
      }
      this.close()
      this.resolve(theme)
    })
  }

  onClose() {
    this.contentEl.empty()
    if (!this.submitted) this.resolve(null)
  }
}

/** 弹出主题选择卡;确认返回所选主题并记住,取消/关闭返回 null。 */
export function pickWechatTheme(plugin: AiLinziPlugin): Promise<WechatTheme | null> {
  return new WechatThemePickerModal(plugin.app, plugin).result
}

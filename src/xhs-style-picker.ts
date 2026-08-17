/**
 * 小红书卡片风格选择卡。
 *
 * 「小红书图文卡片」与「多平台分发」生成卡片前共用;放在服务端改写调用之前,
 * 取消即中止、零积分消耗。选 X 推文风且昵称/@账号未配置时,直接在卡内补填,
 * 确认时一并存入设置;头像在 设置 → AI霖子 → 小红书卡片 里选择(可选)。
 */
import { Modal, Notice, normalizePath, type App } from 'obsidian'
import type AiLinziPlugin from './main'
import { XHS_CARD_STYLES, getXhsCardStyle } from './xhs-card-styles'
import type { XhsCardStyleId } from './xhs-card-render'
import { VaultImageBrowserModal } from './vault-image-browser'

/** 弹系统文件选择器选一张头像图(PNG/JPG/WebP)。 */
export function chooseXhsAvatarFile(onChoose: (file: File) => void | Promise<void>): void {
  const input = createEl('input', {
    cls: 'ai-linzi-file-input',
    attr: { type: 'file', accept: 'image/png,image/jpeg,image/webp' },
  })
  activeDocument.body.appendChild(input)
  input.onchange = () => {
    const file = input.files?.[0]
    void Promise.resolve(file ? onChoose(file) : undefined).finally(() => input.remove())
  }
  input.oncancel = () => input.remove()
  input.click()
}

/** 电脑图片存进用户 Vault(品牌素材),返回相对路径;头像只在本机绘制,不上传。 */
export async function saveXhsAvatarToVault(plugin: AiLinziPlugin, file: File): Promise<string> {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png'
  const folder = normalizePath(`${plugin.settings.outputFolder || 'AI霖子输出'}/品牌素材`)
  const parts = folder.split('/')
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current).catch(() => {})
    }
  }
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let path = normalizePath(`${folder}/${stamp}_X头像.${safeExt}`)
  for (let index = 2; plugin.app.vault.getAbstractFileByPath(path); index++) {
    path = normalizePath(`${folder}/${stamp}_X头像_${index}.${safeExt}`)
  }
  await plugin.app.vault.createBinary(path, await file.arrayBuffer())
  return path
}

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

        const avatarRow = this.identityEl.createDiv({ cls: 'ai-linzi-xhs-identity-row' })
        avatarRow.createSpan({ text: '头像' })
        const avatarControls = avatarRow.createDiv({ cls: 'ai-linzi-xhs-avatar-controls' })
        const avatarStatus = this.identityEl.createDiv({ cls: 'ai-linzi-xhs-avatar-status' })
        const refreshAvatar = () => {
          const path = this.plugin.settings.xhsCardAvatarPath
          if (!path) {
            avatarStatus.setText('未设置头像——将使用昵称首字的蓝色圆标(可选)')
          } else if (this.plugin.app.vault.getAbstractFileByPath(normalizePath(path))) {
            avatarStatus.setText(`当前头像:${path}`)
          } else {
            avatarStatus.setText(`原头像已不存在(${path}),请重新选择`)
          }
        }
        const setAvatar = async (path: string) => {
          this.plugin.settings.xhsCardAvatarPath = path
          await this.plugin.saveSettings()
          refreshAvatar()
        }
        avatarControls.createEl('button', { text: '从 Vault 选' }).addEventListener('click', () => {
          new VaultImageBrowserModal(this.app, async (file) => {
            await setAvatar(file.path)
          }).open()
        })
        avatarControls.createEl('button', { text: '从电脑上传' }).addEventListener('click', () => {
          chooseXhsAvatarFile(async (file) => {
            try {
              await setAvatar(await saveXhsAvatarToVault(this.plugin, file))
              new Notice('✅ 头像已保存到你的 Vault,生成卡片时在本机绘制,不会上传')
            } catch (error) {
              new Notice(`头像保存失败:${error instanceof Error ? error.message : String(error)}`, 8000)
            }
          })
        })
        avatarControls.createEl('button', { text: '清除' }).addEventListener('click', () => {
          void setAvatar('')
        })
        refreshAvatar()

        this.identityEl.createDiv({
          cls: 'ai-linzi-wtheme-hint',
          text: '填一次会记住,随时可在 设置 → AI霖子 → 小红书卡片 修改。',
        })
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

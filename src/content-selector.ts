import { App, Modal, Notice, TFile } from 'obsidian'

export interface AuthorizedContentLimits {
  maxFiles: number
  maxTotalChars: number
  maxPerFileChars: number
}

export interface AuthorizedContentSelection {
  paths: string[]
  totalChars: number
}

/**
 * 用户主动授权的本地内容选择器。
 *
 * 搜索与勾选全部发生在用户自己的 Vault；只有最终确认的 Markdown 笔记正文会在发消息时
 * 随本轮请求发送。选择器不保存正文，也不会自动扫描或上传整个 Vault。
 */
export class AuthorizedContentModal extends Modal {
  private readonly files: TFile[]
  private readonly selected: Set<string>
  private searchText = ''
  private submitted = false
  private listEl!: HTMLElement
  private summaryEl!: HTMLElement
  private searchEl!: HTMLInputElement
  private resolve!: (value: AuthorizedContentSelection | null) => void
  readonly result: Promise<AuthorizedContentSelection | null>

  constructor(
    app: App,
    initialPaths: string[],
    private readonly limits: AuthorizedContentLimits,
  ) {
    super(app)
    this.files = app.vault
      .getMarkdownFiles()
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    const available = new Set(this.files.map((file) => file.path))
    this.selected = new Set(initialPaths.filter((path) => available.has(path)))
    this.result = new Promise((resolve) => (this.resolve = resolve))
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-content-selector-modal')
    this.titleEl.setText('选择要交给 AI霖子的内容')

    this.contentEl.createDiv({
      cls: 'ai-linzi-content-selector-note',
      text:
        `搜索和勾选只在你的 Obsidian 本地进行。确认后，最多 ${this.limits.maxFiles} 篇、` +
        `合计 ${formatCharLimit(this.limits.maxTotalChars)}字的正文会供当前对话使用；` +
        '新建对话或清除选择后即停止带入。',
    })

    const folderRow = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-folder-row' })
    const folderSelect = folderRow.createEl('select', {
      cls: 'dropdown ai-linzi-content-selector-folder',
      attr: { 'aria-label': '选择文件夹' },
    })
    for (const folder of this.folderOptions()) {
      folderSelect.createEl('option', {
        value: folder,
        text: folder === '/' ? 'Vault 根目录（仅根目录笔记）' : folder,
      })
    }
    const addFolderBtn = folderRow.createEl('button', { text: '添加整个文件夹' })
    addFolderBtn.onclick = () => this.addFolder(folderSelect.value)

    const searchRow = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-search-row' })
    this.searchEl = searchRow.createEl('input', {
      type: 'search',
      cls: 'ai-linzi-content-selector-search',
      attr: {
        placeholder: '按笔记标题或路径搜索（本地搜索，不消耗 AI 用量）',
        'aria-label': '搜索笔记标题或路径',
      },
    })
    this.searchEl.oninput = () => {
      this.searchText = this.searchEl.value.trim().toLocaleLowerCase()
      this.renderList()
    }
    const clearSearchBtn = searchRow.createEl('button', { text: '清除搜索' })
    clearSearchBtn.onclick = () => {
      this.searchText = ''
      this.searchEl.value = ''
      this.renderList()
      this.searchEl.focus()
    }

    this.summaryEl = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-summary' })
    this.listEl = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-list' })
    this.renderList()

    const footer = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-footer' })
    const clearBtn = footer.createEl('button', { text: '清空选择' })
    clearBtn.onclick = () => {
      this.selected.clear()
      this.renderList()
    }
    const cancelBtn = footer.createEl('button', { text: '取消' })
    cancelBtn.onclick = () => this.close()
    const confirmBtn = footer.createEl('button', {
      text: '授权给当前对话',
      cls: 'mod-cta',
    })
    confirmBtn.onclick = () => void this.confirm()

    this.searchEl.focus()
  }

  private folderOptions(): string[] {
    const folders = new Set<string>(['/'])
    for (const file of this.files) {
      const parts = file.path.split('/')
      parts.pop()
      for (let index = 1; index <= parts.length; index++) {
        folders.add(parts.slice(0, index).join('/'))
      }
    }
    return [...folders].sort((left, right) => {
      if (left === '/') return -1
      if (right === '/') return 1
      return left.localeCompare(right, 'zh-CN')
    })
  }

  private addFolder(folder: string): void {
    const matches = this.files.filter((file) => {
      if (folder === '/') return !file.path.includes('/')
      return file.path.startsWith(`${folder}/`)
    })
    if (matches.length === 0) {
      new Notice('这个文件夹里没有 Markdown 笔记')
      return
    }
    const additions = matches.filter((file) => !this.selected.has(file.path))
    if (this.selected.size + additions.length > this.limits.maxFiles) {
      new Notice(
        `这个文件夹有 ${matches.length} 篇笔记，超过单次最多 ${this.limits.maxFiles} 篇。` +
        '请先搜索关键词，再勾选本次真正需要的笔记。',
        7000,
      )
      return
    }
    for (const file of additions) this.selected.add(file.path)
    this.renderList()
  }

  private visibleFiles(): TFile[] {
    if (!this.searchText) return this.files.slice(0, 200)
    return this.files
      .filter((file) => file.path.toLocaleLowerCase().includes(this.searchText))
      .slice(0, 200)
  }

  private renderList(): void {
    this.summaryEl?.setText(
      `已选 ${this.selected.size}/${this.limits.maxFiles} 篇` +
      (this.files.length > 200 && !this.searchText
        ? ` · Vault 共 ${this.files.length} 篇，当前先显示前 200 篇，可搜索定位`
        : ''),
    )
    if (!this.listEl) return
    this.listEl.empty()
    const visible = this.visibleFiles()
    if (visible.length === 0) {
      this.listEl.createDiv({
        cls: 'ai-linzi-content-selector-empty',
        text: '没有找到匹配的 Markdown 笔记',
      })
      return
    }
    for (const file of visible) {
      const row = this.listEl.createEl('label', { cls: 'ai-linzi-content-selector-row' })
      const checkbox = row.createEl('input', { type: 'checkbox' })
      checkbox.checked = this.selected.has(file.path)
      checkbox.onchange = () => {
        if (checkbox.checked && this.selected.size >= this.limits.maxFiles) {
          checkbox.checked = false
          new Notice(`单次最多选择 ${this.limits.maxFiles} 篇笔记`)
          return
        }
        if (checkbox.checked) this.selected.add(file.path)
        else this.selected.delete(file.path)
        this.renderList()
      }
      row.createSpan({ text: file.path })
    }
  }

  private async confirm(): Promise<void> {
    if (this.selected.size === 0) {
      new Notice('请至少选择一篇笔记')
      return
    }
    let totalChars = 0
    for (const path of this.selected) {
      const file = this.app.vault.getAbstractFileByPath(path)
      if (!(file instanceof TFile)) continue
      const text = await this.app.vault.cachedRead(file)
      if (text.length > this.limits.maxPerFileChars) {
        new Notice(
          `《${file.basename}》有 ${text.length.toLocaleString('zh-CN')} 字，超过单篇上限 ` +
          `${this.limits.maxPerFileChars.toLocaleString('zh-CN')} 字。请先拆分或改选其他笔记。`,
          8000,
        )
        return
      }
      totalChars += text.length
    }
    if (totalChars > this.limits.maxTotalChars) {
      new Notice(
        `已选内容共 ${totalChars.toLocaleString('zh-CN')} 字，超过单次上限 ` +
        `${this.limits.maxTotalChars.toLocaleString('zh-CN')} 字。请减少几篇后再确认。`,
        8000,
      )
      return
    }
    this.submitted = true
    this.resolve({ paths: [...this.selected], totalChars })
    this.close()
  }

  onClose(): void {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

function formatCharLimit(value: number): string {
  if (value >= 10_000 && value % 10_000 === 0) return `${value / 10_000} 万`
  return value.toLocaleString('zh-CN')
}

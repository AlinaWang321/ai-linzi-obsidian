import { App, Modal, Notice, TFile, TFolder } from 'obsidian'

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
 * 文件夹浏览、搜索与勾选全部发生在用户自己的 Vault；只有最终确认的 Markdown
 * 笔记正文会在发消息时随本轮请求发送。选择器不保存正文，也不会自动上传整个 Vault。
 */
export class AuthorizedContentModal extends Modal {
  private readonly files: TFile[]
  private readonly folders: TFolder[]
  private readonly foldersByParent: Map<string, TFolder[]>
  private readonly selected: Set<string>
  private readonly expandedFolders = new Set<string>([''])
  private currentFolderPath = ''
  private searchText = ''
  private submitted = false
  private folderTreeEl!: HTMLElement
  private browserTitleEl!: HTMLElement
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
    this.folders = app.vault
      .getAllLoadedFiles()
      .filter((entry): entry is TFolder => entry instanceof TFolder && entry.path.length > 0)
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    this.foldersByParent = groupFoldersByParent(this.folders)
    const available = new Set(this.files.map((file) => file.path))
    this.selected = new Set(initialPaths.filter((path) => available.has(path)))
    this.result = new Promise((resolve) => (this.resolve = resolve))
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-content-selector-modal')
    this.titleEl.setText('选择文件')

    this.contentEl.createDiv({
      cls: 'ai-linzi-content-selector-note',
      text:
        `像电脑文件管理器一样按 Vault 文件夹查找笔记。确认后，最多 ${this.limits.maxFiles} 篇、` +
        `合计 ${formatCharLimit(this.limits.maxTotalChars)}字的正文会供当前对话使用；` +
        '浏览和搜索均在本地完成，不消耗 AI 用量。',
    })

    const searchRow = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-search-row' })
    this.searchEl = searchRow.createEl('input', {
      type: 'search',
      cls: 'ai-linzi-content-selector-search',
      attr: {
        placeholder: '搜索全部笔记的标题或路径',
        'aria-label': '搜索全部笔记的标题或路径',
      },
    })
    this.searchEl.oninput = () => {
      this.searchText = this.searchEl.value.trim().toLocaleLowerCase()
      this.renderFiles()
    }
    const clearSearchBtn = searchRow.createEl('button', { text: '清除搜索' })
    clearSearchBtn.onclick = () => {
      this.searchText = ''
      this.searchEl.value = ''
      this.renderFiles()
      this.searchEl.focus()
    }

    this.summaryEl = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-summary' })
    const browser = this.contentEl.createDiv({ cls: 'ai-linzi-vault-browser' })
    const folderPane = browser.createDiv({ cls: 'ai-linzi-vault-browser-folders' })
    folderPane.createEl('strong', { text: 'Vault 文件夹' })
    this.folderTreeEl = folderPane.createDiv({ cls: 'ai-linzi-vault-browser-folder-tree' })

    const filePane = browser.createDiv({ cls: 'ai-linzi-vault-browser-files' })
    const fileHeader = filePane.createDiv({ cls: 'ai-linzi-vault-browser-file-header' })
    this.browserTitleEl = fileHeader.createEl('strong')
    const addFolderBtn = fileHeader.createEl('button', { text: '添加当前文件夹' })
    addFolderBtn.title = '选择当前文件夹及所有子文件夹中的 Markdown 笔记'
    addFolderBtn.onclick = () => this.addCurrentFolder()
    this.listEl = filePane.createDiv({ cls: 'ai-linzi-content-selector-list' })

    this.renderFolders()
    this.renderFiles()

    const footer = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-footer' })
    const clearBtn = footer.createEl('button', { text: '清空选择' })
    clearBtn.onclick = () => {
      this.selected.clear()
      this.renderFiles()
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

  private renderFolders(): void {
    if (!this.folderTreeEl) return
    this.folderTreeEl.empty()
    this.renderFolderButton('', 'Vault', 0)
    if (this.expandedFolders.has('')) this.renderFolderChildren('', 1)
  }

  private renderFolderChildren(parentPath: string, depth: number): void {
    for (const folder of this.foldersByParent.get(parentPath) ?? []) {
      this.renderFolderButton(folder.path, folder.name, depth)
      if (this.expandedFolders.has(folder.path)) {
        this.renderFolderChildren(folder.path, depth + 1)
      }
    }
  }

  private renderFolderButton(path: string, label: string, depth: number): void {
    const hasChildren = (this.foldersByParent.get(path)?.length ?? 0) > 0
    const expanded = hasChildren && this.expandedFolders.has(path)
    const button = this.folderTreeEl.createEl('button', {
      cls: 'ai-linzi-vault-browser-folder',
    })
    button.style.setProperty('--folder-depth', String(depth))
    button.toggleClass('is-active', path === this.currentFolderPath)
    if (hasChildren) button.setAttr('aria-expanded', String(expanded))
    button.setAttr(
      'aria-label',
      `${label}${hasChildren ? `，${expanded ? '点击收起' : '点击展开'}` : ''}`,
    )
    const count = this.files.filter((file) => isInsideFolder(file, path)).length
    const main = button.createSpan({ cls: 'ai-linzi-vault-browser-folder-main' })
    main.createSpan({
      text: hasChildren ? (expanded ? '▾' : '▸') : '',
      cls: 'ai-linzi-vault-browser-chevron',
    })
    main.createSpan({ text: path ? (expanded ? '📂' : '📁') : '🗂️' })
    main.createSpan({ text: label, cls: 'ai-linzi-vault-browser-folder-label' })
    button.createSpan({ text: String(count), cls: 'ai-linzi-vault-browser-count' })
    button.onclick = () => {
      this.currentFolderPath = path
      if (hasChildren) {
        if (expanded) this.expandedFolders.delete(path)
        else this.expandedFolders.add(path)
      }
      this.searchText = ''
      this.searchEl.value = ''
      this.renderFolders()
      this.renderFiles()
    }
  }

  private addCurrentFolder(): void {
    const matches = this.files.filter((file) => isInsideFolder(file, this.currentFolderPath))
    if (matches.length === 0) {
      new Notice('这个文件夹及其子文件夹里没有 Markdown 笔记')
      return
    }
    const additions = matches.filter((file) => !this.selected.has(file.path))
    if (additions.length === 0) {
      new Notice(`「${folderLabel(this.currentFolderPath)}」中的笔记已经全部选中`)
      return
    }
    if (this.selected.size + additions.length > this.limits.maxFiles) {
      new Notice(
        `「${folderLabel(this.currentFolderPath)}」共有 ${matches.length} 篇笔记，` +
        `超过单次最多 ${this.limits.maxFiles} 篇。请进入子文件夹或逐篇勾选。`,
        8000,
      )
      return
    }
    for (const file of additions) this.selected.add(file.path)
    new Notice(`已添加「${folderLabel(this.currentFolderPath)}」中的 ${additions.length} 篇笔记`)
    this.renderFiles()
  }

  private visibleFiles(): TFile[] {
    if (this.searchText) {
      return this.files.filter((file) =>
        file.path.toLocaleLowerCase().includes(this.searchText),
      )
    }
    return this.files.filter(
      (file) => normalizeFolderPath(file.parent?.path ?? '') === this.currentFolderPath,
    )
  }

  private renderFiles(): void {
    this.summaryEl?.setText(
      `已选 ${this.selected.size}/${this.limits.maxFiles} 篇 · Vault 共 ${this.files.length} 篇`,
    )
    if (!this.listEl) return
    const visible = this.visibleFiles()
    this.browserTitleEl.setText(
      this.searchText ? `搜索结果（${visible.length}）` : folderLabel(this.currentFolderPath),
    )
    this.listEl.empty()
    if (visible.length === 0) {
      this.listEl.createDiv({
        cls: 'ai-linzi-content-selector-empty',
        text: this.searchText
          ? '没有找到匹配的 Markdown 笔记'
          : '这个文件夹没有直接存放 Markdown 笔记，可进入左侧子文件夹查看',
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
        this.renderFiles()
      }
      const meta = row.createDiv({ cls: 'ai-linzi-content-selector-file-meta' })
      meta.createSpan({ text: file.basename, cls: 'ai-linzi-content-selector-file-name' })
      meta.createSpan({ text: file.path, cls: 'ai-linzi-content-selector-file-path' })
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

function isInsideFolder(file: TFile, folderPath: string): boolean {
  if (!folderPath) return true
  return file.path.startsWith(`${folderPath}/`)
}

function groupFoldersByParent(folders: TFolder[]): Map<string, TFolder[]> {
  const grouped = new Map<string, TFolder[]>()
  for (const folder of folders) {
    const parentPath = normalizeFolderPath(folder.parent?.path ?? '')
    const siblings = grouped.get(parentPath) ?? []
    siblings.push(folder)
    grouped.set(parentPath, siblings)
  }
  return grouped
}

function normalizeFolderPath(path: string): string {
  return path === '/' ? '' : path
}

function folderLabel(path: string): string {
  return path ? `📁 ${path}` : '🗂️ Vault 根目录'
}

function formatCharLimit(value: number): string {
  if (value >= 10_000 && value % 10_000 === 0) return `${value / 10_000} 万`
  return value.toLocaleString('zh-CN')
}

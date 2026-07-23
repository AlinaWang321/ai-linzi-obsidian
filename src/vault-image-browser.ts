import { App, Modal, Notice, TFile, TFolder } from 'obsidian'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])

/** 用 Vault 真实目录结构浏览图片；选择和预览均只发生在本地。 */
export class VaultImageBrowserModal extends Modal {
  private readonly files: TFile[]
  private readonly folders: TFolder[]
  private readonly foldersByParent: Map<string, TFolder[]>
  private readonly expandedFolders = new Set<string>([''])
  private currentFolderPath = ''
  private searchText = ''
  private folderTreeEl!: HTMLElement
  private browserTitleEl!: HTMLElement
  private imageGridEl!: HTMLElement
  private searchEl!: HTMLInputElement

  constructor(
    app: App,
    private readonly onChoose: (file: TFile) => void | Promise<void>,
  ) {
    super(app)
    this.files = app.vault
      .getFiles()
      .filter((file) => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()))
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    this.folders = app.vault
      .getAllLoadedFiles()
      .filter((entry): entry is TFolder => entry instanceof TFolder && entry.path.length > 0)
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    this.foldersByParent = groupFoldersByParent(this.folders)
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-vault-image-modal')
    this.titleEl.setText('从 Vault 选择图片')
    this.contentEl.createDiv({
      cls: 'ai-linzi-content-selector-note',
      text: `Vault 共找到 ${this.files.length} 张 PNG、JPG 或 WebP 图片。可按文件夹浏览，也可搜索文件名或路径。`,
    })

    const searchRow = this.contentEl.createDiv({ cls: 'ai-linzi-content-selector-search-row' })
    this.searchEl = searchRow.createEl('input', {
      type: 'search',
      cls: 'ai-linzi-content-selector-search',
      attr: { placeholder: '搜索全部图片的文件名或路径', 'aria-label': '搜索 Vault 图片' },
    })
    this.searchEl.oninput = () => {
      this.searchText = this.searchEl.value.trim().toLocaleLowerCase()
      this.renderImages()
    }
    const clearButton = searchRow.createEl('button', { text: '清除搜索' })
    clearButton.onclick = () => {
      this.searchText = ''
      this.searchEl.value = ''
      this.renderImages()
    }

    const browser = this.contentEl.createDiv({ cls: 'ai-linzi-vault-browser' })
    const folderPane = browser.createDiv({ cls: 'ai-linzi-vault-browser-folders' })
    folderPane.createEl('strong', { text: 'Vault 文件夹' })
    this.folderTreeEl = folderPane.createDiv({ cls: 'ai-linzi-vault-browser-folder-tree' })

    const filePane = browser.createDiv({ cls: 'ai-linzi-vault-browser-files' })
    const header = filePane.createDiv({ cls: 'ai-linzi-vault-browser-file-header' })
    this.browserTitleEl = header.createEl('strong')
    this.imageGridEl = filePane.createDiv({ cls: 'ai-linzi-vault-image-grid' })

    this.renderFolders()
    this.renderImages()
    this.searchEl.focus()
  }

  private renderFolders(): void {
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
      this.renderImages()
    }
  }

  private visibleImages(): TFile[] {
    if (this.searchText) {
      return this.files.filter((file) =>
        file.path.toLocaleLowerCase().includes(this.searchText),
      )
    }
    return this.files.filter(
      (file) => normalizeFolderPath(file.parent?.path ?? '') === this.currentFolderPath,
    )
  }

  private renderImages(): void {
    const visible = this.visibleImages()
    this.browserTitleEl.setText(
      this.searchText
        ? `搜索结果（${visible.length}）`
        : this.currentFolderPath
          ? `📁 ${this.currentFolderPath}`
          : '🗂️ Vault 根目录',
    )
    this.imageGridEl.empty()
    if (visible.length === 0) {
      this.imageGridEl.createDiv({
        cls: 'ai-linzi-content-selector-empty',
        text: this.searchText
          ? '没有找到匹配的图片'
          : '这个文件夹没有直接存放图片，可进入左侧子文件夹查看',
      })
      return
    }
    for (const file of visible) {
      const card = this.imageGridEl.createEl('button', { cls: 'ai-linzi-vault-image-card' })
      card.createEl('img', {
        attr: { src: this.app.vault.getResourcePath(file), alt: file.basename, loading: 'lazy' },
      })
      card.createSpan({ text: file.basename, cls: 'ai-linzi-vault-image-name' })
      card.createSpan({ text: file.path, cls: 'ai-linzi-vault-image-path' })
      card.onclick = () => {
        card.disabled = true
        void Promise.resolve(this.onChoose(file))
          .then(() => this.close())
          .catch((error) => {
            card.disabled = false
            new Notice(`图片读取失败：${error instanceof Error ? error.message : String(error)}`)
          })
      }
    }
  }

  onClose(): void {
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

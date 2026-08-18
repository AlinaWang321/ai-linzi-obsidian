import { FuzzySuggestModal, Notice, TFile } from 'obsidian'
import type AiLinziPlugin from './main'
import { stripFrontmatter } from './article-format'
import { readLocalDocumentText } from './long-document'

/**
 * 逐字稿技能（销售复盘/客户咨询简报）的候选格式固定为这四种，
 * 与 0.7.42 起放宽的通用 Vault 搜索白名单（含 HTML/PPTX）刻意脱钩：
 * 幻灯片和网页存档不是逐字稿，混进候选列表只会添乱。
 */
const TRANSCRIPT_EXTENSIONS = new Set(['md', 'txt', 'pdf', 'docx'])

function isTranscriptExtension(extension: string): boolean {
  return TRANSCRIPT_EXTENSIONS.has(extension.toLocaleLowerCase())
}

export interface SelectedTranscript {
  file: TFile
  text: string
}

class TranscriptFileModal extends FuzzySuggestModal<TFile> {
  private submitted = false
  private resolve!: (file: TFile | null) => void
  readonly result = new Promise<TFile | null>((resolve) => {
    this.resolve = resolve
  })

  constructor(
    app: AiLinziPlugin['app'],
    private readonly files: TFile[],
    private readonly modalTitle: string,
  ) {
    super(app)
    this.limit = 80
    this.emptyStateText = '没有找到可处理的 MD、TXT、PDF 或 DOCX 文件'
    this.setPlaceholder('输入文件名或 Vault 路径搜索逐字稿')
    this.setInstructions([
      { command: '↑↓', purpose: '选择' },
      { command: '↵', purpose: '确认' },
      { command: 'esc', purpose: '取消' },
    ])
    this.open()
  }

  onOpen(): void {
    super.onOpen()
    this.titleEl.setText(this.modalTitle)
  }

  getItems(): TFile[] {
    return this.files
  }

  getItemText(file: TFile): string {
    return `${file.basename} ${file.extension.toLocaleUpperCase()} ${file.path}`
  }

  renderSuggestion(match: { item: TFile }, element: HTMLElement): void {
    const file = match.item
    element.createDiv({
      text: `${file.basename} · ${file.extension.toLocaleUpperCase()}`,
      cls: 'ai-linzi-transcript-source-name',
    })
    element.createEl('small', { text: file.path, cls: 'ai-linzi-transcript-source-path' })
  }

  onChooseItem(file: TFile): void {
    this.submitted = true
    this.resolve(file)
  }

  onClose(): void {
    super.onClose()
    if (!this.submitted) this.resolve(null)
  }
}

/**
 * 用户每次主动选择并锁定一份逐字稿。提取全程发生在本地；只有提取后的文字会随本次
 * 技能请求发送，原始 Word/PDF/TXT 文件不会上传或写入 AI霖子数据库。
 */
export async function selectTranscriptSource(
  plugin: AiLinziPlugin,
  skillName: string,
  maxChars: number,
): Promise<SelectedTranscript | null> {
  const active = plugin.app.workspace.getActiveFile()
  const current = active && isTranscriptExtension(active.extension)
    ? active
    : plugin.rememberCurrentMarkdownFile()
  const currentPath =
    current && isTranscriptExtension(current.extension) ? current.path : undefined
  const files = plugin.app.vault
    .getFiles()
    .filter((file) => isTranscriptExtension(file.extension))
    .sort((left, right) => {
      if (left.path === currentPath) return -1
      if (right.path === currentPath) return 1
      return left.path.localeCompare(right.path, 'zh-CN')
    })
  if (files.length === 0) {
    new Notice('Vault 中没有可处理的 MD、TXT、PDF 或 DOCX 文件', 7000)
    return null
  }

  const file = await new TranscriptFileModal(
    plugin.app,
    files,
    `${skillName} · 选择一份逐字稿`,
  ).result
  if (!file) return null

  try {
    const result = await readLocalDocumentText(plugin.app, file, maxChars, 'skill')
    const text = file.extension.toLocaleLowerCase() === 'md'
      ? stripFrontmatter(result.text).trim()
      : result.text.trim()
    if (!text) {
      new Notice(`《${file.name}》没有提取到可处理的文字`, 7000)
      return null
    }
    return { file, text }
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error), 9000)
    return null
  }
}

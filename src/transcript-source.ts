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
    void super.onOpen()
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

  /**
   * Obsidian 1.13 起弹窗关闭时序变化：Enter/点击选中后 onClose 可能先于
   * onChooseItem 触发，旧实现在 onClose 里抢先把 Promise 结算成 null，真正的
   * 选中项晚一步到、被静默丢弃——表现就是「选完文件毫无反应」（2026-08-18
   * Alina 实测 + CDP 行为探针实锤，销售复盘/客户咨询简报同时中招）。
   * 在 selectSuggestion 同步捕获选中项，对任何关闭时序都成立。
   */
  selectSuggestion(match: { item: TFile }, evt: MouseEvent | KeyboardEvent): void {
    this.submitted = true
    this.resolve(match.item)
    super.selectSuggestion(match as never, evt)
  }

  onChooseItem(file: TFile): void {
    this.submitted = true
    this.resolve(file)
  }

  onClose(): void {
    super.onClose()
    // 迟一拍再判定「取消」，给尚未派发的选中回调让路（双保险，与 selectSuggestion 配合）。
    window.setTimeout(() => {
      if (!this.submitted) this.resolve(null)
    }, 0)
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
  sourceNoun = '逐字稿',
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
    plugin.reportSkillStatus(`⚠️ ${skillName}已停止：Vault 中没有可处理的 MD、TXT、PDF 或 DOCX 文件。`)
    return null
  }

  const file = await new TranscriptFileModal(
    plugin.app,
    files,
    `${skillName} · 选择一份${sourceNoun}`,
  ).result
  if (!file) return null

  try {
    const result = await readLocalDocumentText(plugin.app, file, maxChars, 'skill')
    const text = file.extension.toLocaleLowerCase() === 'md'
      ? stripFrontmatter(result.text).trim()
      : result.text.trim()
    if (!text) {
      new Notice(`《${file.name}》没有提取到可处理的文字`, 7000)
      plugin.reportSkillStatus(
        `⚠️ ${skillName}已停止：《${file.name}》没有提取到可处理的文字` +
          (file.extension.toLocaleLowerCase() === 'pdf' ? '（扫描版 PDF 暂不支持，请换文字版）。' : '。'),
      )
      return null
    }
    return { file, text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    new Notice(message, 9000)
    // 只有 toast 会被错过（2026-08-18 Alina 实测“选完文件毫无反应”），必须落进对话区。
    plugin.reportSkillStatus(`⚠️ ${skillName}已停止：${message}`)
    return null
  }
}

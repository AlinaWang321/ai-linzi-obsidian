import {
  Component,
  MarkdownRenderer,
  Modal,
  Notice,
  Setting,
  TFile,
  normalizePath,
} from 'obsidian'
import { toPng } from 'html-to-image'
import { friendlyErrorMessage } from './friendly-error'
import type AiLinziPlugin from './main'
import {
  CUSTOMER_CONSULTATION_OUTPUT_FOLDER,
  CUSTOMER_CONSULTATION_TRANSCRIPT_MAX,
  CUSTOMER_CONSULTATION_TRANSCRIPT_MIN,
  customerConsultationPngBase,
  ensureConsultationBriefHeading,
  normalizeConsultationBriefMarkdown,
  type CustomerConsultationBriefInput,
} from './customer-consultation-brief-core'
import { selectTranscriptSource } from './transcript-source'
import { stripFrontmatter } from './article-format'
import { readLocalDocumentText } from './long-document'
import { applyConsultationBriefExportStyles } from './customer-consultation-brief-style'

function fileDate(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

async function ensureFolder(plugin: AiLinziPlugin, folder: string): Promise<void> {
  const parts = normalizePath(folder).split('/')
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current).catch(() => {})
    }
  }
}

function uniquePngPath(plugin: AiLinziPlugin, folder: string, base: string): string {
  let path = normalizePath(`${folder}/${base}.png`)
  for (let index = 2; plugin.app.vault.getAbstractFileByPath(path); index++) {
    path = normalizePath(`${folder}/${base}_${index}.png`)
  }
  return path
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const encoded = dataUrl.split(',')[1] ?? ''
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function sectionIcon(title: string): { icon: string; kind: string } {
  if (title.includes('诊断')) return { icon: '🎯', kind: 'diagnosis' }
  if (title.includes('洞察')) return { icon: '💡', kind: 'insight' }
  if (title.includes('路径')) return { icon: '🗺️', kind: 'path' }
  if (title.includes('产品体系')) return { icon: '📦', kind: 'products' }
  if (title.includes('目标')) return { icon: '📊', kind: 'goal' }
  if (title.includes('总结')) return { icon: '💬', kind: 'summary' }
  if (title.includes('要做')) return { icon: '✅', kind: 'action' }
  if (title.includes('给你的话')) return { icon: '💛', kind: 'takeaway' }
  return { icon: '◆', kind: 'default' }
}

function structuredTableCards(table: HTMLTableElement): HTMLElement | null {
  const headings = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent?.trim() ?? '')
  const rows = Array.from(table.querySelectorAll('tbody tr'))
  if (rows.length === 0) return null
  const grid = createDiv()
  grid.className = 'ai-linzi-consultation-structured-grid'
  for (const row of rows) {
    const values = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() ?? '')
    const value = (label: RegExp, fallbackIndex: number) => {
      const index = headings.findIndex((heading) => label.test(heading))
      return values[index >= 0 ? index : fallbackIndex] ?? ''
    }
    const card = createDiv()
    card.className = 'ai-linzi-consultation-structured-card'
    const layer = createDiv()
    layer.className = 'ai-linzi-consultation-layer'
    layer.textContent = value(/层级|阶段/u, 0)
    const title = createDiv()
    title.className = 'ai-linzi-consultation-structured-title'
    title.textContent = value(/标题|动作|产品/u, 1)
    const price = value(/价格/u, 2)
    const description = createDiv()
    description.className = 'ai-linzi-consultation-structured-description'
    description.textContent = value(/说明/u, headings.length >= 4 ? 3 : 2)
    card.append(layer, title)
    if (price && price !== '-') {
      const priceEl = createDiv()
      priceEl.className = 'ai-linzi-consultation-price'
      priceEl.textContent = price
      card.append(priceEl)
    }
    card.append(description)
    grid.append(card)
  }
  return grid
}

function decorateConsultationCard(card: HTMLElement, body: HTMLElement, coachName: string): void {
  const title = body.querySelector('h1')
  const meta = title?.nextElementSibling?.tagName === 'BLOCKQUOTE'
    ? title.nextElementSibling
    : null
  const header = createDiv()
  header.className = 'ai-linzi-consultation-header'
  const label = createDiv()
  label.className = 'ai-linzi-consultation-header-label'
  label.textContent = 'AI-GENERATED · CONSULTATION BRIEF'
  header.append(label)
  if (title) header.append(title)
  if (meta) header.append(meta)
  card.insertBefore(header, body)

  let section = ''
  for (const element of Array.from(body.children)) {
    if (element.tagName === 'H2') {
      section = element.textContent?.trim() ?? ''
      const decoration = sectionIcon(section)
      const icon = createSpan()
      icon.className = `ai-linzi-consultation-section-icon is-${decoration.kind}`
      icon.textContent = decoration.icon
      element.prepend(icon)
      element.setAttribute('data-section', section)
      continue
    }
    if (element.tagName === 'BLOCKQUOTE') {
      const advice = section.includes('洞察')
      element.classList.add(advice ? 'ai-linzi-consultation-advice' : 'ai-linzi-consultation-summary')
      if (!advice) {
        const mark = createSpan({ cls: 'ai-linzi-consultation-quote-mark', text: '“' })
        element.prepend(mark)
      }
      if (coachName) {
        const signature = createDiv()
        signature.className = 'ai-linzi-consultation-signature'
        signature.textContent = `—— ${coachName}`
        element.append(signature)
      }
      continue
    }
    if (
      element.tagName === 'TABLE' &&
      (section.includes('路径') || section.includes('产品体系'))
    ) {
      const grid = structuredTableCards(element as HTMLTableElement)
      if (grid) element.replaceWith(grid)
    }
  }

  const footer = createDiv()
  footer.className = 'ai-linzi-consultation-footer'
  const brand = createSpan()
  brand.textContent = '由 AI 霖子生成'
  const site = createSpan()
  site.className = 'ai-linzi-consultation-footer-site'
  site.textContent = ' · chat.alinalinzi.com'
  brand.append(site)
  const date = createSpan()
  date.className = 'ai-linzi-consultation-footer-date'
  date.textContent = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  footer.append(brand, date)
  card.append(footer)
}

async function renderConsultationBriefPng(
  plugin: AiLinziPlugin,
  markdown: string,
  sourcePath: string,
  coachName: string,
): Promise<ArrayBuffer> {
  const component = new Component()
  component.load()
  const host = document.body.createDiv({ cls: 'ai-linzi-consultation-export-host' })
  const card = host.createDiv({ cls: 'ai-linzi-consultation-card' })
  const body = card.createDiv({ cls: 'ai-linzi-consultation-body markdown-rendered' })
  try {
    await MarkdownRenderer.render(plugin.app, markdown, body, sourcePath, component)
    decorateConsultationCard(card, body, coachName)
    applyConsultationBriefExportStyles(host, card, body)
    await document.fonts?.ready
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    const dataUrl = await toPng(card, {
      backgroundColor: '#fafaf7',
      pixelRatio: 2,
      cacheBust: true,
    })
    return dataUrlToArrayBuffer(dataUrl)
  } finally {
    component.unload()
    host.remove()
  }
}

class CustomerConsultationBriefModal extends Modal {
  private input: CustomerConsultationBriefInput = {
    clientName: '',
    coachName: '',
    topic: '',
    sessionInfo: '',
  }
  private submitted = false
  private resolve!: (value: CustomerConsultationBriefInput | null) => void
  readonly result = new Promise<CustomerConsultationBriefInput | null>((resolve) => {
    this.resolve = resolve
  })

  constructor(app: AiLinziPlugin['app'], private readonly sourceFile: TFile) {
    super(app)
    this.open()
  }

  onOpen(): void {
    this.titleEl.setText('客户咨询简报')
    const source = this.contentEl.createDiv({ cls: 'ai-linzi-consultation-source' })
    source.createDiv({ text: '本次只读取并锁定这一份逐字稿', cls: 'ai-linzi-consultation-source-label' })
    source.createDiv({ text: this.sourceFile.path, cls: 'ai-linzi-consultation-source-path' })
    this.contentEl.createEl('p', {
      text: '只生成给客户看的 PNG 长图；不会读取 Vault 其他笔记，也不会把逐字稿写入知识库。',
      cls: 'setting-item-description',
    })

    new Setting(this.contentEl)
      .setName('客户称呼')
      .setDesc('必填；用于图片标题和文件名，例如“客户 A”“小雨老师”。')
      .addText((text) => text.onChange((value) => (this.input.clientName = value.trim())))
    new Setting(this.contentEl)
      .setName('咨询师称呼')
      .setDesc('必填；简报会以你的专业判断署名。')
      .addText((text) => text.onChange((value) => (this.input.coachName = value.trim())))
    new Setting(this.contentEl)
      .setName('咨询主题（可选）')
      .addText((text) => text.onChange((value) => (this.input.topic = value.trim())))
    new Setting(this.contentEl)
      .setName('咨询信息（可选）')
      .setDesc('例如咨询日期、次数或时长。')
      .addText((text) => text.onChange((value) => (this.input.sessionInfo = value.trim())))

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('生成客户咨询简报 PNG')
          .setCta()
          .onClick(() => {
            if (!this.input.clientName) {
              new Notice('请填写客户称呼')
              return
            }
            if (!this.input.coachName) {
              new Notice('请填写咨询师称呼')
              return
            }
            this.submitted = true
            this.resolve({ ...this.input })
            this.close()
          }),
      )
  }

  onClose(): void {
    this.contentEl.empty()
    if (!this.submitted) this.resolve(null)
  }
}

export async function runCustomerConsultationBrief(
  plugin: AiLinziPlugin,
  lockedSourceFile?: TFile,
): Promise<string | undefined> {
  const source = lockedSourceFile
    ? await (async () => {
        try {
          const result = await readLocalDocumentText(
            plugin.app,
            lockedSourceFile,
            CUSTOMER_CONSULTATION_TRANSCRIPT_MAX,
            'skill',
          )
          const text = lockedSourceFile.extension.toLocaleLowerCase() === 'md'
            ? stripFrontmatter(result.text).trim()
            : result.text.trim()
          return text ? { file: lockedSourceFile, text } : null
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          plugin.reportSkillStatus(`⚠️ 客户咨询简报已停止：${message}`)
          new Notice(message, 9000)
          return null
        }
      })()
    : await selectTranscriptSource(
        plugin,
        '客户咨询简报',
        CUSTOMER_CONSULTATION_TRANSCRIPT_MAX,
      )
  if (!source) return undefined
  const sourceFile = source.file
  const transcript = source.text
  // 全程状态条落在对话区，与销售复盘同款（2026-08-18 Alina 反馈：只有 toast 会被错过）。
  const statusId = plugin.reportSkillStatus(
    `📋 客户咨询简报 · 已锁定逐字稿《${sourceFile.basename}》（${transcript.length.toLocaleString('zh-CN')} 字）。请在弹窗中填写客户/咨询师称呼后开始生成。`,
  )
  if (transcript.length < CUSTOMER_CONSULTATION_TRANSCRIPT_MIN) {
    new Notice(`当前逐字稿只有 ${transcript.length} 字；客户咨询简报至少需要 800 字`, 7000)
    plugin.reportSkillStatus(
      `⚠️ 客户咨询简报已停止：《${sourceFile.basename}》只有 ${transcript.length} 字，至少需要 800 字。`,
      statusId,
    )
    return sourceFile.path
  }
  if (transcript.length > CUSTOMER_CONSULTATION_TRANSCRIPT_MAX) {
    new Notice(`当前逐字稿有 ${transcript.length.toLocaleString()} 字，超过 100,000 字上限，请拆分后再生成`, 8000)
    plugin.reportSkillStatus(
      `⚠️ 客户咨询简报已停止：《${sourceFile.basename}》有 ${transcript.length.toLocaleString('zh-CN')} 字，超过 100,000 字上限，请拆分后再生成。`,
      statusId,
    )
    return sourceFile.path
  }

  const input = await new CustomerConsultationBriefModal(plugin.app, sourceFile).result
  if (!input) {
    plugin.reportSkillStatus(`已取消本次客户咨询简报，《${sourceFile.basename}》未处理。`, statusId)
    return sourceFile.path
  }
  plugin.reportSkillStatus(
    `🤖 正在生成客户咨询简报并渲染 PNG：《${sourceFile.basename}》…约 1-2 分钟，完成后会自动打开长图。`,
    statusId,
  )
  const running = new Notice('🤖 AI霖子正在生成客户咨询简报并渲染 PNG…（约 1-2 分钟）', 0)
  try {
    const response = await plugin.apiText('/api/plugin/v1/skills/consultation-brief', {
      transcript,
      clientName: input.clientName,
      coachName: input.coachName,
      topic: input.topic || undefined,
      sessionInfo: input.sessionInfo || undefined,
    })
    const markdown = ensureConsultationBriefHeading(
      normalizeConsultationBriefMarkdown(response),
      input,
    )
    if (!markdown) throw new Error('咨询简报内容格式不完整，请稍后重试')
    const png = await renderConsultationBriefPng(
      plugin,
      markdown,
      sourceFile.path,
      input.coachName,
    )
    const root = normalizePath(plugin.settings.outputFolder || 'AI霖子输出')
    const folder = normalizePath(`${root}/${CUSTOMER_CONSULTATION_OUTPUT_FOLDER}`)
    await ensureFolder(plugin, folder)
    const path = uniquePngPath(
      plugin,
      folder,
      customerConsultationPngBase(fileDate(), input.clientName),
    )
    const file = await plugin.app.vault.createBinary(path, png)
    await plugin.app.workspace.getLeaf('tab').openFile(file)
    plugin.reportSkillStatus(`✅ 客户咨询简报 PNG 已生成并打开：${path}`, statusId)
    new Notice(`✅ 客户咨询简报 PNG 已生成：${path}`, 8000)
  } catch (error) {
    const message = friendlyErrorMessage(error instanceof Error ? error.message : String(error))
    plugin.reportSkillStatus(`❌ 客户咨询简报失败：${message}`, statusId)
    new Notice(`❌ 客户咨询简报：${message}`, 9000)
  } finally {
    running.hide()
  }
  return sourceFile.path
}

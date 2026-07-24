import {
  App,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian'

const WORKFLOW_TYPE = 'workflow'
const WORKFLOW_MARKER = '<!-- AI_LINZI_WORKFLOW_INSTRUCTION -->'

export interface SavedWorkflow {
  file: TFile
  name: string
  instruction: string
  createdAt: string
  updatedAt: string
}

interface WorkflowEditorOptions {
  workflow?: SavedWorkflow
  initialName?: string
  initialInstruction?: string
}

function isoTimestamp(): string {
  return new Date().toISOString()
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function frontmatterString(markdown: string, key: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? ''
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter)
  if (!match) return ''
  const raw = match[1].trim()
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : String(parsed ?? '')
  } catch {
    return raw.replace(/^['"]|['"]$/g, '')
  }
}

export function parseWorkflowMarkdown(
  markdown: string,
  fallbackName: string,
): Omit<SavedWorkflow, 'file'> | null {
  if (frontmatterString(markdown, 'ai_linzi_type') !== WORKFLOW_TYPE) return null
  const markerAt = markdown.indexOf(WORKFLOW_MARKER)
  if (markerAt < 0) return null
  const instruction = markdown.slice(markerAt + WORKFLOW_MARKER.length).trim()
  if (!instruction) return null
  return {
    name: frontmatterString(markdown, 'name') || fallbackName,
    instruction,
    createdAt: frontmatterString(markdown, 'created_at'),
    updatedAt: frontmatterString(markdown, 'updated_at'),
  }
}

export function buildWorkflowMarkdown(args: {
  name: string
  instruction: string
  createdAt: string
  updatedAt: string
}): string {
  return [
    '---',
    `ai_linzi_type: ${WORKFLOW_TYPE}`,
    'workflow_version: 1',
    `name: ${yamlString(args.name)}`,
    `created_at: ${yamlString(args.createdAt)}`,
    `updated_at: ${yamlString(args.updatedAt)}`,
    '---',
    '',
    `# ${args.name}`,
    '',
    '> 这是你在 AI霖子插件中保存的个人工作流。你可以直接修改下方要求。',
    '',
    '## 每次执行的任务',
    WORKFLOW_MARKER,
    args.instruction.trim(),
    '',
  ].join('\n')
}

export function buildWorkflowRunPrompt(
  workflow: Pick<SavedWorkflow, 'name' | 'instruction'>,
  extraInstruction = '',
): string {
  return [
    `请执行我的固定工作流「${workflow.name}」。`,
    '',
    '工作流要求：',
    workflow.instruction.trim(),
    extraInstruction.trim() ? `\n本次补充要求：\n${extraInstruction.trim()}` : '',
    '',
    '请使用我在本轮明确授权的当前笔记和已选择文件完成任务。材料不足时直接说明需要补充什么，不要虚构。',
  ]
    .filter(Boolean)
    .join('\n')
}

async function ensureFolder(app: App, folderPath: string): Promise<string> {
  const normalized = normalizePath(folderPath.trim() || 'AI霖子工作流')
  const parts = normalized.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current = normalizePath(current ? `${current}/${part}` : part)
    const existing = app.vault.getAbstractFileByPath(current)
    if (existing instanceof TFile) throw new Error(`「${current}」已经是文件，不能作为工作流文件夹`)
    if (!existing) await app.vault.createFolder(current)
  }
  return normalized
}

async function uniqueWorkflowPath(app: App, folderPath: string, name: string): Promise<string> {
  const base = sanitizeFileName(name) || '未命名工作流'
  let path = normalizePath(`${folderPath}/${base}.md`)
  for (let index = 2; app.vault.getAbstractFileByPath(path); index++) {
    path = normalizePath(`${folderPath}/${base}_${index}.md`)
  }
  return path
}

export async function loadWorkflows(app: App, folderPath: string): Promise<SavedWorkflow[]> {
  const normalized = normalizePath(folderPath.trim() || 'AI霖子工作流')
  const folder = app.vault.getAbstractFileByPath(normalized)
  if (!(folder instanceof TFolder)) return []
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => file.path.startsWith(`${normalized}/`))
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
  const workflows: SavedWorkflow[] = []
  for (const file of files) {
    const parsed = parseWorkflowMarkdown(await app.vault.cachedRead(file), file.basename)
    if (parsed) workflows.push({ file, ...parsed })
  }
  return workflows.sort((left, right) =>
    (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt),
  )
}

async function saveWorkflow(
  app: App,
  folderPath: string,
  values: { name: string; instruction: string },
  existing?: SavedWorkflow,
): Promise<SavedWorkflow> {
  const normalizedFolder = await ensureFolder(app, folderPath)
  const now = isoTimestamp()
  const createdAt = existing?.createdAt || now
  const markdown = buildWorkflowMarkdown({
    name: values.name.trim(),
    instruction: values.instruction.trim(),
    createdAt,
    updatedAt: now,
  })
  let file = existing?.file
  if (file) {
    await app.vault.modify(file, markdown)
  } else {
    const path = await uniqueWorkflowPath(app, normalizedFolder, values.name)
    file = await app.vault.create(path, markdown)
  }
  return {
    file,
    name: values.name.trim(),
    instruction: values.instruction.trim(),
    createdAt,
    updatedAt: now,
  }
}

export class WorkflowEditorModal extends Modal {
  private name: string
  private instruction: string
  private submitted = false
  private resolve!: (value: SavedWorkflow | null) => void
  readonly result: Promise<SavedWorkflow | null>

  constructor(
    app: App,
    private readonly folderPath: string,
    private readonly options: WorkflowEditorOptions = {},
  ) {
    super(app)
    this.name = options.workflow?.name ?? options.initialName ?? ''
    this.instruction = options.workflow?.instruction ?? options.initialInstruction ?? ''
    this.result = new Promise((resolve) => (this.resolve = resolve))
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-workflow-editor-modal')
    this.titleEl.setText(this.options.workflow ? '编辑我的工作流' : '新建我的工作流')
    this.contentEl.createDiv({
      text:
        '把需要反复完成的任务保存下来。工作流文件只保存在你的 Vault，只有你点击运行时才会连同本轮授权内容发送给 AI霖子。',
      cls: 'ai-linzi-workflow-note',
    })
    new Setting(this.contentEl)
      .setName('工作流名称')
      .setDesc('例：把咨询逐字稿整理成客户洞察')
      .addText((input) => {
        input
          .setPlaceholder('给这个工作流起一个容易认出的名字')
          .setValue(this.name)
          .onChange((value) => (this.name = value))
        input.inputEl.addClass('ai-linzi-full-width')
      })
    new Setting(this.contentEl)
      .setName('每次执行的任务')
      .setDesc('用你自己的话写清楚：读取什么、怎么处理、最后交付什么。')
      .addTextArea((input) => {
        input
          .setPlaceholder('例：阅读我选择的咨询逐字稿，提炼客户背景、核心痛点、关键原话和下一步行动，按清单输出。')
          .setValue(this.instruction)
          .onChange((value) => (this.instruction = value))
        input.inputEl.rows = 10
        input.inputEl.addClass('ai-linzi-full-width')
      })
    const footer = this.contentEl.createDiv({ cls: 'ai-linzi-workflow-editor-footer' })
    const cancel = footer.createEl('button', { text: '取消' })
    cancel.onclick = () => this.close()
    const save = footer.createEl('button', { text: '保存工作流', cls: 'mod-cta' })
    save.onclick = async () => {
      if (!this.name.trim()) {
        new Notice('请填写工作流名称')
        return
      }
      if (!this.instruction.trim()) {
        new Notice('请填写每次执行的任务')
        return
      }
      save.disabled = true
      try {
        const workflow = await saveWorkflow(
          this.app,
          this.folderPath,
          { name: this.name, instruction: this.instruction },
          this.options.workflow,
        )
        this.submitted = true
        this.resolve(workflow)
        this.close()
      } catch (error) {
        new Notice(`保存工作流失败：${error instanceof Error ? error.message : String(error)}`)
        save.disabled = false
      }
    }
  }

  onClose(): void {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

export class WorkflowRunModal extends Modal {
  private extraInstruction = ''
  private submitted = false
  private resolve!: (value: string | null) => void
  readonly result: Promise<string | null>

  constructor(
    app: App,
    private readonly workflow: SavedWorkflow,
    private readonly contextDescription: string,
  ) {
    super(app)
    this.result = new Promise((resolve) => (this.resolve = resolve))
  }

  onOpen(): void {
    this.titleEl.setText(`运行「${this.workflow.name}」`)
    this.contentEl.createDiv({
      text: this.contextDescription,
      cls: 'ai-linzi-workflow-context',
    })
    this.contentEl.createDiv({
      text: this.workflow.instruction,
      cls: 'ai-linzi-workflow-preview',
    })
    new Setting(this.contentEl)
      .setName('本次补充要求（选填）')
      .setDesc('只影响这一次运行，不会改掉已保存的工作流。')
      .addTextArea((input) => {
        input
          .setPlaceholder('例：这次重点找出用户愿意付费解决的问题')
          .onChange((value) => (this.extraInstruction = value))
        input.inputEl.rows = 4
        input.inputEl.addClass('ai-linzi-full-width')
      })
    const footer = this.contentEl.createDiv({ cls: 'ai-linzi-workflow-editor-footer' })
    const cancel = footer.createEl('button', { text: '取消' })
    cancel.onclick = () => this.close()
    const run = footer.createEl('button', { text: '开始运行', cls: 'mod-cta' })
    run.onclick = () => {
      this.submitted = true
      this.resolve(this.extraInstruction.trim())
      this.close()
    }
  }

  onClose(): void {
    if (!this.submitted) this.resolve(null)
    this.contentEl.empty()
  }
}

export class WorkflowManagerModal extends Modal {
  private listEl!: HTMLElement

  constructor(
    app: App,
    private readonly folderPath: string,
    private readonly onRun: (workflow: SavedWorkflow) => Promise<void>,
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-workflow-manager-modal')
    this.titleEl.setText('我的工作流')
    this.contentEl.createDiv({
      text:
        '把常做的任务保存成自己的工作流。它们存放在你的 Vault，不会把 AI霖子的私有提示词写进插件。',
      cls: 'ai-linzi-workflow-note',
    })
    const toolbar = this.contentEl.createDiv({ cls: 'ai-linzi-workflow-toolbar' })
    toolbar.createSpan({ text: `保存位置：${normalizePath(this.folderPath || 'AI霖子工作流')}` })
    const create = toolbar.createEl('button', { text: '新建工作流', cls: 'mod-cta' })
    create.onclick = () => void this.createWorkflow()
    this.listEl = this.contentEl.createDiv({ cls: 'ai-linzi-workflow-list' })
    void this.renderList()
  }

  private async createWorkflow(): Promise<void> {
    const modal = new WorkflowEditorModal(this.app, this.folderPath)
    modal.open()
    const workflow = await modal.result
    if (!workflow) return
    new Notice(`✅ 已保存工作流「${workflow.name}」`)
    await this.renderList()
  }

  private async editWorkflow(workflow: SavedWorkflow): Promise<void> {
    const modal = new WorkflowEditorModal(this.app, this.folderPath, { workflow })
    modal.open()
    const updated = await modal.result
    if (!updated) return
    new Notice(`✅ 已更新工作流「${updated.name}」`)
    await this.renderList()
  }

  private async deleteWorkflow(workflow: SavedWorkflow): Promise<void> {
    const confirmed = window.confirm(
      `确定删除工作流「${workflow.name}」吗？\n\n文件会移到 Obsidian 回收站，可以按你的 Vault 回收站设置恢复。`,
    )
    if (!confirmed) return
    await this.app.fileManager.trashFile(workflow.file)
    new Notice(`已删除工作流「${workflow.name}」`)
    await this.renderList()
  }

  private async renderList(): Promise<void> {
    this.listEl.empty()
    this.listEl.createDiv({ text: '正在读取工作流…', cls: 'ai-linzi-workflow-empty' })
    const workflows = await loadWorkflows(this.app, this.folderPath)
    this.listEl.empty()
    if (workflows.length === 0) {
      this.listEl.createDiv({
        text: '还没有个人工作流。点击“新建工作流”，把你经常重复说的任务先保存一条。',
        cls: 'ai-linzi-workflow-empty',
      })
      return
    }
    for (const workflow of workflows) {
      const card = this.listEl.createDiv({ cls: 'ai-linzi-workflow-card' })
      const content = card.createDiv({ cls: 'ai-linzi-workflow-card-content' })
      content.createDiv({ text: workflow.name, cls: 'ai-linzi-workflow-name' })
      content.createDiv({
        text: workflow.instruction.replace(/\s+/g, ' ').slice(0, 110),
        cls: 'ai-linzi-workflow-summary',
      })
      const actions = card.createDiv({ cls: 'ai-linzi-workflow-card-actions' })
      const run = actions.createEl('button', { text: '运行', cls: 'mod-cta' })
      run.onclick = async () => {
        this.close()
        await this.onRun(workflow)
      }
      const edit = actions.createEl('button', { text: '编辑' })
      edit.onclick = () => void this.editWorkflow(workflow)
      const remove = actions.createEl('button', { text: '删除' })
      remove.onclick = () => void this.deleteWorkflow(workflow)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

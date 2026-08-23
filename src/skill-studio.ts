import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath, parseYaml } from 'obsidian'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  CREATE_LOCAL_SKILL_MAX_FILES,
  CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS,
  parsePortableSkillBundle,
  type CreateLocalSkillBlock,
} from './create-local-skill'
import {
  OFFICIAL_SKILL_TEMPLATES,
  adaptImportedSkillReadScope,
  buildSkillStudioPrompt,
  previewSkillInvocation,
  previewSkillStudioDraftInvocation,
  skillBlockManifest,
  skillInvocationPreviewText,
  skillReadScopePermission,
  skillTestInputForReadScope,
  type SkillStudioDraft,
  type SkillStudioOutput,
} from './skill-studio-core'
import type { LocalSkillDescriptor } from './local-skill-core'

export interface SkillStudioOptions {
  onCreateWithAi: (prompt: string, sampleInput: string) => void
  onOfferBundle: (block: CreateLocalSkillBlock, sampleInput: string) => void
  listInstalledSkills?: () => Promise<LocalSkillDescriptor[]>
  onUpdateWithAi?: (skill: LocalSkillDescriptor, instruction: string) => void
}

function portableExternalSkillEntry(content: string): { name: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content)
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter')
  let metadata: unknown
  try {
    metadata = parseYaml(match[1])
  } catch {
    throw new Error('SKILL.md frontmatter 不是合法 YAML')
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('SKILL.md frontmatter 顶层必须是对象')
  }
  const record = metadata as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const body = match[2].trim()
  if (!name || !description || !body) {
    throw new Error('SKILL.md 必须包含 name、description 和正文')
  }
  return {
    name,
    // Codex / WorkBuddy 等 Agent Skills 允许额外 frontmatter。AI霖子运行入口只保留
    // 跨端必需的两个公共字段，其余能力与权限改写到可见正文和 manifest v2。
    content: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`,
  }
}

function defaultDraft(): SkillStudioDraft {
  return {
    name: '',
    purpose: '',
    readScope: 'whole-vault',
    input: '按任务查找相关材料，优先使用用户点名的文件或文件夹',
    steps: '',
    triggers: [],
    output: 'create-note',
    sampleInput: '',
    version: '1.0.0',
  }
}

export class ImportedSkillPermissionModal extends Modal {
  constructor(
    app: App,
    private readonly block: CreateLocalSkillBlock,
    private readonly onConfirm: (block: CreateLocalSkillBlock, sampleInput: string) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.setTitle(`导入 Skill：${this.block.name}`)
    this.contentEl.empty()
    this.contentEl.createDiv({
      text: '这个 Skill 安装后默认可以按需读取当前整个 Vault。你在实际运行时点名某个文件或文件夹，只是让它优先查那里；不会限制后续搜索整个 Vault，也不能读取 Vault 外的电脑文件。',
      cls: 'ai-linzi-skill-studio-intro',
    })
    new Setting(this.contentEl)
      .setName('读取范围')
      .setDesc('当前整个 Obsidian Vault（默认）。运行时可用自然语言指定优先文件或文件夹。')
    const scripts = this.block.files.filter((file) => file.path.startsWith('scripts/'))
    const boundary = this.contentEl.createDiv({ cls: 'ai-linzi-skill-permissions' })
    boundary.createEl('strong', { text: '导入边界' })
    const list = boundary.createEl('ul')
    list.createEl('li', { text: '全库搜索只在本机先筛选候选，不会把整个 Vault 正文一次性上传' })
    list.createEl('li', { text: '普通写入仍先展示完整方案，用户确认一次后才执行' })
    list.createEl('li', {
      text: scripts.length > 0
        ? `检测到 ${scripts.length} 个脚本：安装不会运行；本地程序默认关闭，开启后每一步仍需确认`
        : '未检测到本机脚本',
    })
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText('生成安装确认卡')
        .setCta()
        .onClick(() => {
          const adapted = adaptImportedSkillReadScope(this.block, 'whole-vault')
          const manifest = skillBlockManifest(adapted.block)
          if (!manifest.valid) {
            new Notice(`Skill 适配后仍未通过校验：${manifest.problems.join('；')}`, 9000)
            return
          }
          this.close()
          this.onConfirm(adapted.block, skillTestInputForReadScope(adapted.block.name, 'whole-vault'))
        }))
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
  }
}

export function portableBundleFromZip(data: Uint8Array): CreateLocalSkillBlock {
  const archive = unzipSync(data)
  const rawEntries = Object.entries(archive)
    .filter(([path]) => path && !path.endsWith('/'))
    .filter(([path]) => !path.startsWith('__MACOSX/') && !path.endsWith('/.DS_Store'))
  if (rawEntries.some(([path]) => path.split('/').some((part) => part.startsWith('.')))) {
    throw new Error('ZIP 包含隐藏路径，无法导入')
  }
  if (rawEntries.length === 0 || rawEntries.length > CREATE_LOCAL_SKILL_MAX_FILES + 1) {
    throw new Error(`ZIP 必须包含 1—${CREATE_LOCAL_SKILL_MAX_FILES} 个 Skill 文本文件`)
  }
  const roots = rawEntries.map(([path]) => path.replace(/\\/g, '/').split('/')[0])
  const commonRoot = roots.every((root) => root === roots[0]) && rawEntries.every(([path]) => path.includes('/'))
    ? `${roots[0]}/`
    : ''
  const files = rawEntries
    .map(([rawPath, bytes]) => {
      const path = rawPath.replace(/\\/g, '/').slice(commonRoot.length)
      if (bytes.includes(0)) throw new Error(`ZIP 中包含二进制文件，无法导入：${path}`)
      return { path, content: strFromU8(bytes).replace(/^\uFEFF/, '').trim() }
    })
    // 兼容早期候选包：安装说明不属于 Skill 运行文件，导回时忽略。
    .filter((file) => file.path.toLocaleLowerCase() !== 'install.md')
  if (files.length === 0 || files.length > CREATE_LOCAL_SKILL_MAX_FILES) {
    throw new Error(`ZIP 必须包含 1—${CREATE_LOCAL_SKILL_MAX_FILES} 个 Skill 文本文件`)
  }
  if (files.reduce((sum, file) => sum + file.content.length, 0) > CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS) {
    throw new Error(`Skill 文本总量超过 ${CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS.toLocaleString('zh-CN')} 字`)
  }
  const entry = files.find((file) => file.path.toLocaleLowerCase() === 'skill.md')
  if (!entry) throw new Error('ZIP 根目录缺少 SKILL.md')
  const normalizedEntry = portableExternalSkillEntry(entry.content)
  const normalizedFiles = files.map((file) =>
    file === entry ? { ...file, path: 'SKILL.md', content: normalizedEntry.content } : file,
  )
  const protocol = normalizedFiles
    .map((file) => `<<<Skill文件 path=${file.path}>>>\n${file.content}\n<<<Skill文件结束>>>`)
    .join('\n')
  const parsed = parsePortableSkillBundle(normalizedEntry.name, protocol)
  if (!parsed) throw new Error('ZIP 没有通过 AI霖子 Skill 安全校验，请检查名称、frontmatter 和文件路径')
  return parsed
}

export class SkillStudioModal extends Modal {
  private draft = defaultDraft()
  private templateId = 'custom'
  private installedSkills: LocalSkillDescriptor[] = []
  private loadingInstalledSkills = false
  private selectedUpdatePath = ''
  private updateInstruction = ''

  constructor(
    app: App,
    private readonly options: SkillStudioOptions,
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('ai-linzi-skill-studio-modal')
    this.setTitle('AI霖子 Skill Studio')
    this.render()
    if (this.options.listInstalledSkills) void this.loadInstalledSkills()
  }

  private async loadInstalledSkills(): Promise<void> {
    this.loadingInstalledSkills = true
    if (this.templateId === 'update') this.render()
    try {
      this.installedSkills = await this.options.listInstalledSkills!()
      if (!this.selectedUpdatePath) this.selectedUpdatePath = this.installedSkills[0]?.path ?? ''
    } catch (error) {
      new Notice(`读取“我的 Skills”失败：${error instanceof Error ? error.message : String(error)}`, 8000)
    } finally {
      this.loadingInstalledSkills = false
      if (this.templateId === 'update') this.render()
    }
  }

  private render(): void {
    this.contentEl.empty()
    this.contentEl.createDiv({
      text: '你可以直接安装官方 Skill，也可以把自己反复做的一套工作教给 AI霖子。安装或创建前都会先展示它会读取什么、生成什么，确认后才写入。',
      cls: 'ai-linzi-skill-studio-intro',
    })

    new Setting(this.contentEl)
      .setName('选择创建方式')
      .setDesc('安装官方模板本身不消耗积分；安装后运行 Skill 会正常使用 AI 并消耗账户积分。自己创建 Skill 时也会调用 AI 生成内容。')
      .addDropdown((dropdown) => {
        dropdown.addOption('custom', '让 AI 帮我创建新 Skill')
        if (this.options.onUpdateWithAi) dropdown.addOption('update', '更新已经安装的 Skill')
        for (const template of OFFICIAL_SKILL_TEMPLATES) {
          dropdown.addOption(template.id, `直接安装 · ${template.label}`)
        }
        dropdown.setValue(this.templateId).onChange((value) => {
          this.templateId = value
          this.render()
        })
      })

    if (this.templateId === 'update') {
      this.renderUpdateForm()
      return
    }

    const template = OFFICIAL_SKILL_TEMPLATES.find((item) => item.id === this.templateId)
    if (template) {
      let templateSampleInput = template.sampleInput
      let templatePreviewEl: HTMLDivElement | undefined
      const refreshTemplatePreview = () => {
        templatePreviewEl?.setText(
          skillInvocationPreviewText(
            previewSkillInvocation(template.block, templateSampleInput || template.sampleInput),
          ),
        )
      }
      this.contentEl.createEl('h3', { text: template.label })
      this.contentEl.createDiv({ text: template.description, cls: 'ai-linzi-skill-studio-intro' })
      const permissionCard = this.contentEl.createDiv({ cls: 'ai-linzi-skill-permissions' })
      permissionCard.createEl('strong', { text: '运行这个 Skill 时，AI霖子会做这些事' })
      const list = permissionCard.createEl('ul')
      for (const permission of template.permissions) list.createEl('li', { text: permission })
      permissionCard.createDiv({ text: '官方版本 1.1.0 · 不包含可执行脚本', cls: 'ai-linzi-skill-studio-meta' })
      new Setting(this.contentEl)
        .setName('推荐调用示例')
        .setDesc('安装后可以直接用这句话测试，也可以换成意思相近的自然说法。')
        .addText((input) => input
          .setValue(template.sampleInput)
          .onChange((value) => {
            templateSampleInput = value.trim()
            refreshTemplatePreview()
          }))
      templatePreviewEl = this.contentEl.createDiv({ cls: 'ai-linzi-skill-invocation-preview' })
      refreshTemplatePreview()
      new Setting(this.contentEl)
        .addButton((button) => button
          .setButtonText('查看详情并安装')
          .setCta()
          .onClick(() => {
            this.close()
            this.options.onOfferBundle(template.block, templateSampleInput || template.sampleInput)
          }))
        .addButton((button) => button
          .setButtonText('导入 Skill ZIP')
          .onClick(() => this.pickZip()))
      return
    }

    let draftPreviewEl: HTMLDivElement | undefined
    const refreshDraftPreview = () => {
      draftPreviewEl?.setText(
        skillInvocationPreviewText(previewSkillStudioDraftInvocation(this.draft)),
      )
    }

    new Setting(this.contentEl)
      .setName('英文名称')
      .setDesc('小写英文或拼音，用短横线连接，例如 client-follow-up。升级旧 Skill 时请使用新名称，避免覆盖。')
      .addText((input) => input
        .setPlaceholder('client-follow-up')
        .setValue(this.draft.name)
        .onChange((value) => {
          this.draft.name = value.trim()
          refreshDraftPreview()
        }))
    new Setting(this.contentEl)
      .setName('这套 Skill 解决什么问题')
      .addTextArea((input) => input
        .setPlaceholder('例如：每次咨询后，提炼共识、行动项并生成一份客户简报')
        .setValue(this.draft.purpose)
        .onChange((value) => (this.draft.purpose = value.trim())))
    new Setting(this.contentEl)
      .setName('读取范围')
      .setDesc('默认可按需读取当前整个 Vault；运行时点名文件或文件夹只用于加快当次搜索。')
    new Setting(this.contentEl)
      .setName('输入材料说明')
      .setDesc('描述要找什么材料、优先看哪里；模型找不到时仍可继续搜索整个 Vault。')
      .addTextArea((input) => input
        .setValue(this.draft.input)
        .onChange((value) => (this.draft.input = value.trim())))
    new Setting(this.contentEl)
      .setName('关键步骤')
      .addTextArea((input) => input
        .setPlaceholder('用换行写清楚 3—6 步，包含事实边界和验收标准')
        .setValue(this.draft.steps)
        .onChange((value) => (this.draft.steps = value.trim())))
      new Setting(this.contentEl)
        .setName('自动识别的调用说法')
        .setDesc('填完整动作句并用逗号分隔；完全命中时会自动调用。无论这里怎么填，只要明确说“用/调用 + Skill 名称”，后面用自然说法描述材料也能调用。')
      .addText((input) => input
        .setPlaceholder('生成客户简报,整理本次咨询行动项')
        .setValue(this.draft.triggers.join(','))
        .onChange((value) => {
          this.draft.triggers = value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean)
          refreshDraftPreview()
        }))
    new Setting(this.contentEl)
      .setName('输出方式')
      .addDropdown((dropdown) => dropdown
        .addOption('chat', '只在聊天中预览')
        .addOption('create-note', '确认后新建笔记')
        .addOption('update-current-note', '确认后更新当前笔记')
        .addOption('create-artifact', '确认后生成 HTML / Word / PDF / PPT / Excel')
        .setValue(this.draft.output)
        .onChange((value) => (this.draft.output = value as SkillStudioOutput)))
    new Setting(this.contentEl)
      .setName('版本')
      .setDesc('第一次用 1.0.0；升级旧 Skill 建议用 2.0.0 并换新名称。')
      .addText((input) => input
        .setValue(this.draft.version)
        .onChange((value) => (this.draft.version = value.trim())))
      new Setting(this.contentEl)
        .setName('创建后测试示例')
        .setDesc('这不是固定触发词。创建成功后点“立即试运行”，会自动填入这句话，你也可以再修改。')
      .addText((input) => input
        .setPlaceholder('例如：把当前咨询记录生成客户简报')
        .setValue(this.draft.sampleInput)
        .onChange((value) => {
          this.draft.sampleInput = value.trim()
          refreshDraftPreview()
        }))
    draftPreviewEl = this.contentEl.createDiv({ cls: 'ai-linzi-skill-invocation-preview' })
    refreshDraftPreview()

    const permissions = this.contentEl.createDiv({ cls: 'ai-linzi-skill-permissions' })
    permissions.createEl('strong', { text: '本版默认权限' })
    const permissionList = permissions.createEl('ul')
    permissionList.createEl('li', {
      text: skillReadScopePermission(this.draft.readScope ?? 'whole-vault'),
    })
    permissionList.createEl('li', { text: '读取权限只到当前 Vault，不能访问电脑其他目录' })
    permissionList.createEl('li', { text: this.draft.output === 'chat' ? '不写文件' : '写入前展示全文并再次确认' })
    permissionList.createEl('li', { text: '不生成或运行本机脚本' })
    permissionList.createEl('li', { text: '先用本机目录与索引筛选，只向 AI 提交完成任务所需的文件内容' })

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText('让 AI 创建并生成确认卡')
        .setCta()
        .onClick(() => this.submitCustom()))
      .addButton((button) => button
        .setButtonText('导入 Skill ZIP')
        .onClick(() => this.pickZip()))
  }

  private renderUpdateForm(): void {
    this.contentEl.createEl('h3', { text: '安全更新已有 Skill' })
    this.contentEl.createDiv({
      text: 'AI 只会生成更新提案。你会先看到每个文件的修改前后全文；删除文件还要单独确认。确认时若原文件已有变化，整次更新会自动取消。',
      cls: 'ai-linzi-skill-studio-intro',
    })
    if (this.loadingInstalledSkills) {
      this.contentEl.createDiv({ text: '正在读取“我的 Skills”…', cls: 'ai-linzi-skill-studio-intro' })
      return
    }
    if (this.installedSkills.length === 0) {
      this.contentEl.createDiv({
        text: '“我的 Skills”中还没有可选的 Skill。请先创建或安装一个文件夹形式的 Skill。',
        cls: 'ai-linzi-skill-studio-intro',
      })
      return
    }
    new Setting(this.contentEl)
      .setName('选择要更新的 Skill')
      .setDesc('旧版单文件 Skill 或没有 AI霖子版本清单的 Skill 会在预检时停止，不会覆盖。')
      .addDropdown((dropdown) => {
        for (const skill of this.installedSkills) {
          dropdown.addOption(skill.path, `${skill.displayName} · ${skill.name}`)
        }
        dropdown.setValue(this.selectedUpdatePath || this.installedSkills[0].path).onChange((value) => {
          this.selectedUpdatePath = value
        })
      })
    new Setting(this.contentEl)
      .setName('这次想修改什么')
      .setDesc('写清要增加、删去或改正的步骤。AI 不会新建或改写 scripts。')
      .addTextArea((input) => input
        .setPlaceholder('例如：增加“先让用户选择候选文件”的步骤，并修正输出模板')
        .setValue(this.updateInstruction)
        .onChange((value) => (this.updateInstruction = value.trim())))
    const permissions = this.contentEl.createDiv({ cls: 'ai-linzi-skill-permissions' })
    permissions.createEl('strong', { text: '本次更新边界' })
    const list = permissions.createEl('ul')
    list.createEl('li', { text: '只把所选 Skill 的可更新文本交给主对话模型；脚本和二进制只传路径、大小与哈希' })
    list.createEl('li', { text: '写入前锁定完整本机快照；失败时用本轮内存快照自动回滚，不额外保存历史版本' })
    list.createEl('li', { text: '不会访问 Skills 目录以外的文件，不会自动执行脚本' })
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('让 AI 生成更新确认卡')
      .setCta()
      .onClick(() => this.submitUpdate()))
  }

  private submitUpdate(): void {
    const skill = this.installedSkills.find((item) => item.path === this.selectedUpdatePath)
    if (!skill) {
      new Notice('请先选择要更新的 Skill')
      return
    }
    if (!this.updateInstruction) {
      new Notice('请先写清这次想修改什么')
      return
    }
    if (!this.options.onUpdateWithAi) {
      new Notice('当前版本暂不支持更新 Skill')
      return
    }
    this.close()
    this.options.onUpdateWithAi(skill, this.updateInstruction)
  }

  private submitCustom(): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(this.draft.name)) {
      new Notice('英文名称只能使用小写英文、数字和单个短横线')
      return
    }
    if (!this.draft.purpose || !this.draft.input || !this.draft.steps) {
      new Notice('请先写清用途、输入范围和关键步骤')
      return
    }
    if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(this.draft.version)) {
      new Notice('版本请使用 1.0.0 这样的三段格式，且每段不超过 9 位')
      return
    }
    const prompt = buildSkillStudioPrompt(this.draft)
    const sampleInput = this.draft.sampleInput
    this.close()
    this.options.onCreateWithAi(prompt, sampleInput)
  }

  private pickZip(): void {
    const input = this.contentEl.createEl('input', {
      cls: 'ai-linzi-hidden-file-input',
      attr: { type: 'file', accept: '.zip,application/zip' },
    })
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void (async () => {
        try {
          const block = portableBundleFromZip(new Uint8Array(await file.arrayBuffer()))
          this.close()
          new ImportedSkillPermissionModal(this.app, block, (adapted, sampleInput) => {
            this.options.onOfferBundle(adapted, sampleInput)
          }).open()
        } catch (error) {
          new Notice(`Skill ZIP 导入失败：${error instanceof Error ? error.message : String(error)}`, 9000)
        }
      })()
    }
    input.click()
  }
}

async function ensureFolder(app: App, path: string): Promise<void> {
  let current = ''
  for (const segment of normalizePath(path).split('/')) {
    current = current ? `${current}/${segment}` : segment
    const existing = app.vault.getAbstractFileByPath(current)
    if (existing instanceof TFolder) continue
    if (existing) throw new Error(`导出目录被同名文件占用：${current}`)
    await app.vault.createFolder(current)
  }
}

export async function exportSkillBundle(
  app: App,
  outputFolder: string,
  block: CreateLocalSkillBlock,
): Promise<TFile> {
  const archive: Record<string, Uint8Array> = {}
  for (const file of block.files) archive[`${block.name}/${file.path}`] = strToU8(file.content)
  const bytes = zipSync(archive, { level: 6 })
  const folder = normalizePath(`${outputFolder || 'AI霖子输出'}/Skills`)
  await ensureFolder(app, folder)
  const version = (() => {
    try {
      const manifest = block.files.find((file) => file.path === 'references/ai-linzi-skill-manifest.json')
      const value = manifest ? JSON.parse(manifest.content) as Record<string, unknown> : {}
      return typeof value.skillVersion === 'string' ? value.skillVersion : '1.0.0'
    } catch {
      return '1.0.0'
    }
  })()
  const base = `${block.name}-v${version}`
  let path = normalizePath(`${folder}/${base}.zip`)
  let suffix = 2
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${folder}/${base}-${suffix}.zip`)
    suffix += 1
  }
  return app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

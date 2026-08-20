import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from 'obsidian'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  CREATE_LOCAL_SKILL_MAX_FILES,
  CREATE_LOCAL_SKILL_MAX_TOTAL_CHARS,
  parsePortableSkillBundle,
  type CreateLocalSkillBlock,
} from './create-local-skill'
import {
  OFFICIAL_SKILL_TEMPLATES,
  buildSkillStudioPrompt,
  type SkillStudioDraft,
  type SkillStudioOutput,
} from './skill-studio-core'

export interface SkillStudioOptions {
  onCreateWithAi: (prompt: string, sampleInput: string) => void
  onOfferBundle: (block: CreateLocalSkillBlock, sampleInput: string) => void
}

function defaultDraft(): SkillStudioDraft {
  return {
    name: '',
    purpose: '',
    input: '我明确指定的一篇 Markdown 笔记',
    steps: '',
    triggers: [],
    output: 'create-note',
    sampleInput: '',
    version: '1.0.0',
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
  const name = /^---\r?\n[\s\S]*?^name:\s*([^\r\n]+)$/m.exec(entry.content)?.[1]?.trim() ?? ''
  const protocol = files
    .map((file) => `<<<Skill文件 path=${file.path}>>>\n${file.content}\n<<<Skill文件结束>>>`)
    .join('\n')
  const parsed = parsePortableSkillBundle(name, protocol)
  if (!parsed) throw new Error('ZIP 没有通过 AI霖子 Skill 安全校验，请检查名称、frontmatter 和文件路径')
  return parsed
}

export class SkillStudioModal extends Modal {
  private draft = defaultDraft()
  private templateId = 'custom'

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
  }

  private render(): void {
    this.contentEl.empty()
    this.contentEl.createDiv({
      text: '从官方模板开始，或把你反复做的一套工作教给 AI霖子。创建前会展示权限和全部文件，确认后才写入。',
      cls: 'ai-linzi-skill-studio-intro',
    })

    new Setting(this.contentEl)
      .setName('起点')
      .setDesc('官方模板不消耗 AI 积分；自定义 Skill 会让 AI 生成可确认的完整文件夹。')
      .addDropdown((dropdown) => {
        dropdown.addOption('custom', '从零创建自己的 Skill')
        for (const template of OFFICIAL_SKILL_TEMPLATES) {
          dropdown.addOption(template.id, `官方模板 · ${template.label}`)
        }
        dropdown.setValue(this.templateId).onChange((value) => {
          this.templateId = value
          this.render()
        })
      })

    const template = OFFICIAL_SKILL_TEMPLATES.find((item) => item.id === this.templateId)
    if (template) {
      this.contentEl.createEl('h3', { text: template.label })
      this.contentEl.createDiv({ text: template.description, cls: 'ai-linzi-skill-studio-intro' })
      const permissionCard = this.contentEl.createDiv({ cls: 'ai-linzi-skill-permissions' })
      permissionCard.createEl('strong', { text: '权限预览' })
      const list = permissionCard.createEl('ul')
      for (const permission of template.permissions) list.createEl('li', { text: permission })
      permissionCard.createDiv({ text: '版本 1.0.0 · 官方模板 · 无本机脚本', cls: 'ai-linzi-skill-studio-meta' })
      new Setting(this.contentEl)
        .setName('课堂试运行输入')
        .addText((input) => input
          .setValue(template.sampleInput)
          .onChange((value) => (this.draft.sampleInput = value.trim())))
      if (!this.draft.sampleInput) this.draft.sampleInput = template.sampleInput
      new Setting(this.contentEl)
        .addButton((button) => button
          .setButtonText('预览并安装官方模板')
          .setCta()
          .onClick(() => {
            this.close()
            this.options.onOfferBundle(template.block, this.draft.sampleInput || template.sampleInput)
          }))
        .addButton((button) => button
          .setButtonText('导入 Skill ZIP')
          .onClick(() => this.pickZip()))
      return
    }

    new Setting(this.contentEl)
      .setName('英文名称')
      .setDesc('小写英文或拼音，用短横线连接，例如 client-follow-up。升级旧 Skill 时请使用新名称，避免覆盖。')
      .addText((input) => input
        .setPlaceholder('client-follow-up')
        .setValue(this.draft.name)
        .onChange((value) => (this.draft.name = value.trim())))
    new Setting(this.contentEl)
      .setName('这套 Skill 解决什么问题')
      .addTextArea((input) => input
        .setPlaceholder('例如：每次咨询后，提炼共识、行动项并生成一份客户简报')
        .setValue(this.draft.purpose)
        .onChange((value) => (this.draft.purpose = value.trim())))
    new Setting(this.contentEl)
      .setName('输入范围')
      .setDesc('范围越明确，Skill 越稳定。')
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
      .setName('自动触发短语')
      .setDesc('用逗号分隔完整动作句；留空则只允许点名调用。')
      .addText((input) => input
        .setPlaceholder('生成客户简报,整理本次咨询行动项')
        .setValue(this.draft.triggers.join(','))
        .onChange((value) => {
          this.draft.triggers = value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean)
        }))
    new Setting(this.contentEl)
      .setName('输出方式')
      .addDropdown((dropdown) => dropdown
        .addOption('chat', '只在聊天中预览')
        .addOption('create-note', '确认后新建笔记')
        .addOption('update-current-note', '确认后更新当前笔记')
        .addOption('create-artifact', '确认后生成 HTML / Word / PDF / PPT')
        .setValue(this.draft.output)
        .onChange((value) => (this.draft.output = value as SkillStudioOutput)))
    new Setting(this.contentEl)
      .setName('版本')
      .setDesc('第一次用 1.0.0；升级旧 Skill 建议用 2.0.0 并换新名称。')
      .addText((input) => input
        .setValue(this.draft.version)
        .onChange((value) => (this.draft.version = value.trim())))
    new Setting(this.contentEl)
      .setName('试运行输入')
      .setDesc('创建成功后，确认卡会提供“立即试运行”。')
      .addText((input) => input
        .setPlaceholder('例如：把当前咨询记录生成客户简报')
        .setValue(this.draft.sampleInput)
        .onChange((value) => (this.draft.sampleInput = value.trim())))

    const permissions = this.contentEl.createDiv({ cls: 'ai-linzi-skill-permissions' })
    permissions.createEl('strong', { text: '本版默认权限' })
    const permissionList = permissions.createEl('ul')
    permissionList.createEl('li', { text: this.draft.output === 'chat' ? '不写文件' : '写入前展示全文并再次确认' })
    permissionList.createEl('li', { text: '不生成或运行本机脚本' })
    permissionList.createEl('li', { text: '不读取未明确指定的资料，除非 Skill 写明需要 Vault 搜索' })

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText('让 AI 创建并生成确认卡')
        .setCta()
        .onClick(() => this.submitCustom()))
      .addButton((button) => button
        .setButtonText('导入 Skill ZIP')
        .onClick(() => this.pickZip()))
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
    if (!/^\d+\.\d+\.\d+$/.test(this.draft.version)) {
      new Notice('版本请使用 1.0.0 这样的三段格式')
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
          this.options.onOfferBundle(block, `用 ${block.name} Skill 处理当前笔记`)
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

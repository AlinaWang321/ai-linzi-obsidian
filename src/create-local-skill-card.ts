/**
 * 「对话直接创建 Skill」确认卡的渲染（0.7.72 步 1 从 main.ts 抽出）。
 *
 * 抽出动机：0.7.73 的「覆盖更新 + 版本快照 + 回滚」会让这张卡从 116 行膨胀到
 * 两三百行。与其在 7,300 行的 main.ts 里继续堆，不如先把它单独放好——
 * 而且抽出后这段逻辑才第一次具备可测性（此前只能靠源码 grep 断言字符串）。
 *
 * ⚠️ 本次是**纯行为等价的搬迁**，不含任何功能改动。
 * Codex 预审明确指出「不可能只是 116 行原样移动」——本方法依赖宿主的
 * app / 技能根目录 / 输入框 / 输出目录 / 落盘 / 重绘六项能力，
 * 因此改为按 CreateLocalSkillCardHost 接口回调注入，行为保持逐分支一致。
 *
 * 🚫 本模块**不得反向 import main.ts**（Codex 验收条件之一）。
 * 消息对象只按结构取所需三个字段，不引 WireMessage 类型。
 */
import { App, normalizePath } from 'obsidian'
import type { CreateLocalSkillBlock } from './create-local-skill'
import { createLocalSkillBundleAtomically } from './create-local-skill-vault'
import {
  normalizeGeneratedSkillManifest,
  previewSkillInvocation,
  skillBlockManifest,
  skillInvocationPreviewText,
  skillTestInput,
} from './skill-studio-core'

/** 只取本卡片需要的字段，避免把 WireMessage 整个类型拖进来。 */
export interface CreateLocalSkillCardMessage {
  /** 本轮由 Skill Creator 产出（而非用户手写协议块）时为 true。 */
  skillCreatorResult?: boolean
  /** 已创建成功后回填，卡片据此切换到「已创建」形态。 */
  createdLocalSkill?: { root: string; entry: string }
  /** 「立即试运行」要填进输入框的示例短语。 */
  skillStudioTestInput?: string
}

/**
 * 宿主能力接口。
 *
 * 每一项都对应搬迁前 ChatView 上的一处直接依赖：
 *   app          ← this.app
 *   skillsRoot   ← this.localSkills.root()
 *   outputFolder ← this.plugin.settings.outputFolder
 *   fillInput    ← this.inputEl.value = …; this.inputEl.focus()
 *   persist      ← this.persistNow()
 *   rerender     ← this.renderMessages()
 *   notify       ← new Notice(...)（抽成回调只为可测，文案与时长不变）
 *   exportBundle ← exportSkillBundle(...)（由宿主注入，避免本模块依赖 skill-studio
 *                  从而间接拉进 Modal 与整条 Studio 链路）
 */
export interface CreateLocalSkillCardHost {
  app: App
  skillsRoot(): string
  outputFolder(): string
  fillInput(text: string): void
  persist(): Promise<void>
  rerender(): void
  notify(message: string, timeoutMs: number): void
  exportBundle(
    app: App,
    outputFolder: string,
    block: CreateLocalSkillBlock,
  ): Promise<{ path: string }>
}

export function renderCreateLocalSkillOffers(
  host: CreateLocalSkillCardHost,
  row: HTMLElement,
  blocks: CreateLocalSkillBlock[],
  message: CreateLocalSkillCardMessage,
): void {
  for (const rawBlock of blocks) {
    const normalized = message.skillCreatorResult
      ? normalizeGeneratedSkillManifest(rawBlock)
      : { block: rawBlock, repairs: [] }
    const block = normalized.block
    const root = host.skillsRoot()
    const skillRoot = normalizePath(`${root}/${block.name}`)
    const files = block.files
    const filePath = normalizePath(`${skillRoot}/SKILL.md`)
    const card = row.createDiv({ cls: 'ai-linzi-create-note-card' })
    card.createDiv({
      text: `🧩 待创建 AI 工作流:${block.name}`,
      cls: 'ai-linzi-create-note-title',
    })
    card.createDiv({ text: block.description, cls: 'ai-linzi-create-note-preview' })
    const manifest = skillBlockManifest(block)
    if (normalized.repairs.length > 0) {
      card.createDiv({
        text: `✅ 本机已自动修正：${normalized.repairs.join('；')}`,
        cls: 'ai-linzi-create-note-preview',
      })
    }
    card.createDiv({
      text: `保存位置:${skillRoot}/（版本 ${manifest.version} · 共 ${files.length} 个文件）`,
      cls: 'ai-linzi-create-note-preview',
    })
    const testInput = skillTestInput(block, message.skillStudioTestInput ?? '')
    const invocationPreview = previewSkillInvocation(block, testInput)
    card.createDiv({
      text: skillInvocationPreviewText(invocationPreview),
      cls: `ai-linzi-create-note-preview ai-linzi-skill-invocation-preview is-${invocationPreview.kind}`,
    })
    const permissionCard = card.createDiv({ cls: 'ai-linzi-skill-permissions' })
    permissionCard.createEl('strong', { text: '权限清单' })
    const permissions = permissionCard.createEl('ul')
    for (const permission of manifest.permissions) permissions.createEl('li', { text: permission })
    if (message.skillCreatorResult && !manifest.valid) {
      const invalid = card.createDiv({ cls: 'ai-linzi-create-note-preview' })
      invalid.createEl('strong', { text: '⚠️ Skill 包未通过本机校验' })
      const problems = invalid.createEl('ul')
      for (const problem of manifest.problems) problems.createEl('li', { text: problem })
    }
    for (const file of files) {
      const details = card.createEl('details')
      details.createEl('summary', { text: `查看 ${file.path}` })
      details.createEl('pre', { text: file.content, cls: 'ai-linzi-vault-write-preview' })
    }
    const actionsRow = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
    if (message.skillCreatorResult && !manifest.valid) {
      actionsRow.createSpan({
        text: '本次不允许安装，请让 AI霖子重新生成完整 Skill 包。',
        cls: 'ai-linzi-create-note-done',
      })
      continue
    }
    if (message.createdLocalSkill?.root === skillRoot) {
      actionsRow.createSpan({ text: '✅ 已创建', cls: 'ai-linzi-create-note-done' })
      const open = actionsRow.createEl('button', { text: '打开 SKILL.md' })
      open.onclick = () =>
        void host.app.workspace.openLinkText(message.createdLocalSkill?.entry ?? filePath, '', false)
      const test = actionsRow.createEl('button', { text: '立即试运行' })
      test.onclick = () => {
        host.fillInput(testInput)
      }
      const share = actionsRow.createEl('button', { text: '导出分享 ZIP' })
      share.onclick = () => {
        share.disabled = true
        void (async () => {
          try {
            const file = await host.exportBundle(host.app, host.outputFolder(), block)
            host.notify(`✅ 已导出可分享 Skill：${file.path}`, 7000)
            share.disabled = false
          } catch (error) {
            share.disabled = false
            host.notify(
              `导出失败：${error instanceof Error ? error.message : String(error)}`,
              8000,
            )
          }
        })()
      }
      continue
    }
    const createBtn = actionsRow.createEl('button', {
      text: files.length === 1 ? '创建 SKILL.md' : `创建完整 Skill（${files.length} 个文件）`,
    })
    createBtn.onclick = () => {
      // 确认卡出现后，用户仍可能去驾驶舱设置里修改“我的 Skills”目录。
      // 不能沿用卡片渲染时捕获的旧目录，也不能在预览仍显示旧路径时静默改写到新目录：
      // 先按当前设置重绘准确路径，再让用户重新确认一次。
      const currentRoot = host.skillsRoot()
      if (currentRoot !== root) {
        host.notify(
          `“我的 Skills”文件夹已改为 ${currentRoot}/，已刷新保存位置，请按新路径重新确认。`,
          8000,
        )
        host.rerender()
        return
      }
      createBtn.disabled = true
      void (async () => {
        try {
          const created = await createLocalSkillBundleAtomically(host.app, root, block)
          const entry = created.files.find((file) => file.path === filePath) ?? created.files[0]
          message.createdLocalSkill = { root: created.root, entry: entry.path }
          await host.persist()
          host.rerender()
          host.notify(`已创建到“我的 Skills”：${skillRoot}/`, 6000)
        } catch (error) {
          createBtn.disabled = false
          host.notify(`创建失败:${(error as Error).message}`, 7000)
        }
      })()
    }
  }
}

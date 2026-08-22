import type {
  PreparedSkillUpdate,
  SkillUpdateProposal,
} from './skill-update-core'
import type { AppliedSkillUpdate } from './skill-update-transaction'

export interface SkillUpdateOfferState {
  proposal: SkillUpdateProposal
  prepared: PreparedSkillUpdate
  applied?: AppliedSkillUpdate
}

export interface SkillUpdateCardMessage {
  skillUpdateOffer?: SkillUpdateOfferState
}

export interface SkillUpdateCardHost {
  skillsRoot(): string
  applyUpdate(prepared: PreparedSkillUpdate, proposal: SkillUpdateProposal): Promise<AppliedSkillUpdate>
  persist(): Promise<void>
  rerender(): void
  notify(message: string, timeoutMs: number): void
}

function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : '—'
}

export function renderSkillUpdateOffer(
  host: SkillUpdateCardHost,
  row: HTMLElement,
  message: SkillUpdateCardMessage,
): void {
  const offer = message.skillUpdateOffer
  if (!offer) return
  const { prepared, proposal } = offer
  const card = row.createDiv({ cls: 'ai-linzi-create-note-card ai-linzi-skill-update-card' })
  card.createDiv({
    text: `🧩 待更新 AI 工作流：${proposal.name}`,
    cls: 'ai-linzi-create-note-title',
  })
  card.createDiv({
    text: `版本 ${prepared.currentVersion} → ${prepared.nextVersion} · ${prepared.changes.length} 处实际变化`,
    cls: 'ai-linzi-create-note-preview',
  })
  card.createDiv({ text: `更新原因：${prepared.reason}`, cls: 'ai-linzi-create-note-preview' })
  card.createDiv({
    text: '只需确认一次；不会额外保存 Skill 历史版本。若本轮写入中途失败，会用内存中的原内容自动恢复。',
    cls: 'ai-linzi-create-note-preview',
  })

  for (const change of prepared.changes) {
    const details = card.createEl('details')
    const label = change.kind === 'create' ? '新增' : change.kind === 'delete' ? '删除' : '修改'
    details.createEl('summary', { text: `${label} ${change.path}` })
    if (change.kind === 'delete' && change.oldContent === undefined) {
      details.createDiv({
        text: `二进制文件 · ${change.oldSize ?? 0} bytes · SHA-256 ${shortHash(change.oldSha256)}`,
        cls: 'ai-linzi-create-note-preview',
      })
    } else {
      if (change.oldContent !== undefined) {
        details.createEl('strong', { text: change.kind === 'delete' ? '将删除的完整内容' : '修改前全文' })
        details.createEl('pre', { text: change.oldContent, cls: 'ai-linzi-vault-write-preview' })
      }
      if (change.newContent !== undefined) {
        details.createEl('strong', { text: change.kind === 'create' ? '新增全文' : '修改后全文' })
        details.createEl('pre', { text: change.newContent, cls: 'ai-linzi-vault-write-preview' })
      }
    }
  }

  const actions = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
  if (offer.applied) {
    actions.createSpan({
      text: `✅ 已更新到 ${offer.applied.nextVersion}`,
      cls: 'ai-linzi-create-note-done',
    })
    return
  }

  const apply = actions.createEl('button', { text: `确认并更新到 ${prepared.nextVersion}` })
  apply.onclick = () => {
    const currentRoot = host.skillsRoot()
    const lockedParent = prepared.skillRoot.split('/').slice(0, -1).join('/')
    if (lockedParent !== currentRoot) {
      host.notify('“我的 Skills”目录已经变化，已取消写入；请重新生成更新预览。', 9000)
      return
    }
    apply.disabled = true
    void (async () => {
      try {
        offer.applied = await host.applyUpdate(prepared, proposal)
        await host.persist()
        host.rerender()
        host.notify(`✅ Skill 已更新到 ${prepared.nextVersion}`, 7000)
      } catch (error) {
        apply.disabled = false
        host.notify(`Skill 更新失败：${error instanceof Error ? error.message : String(error)}`, 10000)
      }
    })()
  }
}

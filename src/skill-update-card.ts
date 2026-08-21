import type {
  PreparedSkillUpdate,
  SkillUpdateProposal,
  SkillVersionSummary,
} from './skill-update-core'
import type {
  AppliedSkillRestore,
  AppliedSkillUpdate,
  PreparedSkillRestore,
} from './skill-update-transaction'

export interface SkillUpdateOfferState {
  proposal: SkillUpdateProposal
  prepared: PreparedSkillUpdate
  versions: SkillVersionSummary[]
  applied?: AppliedSkillUpdate
  restored?: AppliedSkillRestore
}

export interface SkillUpdateCardMessage {
  skillUpdateOffer?: SkillUpdateOfferState
}

export interface SkillUpdateCardHost {
  skillsRoot(): string
  applyUpdate(prepared: PreparedSkillUpdate, proposal: SkillUpdateProposal): Promise<AppliedSkillUpdate>
  listVersions(skillRoot: string): Promise<SkillVersionSummary[]>
  prepareRestore(skillRoot: string, skillName: string, snapshotId: string): Promise<PreparedSkillRestore>
  restore(prepared: PreparedSkillRestore): Promise<AppliedSkillRestore>
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
    text: '版本历史只保存在这个 Obsidian 仓库的 Skill/ai-linzi-versions/ 中，不会上传到 AI霖子服务器。',
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
  const deleteCount = prepared.changes.filter((change) => change.kind === 'delete').length
  let deleteConfirmed = deleteCount === 0
  let confirmDelete: HTMLButtonElement | undefined

  if (offer.restored) {
    actions.createSpan({
      text: `✅ 已恢复到 ${offer.restored.restoredVersion}`,
      cls: 'ai-linzi-create-note-done',
    })
  } else if (offer.applied) {
    actions.createSpan({
      text: `✅ 已更新到 ${offer.applied.nextVersion}`,
      cls: 'ai-linzi-create-note-done',
    })
  } else {
    if (deleteCount > 0) {
      confirmDelete = actions.createEl('button', { text: `单独确认删除 ${deleteCount} 个文件` })
    }
    const apply = actions.createEl('button', { text: `应用更新到 ${prepared.nextVersion}` })
    apply.disabled = !deleteConfirmed
    if (confirmDelete) {
      confirmDelete.onclick = () => {
        deleteConfirmed = true
        confirmDelete!.disabled = true
        confirmDelete!.setText('✅ 已确认删除清单')
        apply.disabled = false
      }
    }
    apply.onclick = () => {
      const currentRoot = host.skillsRoot()
      if (prepared.skillRoot !== `${currentRoot}/${proposal.name}`) {
        host.notify('“我的 Skills”目录已经变化，已取消写入；请重新打开 Skill Studio 生成预览。', 9000)
        return
      }
      apply.disabled = true
      if (confirmDelete) confirmDelete.disabled = true
      void (async () => {
        try {
          offer.applied = await host.applyUpdate(prepared, proposal)
          offer.versions = await host.listVersions(prepared.skillRoot)
          await host.persist()
          host.rerender()
          const warning = offer.applied.historyCleanupWarning
          host.notify(
            warning ? `✅ Skill 已更新到 ${prepared.nextVersion}。${warning}` : `✅ Skill 已更新到 ${prepared.nextVersion}`,
            warning ? 10000 : 7000,
          )
        } catch (error) {
          apply.disabled = false
          if (confirmDelete && !deleteConfirmed) confirmDelete.disabled = false
          host.notify(`Skill 更新失败：${error instanceof Error ? error.message : String(error)}`, 10000)
        }
      })()
    }
  }

  if (offer.versions.length === 0) return
  const history = card.createEl('details')
  history.createEl('summary', { text: `本机历史版本（${offer.versions.length}）` })
  for (const version of offer.versions) {
    const item = history.createDiv({ cls: 'ai-linzi-create-note-actions' })
    item.createSpan({
      text: `${version.metadata.skillVersion} · ${new Date(version.metadata.archivedAtMs).toLocaleString('zh-CN')}`,
    })
    const restore = item.createEl('button', { text: `恢复 ${version.metadata.skillVersion}` })
    let preparedRestore: PreparedSkillRestore | undefined
    restore.onclick = () => {
      restore.disabled = true
      void (async () => {
        try {
          if (!preparedRestore) {
            preparedRestore = await host.prepareRestore(
              prepared.skillRoot,
              proposal.name,
              version.snapshotId,
            )
            restore.setText(`确认恢复到 ${version.metadata.skillVersion}`)
            restore.disabled = false
            return
          }
          offer.restored = await host.restore(preparedRestore)
          offer.versions = await host.listVersions(prepared.skillRoot)
          await host.persist()
          host.rerender()
          const warning = offer.restored.historyCleanupWarning
          host.notify(
            warning
              ? `✅ 已恢复到 ${offer.restored.restoredVersion}。${warning}`
              : `✅ 已恢复到 ${offer.restored.restoredVersion}`,
            warning ? 10000 : 7000,
          )
        } catch (error) {
          preparedRestore = undefined
          restore.setText(`恢复 ${version.metadata.skillVersion}`)
          restore.disabled = false
          host.notify(`恢复失败：${error instanceof Error ? error.message : String(error)}`, 10000)
        }
      })()
    }
  }
}

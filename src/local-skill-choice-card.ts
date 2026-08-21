export interface LocalSkillChoiceCandidate {
  path: string
  name: string
  displayName: string
  folderName: string
}

export interface LocalSkillChoiceState {
  requestMessageId: string
  candidates: LocalSkillChoiceCandidate[]
  requestedPath?: string
  completedPath?: string
  error?: string
}

export interface LocalSkillChoiceMessage {
  localSkillChoice?: LocalSkillChoiceState
}

export interface LocalSkillChoiceCardHost {
  isBusy(): boolean
  choose(message: LocalSkillChoiceMessage, path: string): Promise<void>
}

function choiceLabel(candidate: LocalSkillChoiceCandidate): string {
  return candidate.displayName === candidate.folderName
    ? candidate.displayName
    : `${candidate.displayName} · ${candidate.folderName}`
}

/** 多候选卡只保存并回传精确入口路径，不把显示名重新塞回输入框做第二次猜测。 */
export function renderLocalSkillChoiceCard(
  host: LocalSkillChoiceCardHost,
  row: HTMLElement,
  message: LocalSkillChoiceMessage,
): void {
  const state = message.localSkillChoice
  if (!state) return
  const card = row.createDiv({ cls: 'ai-linzi-create-note-card ai-linzi-local-skill-choice-card' })
  card.createDiv({ text: '请选择要运行的 Skill', cls: 'ai-linzi-create-note-title' })
  card.createDiv({
    text: '选择后会继续上一条请求，不会重复发送或重复保存用户消息。',
    cls: 'ai-linzi-create-note-preview',
  })
  const completed = state.candidates.find((candidate) => candidate.path === state.completedPath)
  if (completed) {
    card.createDiv({
      text: `✅ 已选择：${choiceLabel(completed)}`,
      cls: 'ai-linzi-create-note-done',
    })
    return
  }
  if (state.error) {
    card.createDiv({ text: `⚠️ ${state.error}`, cls: 'ai-linzi-create-note-preview' })
  }
  const actions = card.createDiv({ cls: 'ai-linzi-create-note-actions' })
  const activelyRunning = Boolean(state.requestedPath && host.isBusy())
  if (activelyRunning) {
    const running = state.candidates.find((candidate) => candidate.path === state.requestedPath)
    actions.createSpan({
      text: `正在用 ${running ? choiceLabel(running) : '所选 Skill'} 继续…`,
      cls: 'ai-linzi-create-note-done',
    })
    return
  }
  const buttons: HTMLButtonElement[] = []
  for (const candidate of state.candidates) {
    const button = actions.createEl('button', {
      text: choiceLabel(candidate),
      attr: { type: 'button' },
    })
    buttons.push(button)
    button.onclick = () => {
      for (const item of buttons) item.disabled = true
      void host.choose(message, candidate.path).catch(() => {
        for (const item of buttons) item.disabled = false
      })
    }
  }
}

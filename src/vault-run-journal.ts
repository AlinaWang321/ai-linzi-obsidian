import type { App } from 'obsidian'

export interface VaultRunJournal {
  version: 1
  sessionId: string
  taskId: string
  question: string
  updatedAt: number
  round: number
  finished?: boolean
  nextBody?: Record<string, unknown>
  pending?: { requestId: string; body: Record<string, unknown> }
  snapshots: { path: string; mtime: number; size: number }[]
  reads: Record<string, { nextOffset: number | null; totalChars: number }>
  plan: string[]
  summaries: Record<string, string>
  drafts: Record<string, string>
}
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const TTL = 24 * 60 * 60 * 1000
function journalPath(app: App, sessionId: string): string {
  if (!/^obsidian:[a-zA-Z0-9-]{1,100}$/.test(sessionId)) throw new Error('文件任务会话无效')
  return `${app.vault.configDir}/plugins/ai-linzi/vault-tasks/${sessionId.slice(9)}.json`
}
export async function loadVaultRun(app: App, sessionId: string): Promise<VaultRunJournal | null> {
  const path = journalPath(app, sessionId)
  // A fully written pending file is newer than the last committed checkpoint. A crash
  // between renames must leave at least one valid copy; no provider submission precedes save().
  for (const candidate of [`${path}.pending`, path, `${path}.bak`]) {
    if (!(await app.vault.adapter.exists(candidate))) continue
    try {
      const raw = await app.vault.adapter.read(candidate)
      if (raw.length > 2_000_000) throw new Error('cache too large')
      const value = JSON.parse(raw) as VaultRunJournal
      if (value.version !== 1 || value.sessionId !== sessionId || !value.taskId || typeof value.question !== 'string' ||
        !Array.isArray(value.snapshots) || value.snapshots.some(item => !item || typeof item.path !== 'string' || !Number.isFinite(item.mtime) || !Number.isFinite(item.size)) ||
        !isRecord(value.reads) || !Array.isArray(value.plan) || value.plan.some(p => typeof p !== 'string') ||
        !isRecord(value.summaries) || Object.values(value.summaries).some(x => typeof x !== 'string') ||
        !isRecord(value.drafts) || Object.values(value.drafts).some(x => typeof x !== 'string') ||
        !Number.isInteger(value.round) ||
        (value.pending && (typeof value.pending.requestId !== 'string' || !isRecord(value.pending.body))) ||
        !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > TTL) throw new Error('invalid cache')
      return value
    } catch {
      await app.vault.adapter.remove(candidate)
    }
  }
  return null
}
export async function saveVaultRun(app: App, journal: VaultRunJournal): Promise<void> {
  const path = journalPath(app, journal.sessionId)
  const folder = path.slice(0, path.lastIndexOf('/'))
  if (!(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder)
  journal.updatedAt = Date.now()
  const content = JSON.stringify(journal)
  if (content.length > 2_000_000) throw new Error('本任务暂存资料过多，已保留之前进度，请分批处理')
  // Hidden plugin-private cache: write then atomically replace the prior checkpoint.
  await app.vault.adapter.write(`${path}.pending`, content)
  if (await app.vault.adapter.exists(`${path}.bak`)) await app.vault.adapter.remove(`${path}.bak`)
  if (await app.vault.adapter.exists(path)) await app.vault.adapter.rename(path, `${path}.bak`)
  await app.vault.adapter.rename(`${path}.pending`, path)
  if (await app.vault.adapter.exists(`${path}.bak`)) await app.vault.adapter.remove(`${path}.bak`)
}
export async function clearVaultRun(app: App, sessionId: string): Promise<void> {
  const path = journalPath(app, sessionId)
  for (const candidate of [path, `${path}.pending`, `${path}.bak`]) {
    if (await app.vault.adapter.exists(candidate)) await app.vault.adapter.remove(candidate)
  }
}
export function vaultRunMemory(journal: VaultRunJournal): string {
  return JSON.stringify({
    goal: journal.question,
    sources: journal.plan.map(path => ({ path, ...journal.reads[path], summary: journal.summaries[path] })),
    stagedDrafts: Object.entries(journal.drafts).map(([path, content]) => ({ path, chars: content.length })),
  })
}
export function canResumeVaultRun(journal: VaultRunJournal, stat: (path: string) => { mtime: number; size: number } | null) {
  return journal.snapshots.every(old => {
    const current = stat(old.path)
    return current && current.mtime === old.mtime && current.size === old.size
  })
}

export interface RecoverableStepHost {
  request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<Record<string, unknown>>
  save(): Promise<void>
  progress(text: string): void
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  uid(): string
}
/** One logical request survives disconnects/restarts. GET never creates model work. */
export async function recoverableVaultStep(host: RecoverableStepHost, journal: VaultRunJournal,
  body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const endpoint = '/api/plugin/v2/vault-native/step'
  if (!journal.pending) {
    journal.pending = { requestId: host.uid(), body: { ...body, taskId: journal.taskId } }
    await host.save()
  }
  const pending = journal.pending
  let accepted = false
  let errors = 0
  const started = Date.now()
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('已停止', 'AbortError')
      if (Date.now() - started > 20 * 60 * 1000) throw new Error('任务仍未完成，进度已保存。稍后回复“继续”可恢复')
      let response: Record<string, unknown>
      try {
        const timeout = new AbortController()
        const timer = window.setTimeout(() => timeout.abort(), 25_000)
        const abort = () => timeout.abort()
        signal?.addEventListener('abort', abort, { once: true })
        try {
          response = await host.request(accepted ? `${endpoint}?requestId=${encodeURIComponent(pending.requestId)}` : endpoint, {
            method: accepted ? 'GET' : 'POST',
            ...(accepted ? {} : { body: { ...pending.body, requestId: pending.requestId } }),
            signal: timeout.signal,
          })
        } finally {
          window.clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
        errors = 0
        accepted = true
      } catch (error) {
        if (signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        // Validation/account failures are actionable; retry only transport/server availability.
        if (!/fetch|network|load failed|连接|暂时|稍后|请求失败\(50|AbortError|aborted|timeout/i.test(message)) throw error
        if (++errors > 8) throw new Error('连接暂时不可用，已保存本次进度。恢复网络后回复“继续”即可')
        host.progress('连接暂时中断，正在恢复同一步…')
        await host.sleep(Math.min(errors * 1500, 6000), signal)
        continue
      }
      if (response.status === 'completed' && response.ok === true) {
        journal.pending = undefined
        // Caller persists the next checkpoint after handling these read-only tool requests.
        return response
      }
      if (['failed', 'cancelled', 'expired', 'reconciliation_required'].includes(String(response.status))) {
        if (response.status !== 'reconciliation_required') journal.pending = undefined
        await host.save()
        throw new Error(typeof response.error === 'string' ? response.error : '这一步没有完成，已保留进度')
      }
      host.progress('正在处理资料，进度已保存，可随时停止…')
      await host.sleep(2500, signal)
    }
  } catch (error) {
    if (signal?.aborted) {
      try {
        const cancelled = await host.request(endpoint, { method: 'POST', body: { requestId: pending.requestId, action: 'cancel' } })
        if (cancelled.status === 'cancelled') journal.pending = undefined
      } catch { /* Keep the same request id: recovery will query/cancel, never blindly regenerate. */ }
    }
    await host.save()
    throw error
  }
}

/** Called at startup; only our task cache is inspected, never user documents. */
export async function pruneVaultRuns(app: App): Promise<void> {
  const folder = `${app.vault.configDir}/plugins/ai-linzi/vault-tasks`
  if (!(await app.vault.adapter.exists(folder))) return
  for (const file of (await app.vault.adapter.list(folder)).files) {
    const name = file.slice(file.lastIndexOf('/') + 1)
    if (/^[a-zA-Z0-9-]+\.json\.(?:pending|bak)$/.test(name)) {
      const stat = await app.vault.adapter.stat(file)
      if (stat && Date.now() - stat.mtime > TTL) await app.vault.adapter.remove(file)
      continue
    }
    if (!/^[a-zA-Z0-9-]+\.json$/.test(name)) continue
    await loadVaultRun(app, `obsidian:${name.slice(0, -5)}`)
  }
}

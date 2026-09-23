import { Modal, Setting, TFile, normalizePath } from 'obsidian'
import type AiLinziPlugin from './main'
import { insertCoverEmbed, insertEmbeds } from './article-format'

export const ILLUSTRATION_RESULTS_API = '/api/plugin/v1/article-illustration/results'

export interface IllustrationAsset {
  imageId: string
  imageUrl: string
  title: string
  anchor: string
  kind: 'cover' | 'body'
  savedPath?: string
  inserted?: boolean
}

export interface IllustrationDelivery {
  requestId: string
  notePath: string
  folder: string
  expected: number
  phase: 'running' | 'attention' | 'complete'
  summary: string
  assets: IllustrationAsset[]
}

/** 只领取本次任务已有原图；两个按钮都不会提交生成请求。 */
export async function retryIllustrationDelivery(
  plugin: AiLinziPlugin, delivery: IllustrationDelivery, insert: boolean,
): Promise<void> {
  if (delivery.assets.length < delivery.expected) {
    let result: { images: { imageId: string; imageUrl: string | null; kind: 'cover' | 'body' }[] }
    try {
      result = await plugin.api(`${ILLUSTRATION_RESULTS_API}?taskId=${encodeURIComponent(delivery.requestId)}`) as typeof result
    } catch (error) {
      // 已下载的图片可以离线插入，查询暂时失败不能挡住已有成果。
      if (!delivery.assets.length) throw error
      result = { images: [] }
    }
    const jobs = plugin.getIllustrationJobsData() as RecoveryJob[]
    const job = jobs.find((item) => item.requestId === delivery.requestId)
    for (const image of result.images) {
      if (!image.imageUrl || delivery.assets.some((asset) => asset.imageId === image.imageId)) continue
      const saved = job?.deliveryImages?.find((asset) => asset.imageId === image.imageId)
      delivery.assets.push(saved ? { ...saved } : {
        imageId: image.imageId, imageUrl: image.imageUrl, kind: image.kind,
        title: image.kind === 'cover' ? '封面' : '正文配图', anchor: '',
      })
    }
  }
  if (!delivery.assets.length) throw new Error('暂未查到已完成的图片，请稍后再次点击；不会重新生成')
  const errors: string[] = []
  for (const asset of delivery.assets) {
    try {
      await saveIllustrationAsset(plugin, asset, delivery.folder)
      // 先保存下载成果，即使下一步插入失败也能保留文件和恢复记录。
      const current = plugin.getIllustrationJobsData() as RecoveryJob[]
      const currentJob = current.find((item) => item.requestId === delivery.requestId)
      if (currentJob) {
        currentJob.deliveryImages ??= []
        const existing = currentJob.deliveryImages.find((item) => item.imageId === asset.imageId)
        if (existing) Object.assign(existing, asset)
        else currentJob.deliveryImages.push({ ...asset })
      } else current.push({ requestId: delivery.requestId, notePath: delivery.notePath,
        folder: delivery.folder, deliveryImages: [{ ...asset }], updatedAt: Date.now() })
      await plugin.setIllustrationJobsData(current)
      if (insert) {
        await insertIllustrationAssets(plugin, delivery.notePath, [asset])
        asset.inserted = true
      }
    } catch (error) { errors.push(`${asset.title}：${error instanceof Error ? error.message : String(error)}`) }
  }
  delivery.phase = delivery.assets.length >= delivery.expected && delivery.assets.every((asset) => asset.inserted) && !errors.length
    ? 'complete' : 'attention'
  const saved = delivery.assets.filter((asset) => asset.savedPath).length
  delivery.summary = errors.length ? errors.join('；')
    : insert ? `已保存并插入 ${delivery.assets.length} 张图片。`
      : `已保存 ${saved} 张原图，可点击“插入笔记”放回原文章。`
  if (!errors.length && delivery.assets.length < delivery.expected) delivery.summary += ' 其余图片尚未完成，可再次调用“文章配图”继续。'
}

export function renderIllustrationDelivery(
  container: HTMLElement, plugin: AiLinziPlugin, delivery: IllustrationDelivery,
  persist: (delivery: IllustrationDelivery) => Promise<void>,
): void {
  const card = container.createDiv({ cls: 'ai-linzi-illustration-delivery' })
  card.createEl('strong', { text: '文章配图' })
  const summary = card.createEl('p', { text: delivery.summary })
  card.createEl('p', { text: `原文章：${delivery.notePath}`, cls: 'ai-linzi-illustration-delivery-path' })
  if (delivery.assets.length) {
    const list = card.createEl('ul')
    for (const asset of delivery.assets) {
      const saved = asset.savedPath && plugin.app.vault.getAbstractFileByPath(asset.savedPath) instanceof TFile
      list.createEl('li', { text: `${asset.title} · ${saved ? asset.inserted ? '已插入' : '已保存，待插入' : '已生成，待下载'}` })
    }
  }
  const actions = card.createDiv({ cls: 'ai-linzi-msg-actions' })
  const buttons: HTMLButtonElement[] = []
  for (const [label, insert] of [['重新下载', false], ['插入笔记', true]] as const) {
    const button = actions.createEl('button', { text: label })
    buttons.push(button)
    button.disabled = delivery.phase === 'running'
    button.onclick = async () => {
      for (const item of buttons) item.disabled = true
      summary.setText(insert ? '正在领取原图并插入原文章…' : '正在领取原图并保存…')
      try { await retryIllustrationDelivery(plugin, delivery, insert) }
      catch (error) { delivery.phase = 'attention'; delivery.summary = error instanceof Error ? error.message : String(error) }
      try { await persist(delivery) }
      catch { summary.setText('恢复记录暂未保存，请保留此对话后重试。'); for (const item of buttons) item.disabled = false }
    }
  }
  card.createEl('p', { text: '领取已有原图，不重新生成；下载和插入不重复扣积分。', cls: 'ai-linzi-illustration-delivery-hint' })
}

interface RecoveryJob {
  requestId?: string
  notePath: string
  folder?: string
  deliveryImages?: IllustrationAsset[]
  updatedAt: number
}

export function illustrationImageId(url: string): string {
  return /\/article-illustration\/by-request\/([a-zA-Z0-9_-]{8,80})\.(?:png|jpg|webp)(?:\?|$)/.exec(url)?.[1] ?? ''
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|[\]#^]/g, '_').slice(0, 40).trim() || '配图'
}

async function ensureImageFolder(plugin: AiLinziPlugin, folder: string): Promise<void> {
  let current = ''
  for (const part of folder.split('/')) {
    current = current ? `${current}/${part}` : part
    if (!plugin.app.vault.getAbstractFileByPath(current)) await plugin.app.vault.createFolder(current)
  }
}

const saving = new WeakMap<AiLinziPlugin, Map<string, Promise<string>>>()

/** 确定性文件名 + 同图并发合并；重新下载仅补缺失文件，不覆盖用户文件。 */
export async function saveIllustrationAsset(
  plugin: AiLinziPlugin,
  asset: IllustrationAsset,
  folder: string,
): Promise<string> {
  let active = saving.get(plugin)
  if (!active) { active = new Map(); saving.set(plugin, active) }
  const existing = active.get(asset.imageId)
  if (existing) return existing
  const promise = (async () => {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(asset.imageId)) throw new Error('缺少已生成图片编号，请从“找回已生成图片”领取')
    if (asset.savedPath && plugin.app.vault.getAbstractFileByPath(asset.savedPath) instanceof TFile) return asset.savedPath
    const safeFolder = normalizePath(folder)
    if (safeFolder.split('/').some((part) => part === '..' || part.startsWith('.')) || safeFolder.startsWith('/')) {
      throw new Error('图片保存目录无效')
    }
    await ensureImageFolder(plugin, safeFolder)
    const path = normalizePath(`${safeFolder}/${asset.kind === 'cover' ? '00_封面' : '配图'}_${safeName(asset.title)}_${asset.imageId}.png`)
    const previous = plugin.app.vault.getAbstractFileByPath(path)
    if (previous && !(previous instanceof TFile)) throw new Error('图片位置被同名文件夹占用')
    if (!previous) {
      const binary = await plugin.downloadIllustration(asset.imageId)
      await plugin.app.vault.createBinary(path, binary)
    }
    asset.savedPath = path
    return path
  })()
  active.set(asset.imageId, promise)
  try { return await promise } finally { active.delete(asset.imageId) }
}

/** 原文定位失败时使用现有正文兜底位置；已有相同附件引用不会重复插入。 */
export async function insertIllustrationAssets(plugin: AiLinziPlugin, notePath: string, assets: IllustrationAsset[]): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(notePath)
  if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('原笔记已移动或不存在，请在找回图片窗口选择当前笔记')
  await plugin.app.vault.process(file, (content) => {
    let out = content
    for (const asset of assets) {
      if (!asset.savedPath || !(plugin.app.vault.getAbstractFileByPath(asset.savedPath) instanceof TFile)) continue
      if (out.includes(`![[${asset.savedPath}]]`)) continue
      out = asset.kind === 'cover'
        ? insertCoverEmbed(out, asset.savedPath)
        : insertEmbeds(out, [{ path: asset.savedPath, anchor: asset.anchor }]).out
    }
    return out
  })
}

export function openIllustrationRecovery(plugin: AiLinziPlugin): void {
  new IllustrationRecoveryModal(plugin).open()
}

class IllustrationRecoveryModal extends Modal {
  private cursor: string | null = null
  private loading = false
  private target: TFile | null
  private list!: HTMLElement

  constructor(private plugin: AiLinziPlugin) {
    super(plugin.app)
    const current = plugin.app.workspace.getActiveFile()
    this.target = current?.extension === 'md' ? current : null
  }

  onOpen(): void {
    this.titleEl.setText('找回已生成图片')
    this.contentEl.createEl('p', { text: '这里领取已经生成的原图，不重新生图。图片会保存到 AI霖子输出的配图目录；下载和插入可以分别重试。' })
    this.list = this.contentEl.createDiv()
    void this.loadPage()
  }

  private async loadPage(): Promise<void> {
    if (this.loading) return
    this.loading = true
    const status = this.list.createEl('p', { text: '正在读取图片记录…' })
    try {
      const data = await this.plugin.api(`${ILLUSTRATION_RESULTS_API}${this.cursor ? `?before=${encodeURIComponent(this.cursor)}` : ''}`) as {
        images: { imageId: string; imageUrl: string | null; createdAt: string; kind: 'cover' | 'body'; available: boolean }[]
        nextCursor: string | null
      }
      status.remove()
      if (!data.images.length) this.list.createEl('p', { text: '没有更多可领取的图片。' })
      const jobs = this.plugin.getIllustrationJobsData() as RecoveryJob[]
      for (const record of data.images) {
        const job = jobs.find((item) => item.deliveryImages?.some((asset) => asset.imageId === record.imageId))
        const asset = job?.deliveryImages?.find((item) => item.imageId === record.imageId) ?? {
          imageId: record.imageId, imageUrl: record.imageUrl ?? '',
          title: record.kind === 'cover' ? '封面' : '正文配图', anchor: '', kind: record.kind,
        }
        const date = record.createdAt.slice(0, 10)
        const displayTime = new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })
        const folder = job?.folder ?? `${this.plugin.settings.outputFolder || 'AI霖子输出'}/公众号文章/配图/${date}_找回图片`
        const original = job?.notePath ? this.plugin.app.vault.getAbstractFileByPath(job.notePath) : null
        const notePath = original instanceof TFile && original.extension === 'md' ? original.path : this.target?.path
        const row = this.list.createDiv()
        if (notePath) row.createEl('p', { text: `插入位置：${notePath}` })
        const info = row.createEl('p', { text: `${displayTime} · ${asset.title}${asset.savedPath ? ' · 已保存' : ''}` })
        const setting = new Setting(row)
        const act = async (insert: boolean) => {
          for (const button of Array.from(row.querySelectorAll('button'))) button.disabled = true
          try {
            const path = await saveIllustrationAsset(this.plugin, asset, folder)
            // 每次重新读取本机状态，避免恢复窗口覆盖另一个正在生成的任务。
            const currentJobs = this.plugin.getIllustrationJobsData() as RecoveryJob[]
            const currentJob = currentJobs.find((item) => item.deliveryImages?.some((item) => item.imageId === asset.imageId))
            if (currentJob) {
              const item = currentJob.deliveryImages!.find((item) => item.imageId === asset.imageId)!
              item.savedPath = path
            } else {
              currentJobs.push({ notePath: notePath ?? '', folder, deliveryImages: [asset], updatedAt: Date.now() })
            }
            await this.plugin.setIllustrationJobsData(currentJobs)
            if (insert && notePath) await insertIllustrationAssets(this.plugin, notePath, [asset])
            info.setText(`${displayTime} · ${asset.title} · ${insert ? '已保存并插入' : '已保存'}。保存位置：${folder}`)
          } catch (error) {
            info.setText(`${asset.title}：${error instanceof Error ? error.message : String(error)}。原图仍可稍后领取。`)
          } finally {
            for (const button of Array.from(row.querySelectorAll('button'))) button.disabled = false
          }
        }
        setting.addButton((button) => button.setButtonText('重新下载').setDisabled(!record.available)
          .onClick(() => act(false)))
        if (notePath) setting.addButton((button) => button.setButtonText('插入笔记').setTooltip(notePath)
          .setDisabled(!record.available).onClick(() => act(true)))
        else row.createEl('p', { text: '打开一篇 Markdown 笔记后重新进入，即可插入图片。' })
        setting.addButton((button) => button.setButtonText('查看图片').onClick(async () => {
          const file = asset.savedPath ? this.plugin.app.vault.getAbstractFileByPath(asset.savedPath) : null
          if (file instanceof TFile) await this.plugin.app.workspace.getLeaf('tab').openFile(file)
          else info.setText(`${displayTime} · ${asset.title}：请先点击“重新下载”保存图片。`)
        }))
        if (!record.available) row.createEl('p', { text: '原图暂时不可读取，请稍后刷新或联系支持。' })
      }
      this.cursor = data.nextCursor
      if (this.cursor) new Setting(this.list).addButton((button) => button.setButtonText('加载更早图片').onClick(async () => {
        button.setDisabled(true)
        await this.loadPage()
        button.buttonEl.remove()
      }))
    } catch (error) {
      status.setText(`暂时无法读取图片：${error instanceof Error ? error.message : String(error)}`)
      new Setting(this.list).addButton((button) => button.setButtonText('重新读取').onClick(async () => {
        button.setDisabled(true)
        await this.loadPage()
      }))
    } finally { this.loading = false }
  }

  onClose(): void { this.contentEl.empty() }
}

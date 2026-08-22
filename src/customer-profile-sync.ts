import { App, Modal, Notice, Setting, TFile } from 'obsidian'

export interface LocalCustomerProfile {
  path: string
  content: string
  fields: Record<string, string>
  identifiers: { customerCode?: string; name: string; wechatId?: string }
  recommendsCode: boolean
  /** 档案里出现但不在 CRM 合法枚举内的阶段词；本次保留 CRM 原值并在弹窗说明。 */
  droppedStage?: string
}

interface CrmCustomer {
  id: number
  seq: number
  customerCode: string
  name: string
  wechatId: string
  channel: string
  stage: string
  quality: string | null
  intent: string
  occupation: string
  painPoints: string
  notes: string
  referrer: string
  addedDate: string
  bookedDate: string | null
  consultedDate: string | null
  archiveMd: string | null
  updatedAt: string
}

type MatchResponse =
  | { ok: true; status: 'not_found' }
  | { ok: true; status: 'deleted'; customer: Pick<CrmCustomer, 'id' | 'seq' | 'customerCode' | 'name'> }
  | { ok: true; status: 'matched'; matchedBy: 'customerCode' | 'wechatId' | 'name'; customer: CrmCustomer }
  | { ok: true; status: 'ambiguous'; matchedBy: 'wechatId' | 'name'; customers: CrmCustomer[] }

export interface CustomerCrmApi {
  api(path: string, options?: { method?: string; body?: unknown }): Promise<unknown>
}

/**
 * 档案字段 → CRM 列。**首个别名是标准写法**，服务端建档指令要求 AI 只用这一套；
 * 后面的别名是兜底，认历史档案和用户手写的各种叫法（2026-08-20 Alina 报障：
 * 写成「客户姓名」就匹配不上，弹窗里只剩一行「客户称呼」）。
 * 新增别名时务必同时想清楚：不能与其他字段的别名互相抢行。
 */
const FIELD_ALIASES: Array<[string, string[]]> = [
  ['customerCode', ['客户编号', 'AI霖子客户编号', '学员编号', 'customer_code', 'customerCode']],
  ['name', [
    '客户称呼', '客户姓名', '客户昵称', '客户名称', '客户名', '学员姓名', '学员称呼', '学员昵称',
    '真实姓名', '姓名', '称呼', '昵称', 'name',
  ]],
  ['wechatId', ['微信号', '微信ID', '客户微信', '微信账号', '微信', 'wechat_id', 'wechat']],
  ['channel', ['渠道来源', '来源渠道', '客户来源', '获客渠道', '客户渠道']],
  ['stage', ['客户阶段', '跟进阶段', '档案状态', '客户状态', '当前阶段']],
  ['quality', ['精准度', '客户质量', '质量分级', '客户分级']],
  ['intent', ['意向产品', '客户需求', '核心需求', '目标产品']],
  ['occupation', ['职业背景', '客户背景', '身份背景', '职业']],
  ['painPoints', ['核心痛点', '当前卡点', '主要痛点', '痛点', '卡点']],
  ['notes', ['备注', '补充记录', '客户备注']],
  ['referrer', ['推荐人', '转介绍人', '介绍人', '引荐人']],
  ['addedDate', ['加微信日期', '加微日期', '加微信时间', '加微时间', '进入私域日期', '进私域日期']],
  ['bookedDate', ['约咨询日期', '约咨询时间', '报名日期', '预约日期']],
  ['consultedDate', ['咨询日期', '首次咨询日期', '首次咨询', '咨询时间']],
]

const FIELD_LABELS: Record<string, string> = {
  customerCode: '客户编号',
  name: '客户称呼',
  wechatId: '微信号',
  channel: '渠道来源',
  stage: '客户阶段',
  quality: '精准度',
  intent: '意向产品',
  occupation: '职业背景',
  painPoints: '核心痛点',
  notes: '备注',
  referrer: '推荐人',
  addedDate: '加微信日期',
  bookedDate: '约咨询日期',
  consultedDate: '咨询日期',
}

const STAGE_ALIASES: Record<string, string> = {
  新增: 'new',
  初次整理: 'new',
  新客户: 'new',
  // AI 生成档案常用口语（2026-08-18 小A 档案「潜在客户」同步 402 实锤）；
  // 「沟通中」归 new 与 WebApp CSV 导入同口径。
  潜在客户: 'new',
  潜在: 'new',
  沟通中: 'new',
  已约咨询: 'booked',
  已约: 'booked',
  已咨询: 'consulted',
  咨询过: 'consulted',
  已成交: 'won',
  成交: 'won',
  付费: 'won',
  已付款: 'won',
  交付中: 'delivering',
  服务中: 'delivering',
  已完结: 'done',
  已完成: 'done',
  已交付: 'done',
  流失: 'lost',
  放弃: 'lost',
}

/** 与 WebApp lib/customers/constants.ts CUSTOMER_STAGES 保持同步；不合法阶段绝不发给服务端。 */
const LEGAL_STAGE_KEYS = new Set(['new', 'booked', 'consulted', 'won', 'delivering', 'done', 'lost'])

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanScalar(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^(?:未确认|待确认|待补充|待填写|待填|未填|未知|不适用|不详|未报名|暂无|无|空|—|–|-|null|n\/a|tbd)$/iu, '')
    .trim()
}

function fieldValue(content: string, aliases: string[]): string {
  for (const alias of aliases) {
    const match = new RegExp(`^(?:[-*]\\s*)?${escapeRegex(alias)}\\s*[：:]\\s*(.*?)\\s*$`, 'imu').exec(content)
    if (match) return cleanScalar(match[1])
  }
  return ''
}

function normalizeDate(value: string): string {
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(value.trim())
  if (!match) return ''
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
}

/** 只识别明确的客户/学员档案；逐字稿正文不会被误提示同步。 */
export function parseLocalCustomerProfile(path: string, content: string): LocalCustomerProfile | undefined {
  const raw: Record<string, string> = {}
  for (const [key, aliases] of FIELD_ALIASES) raw[key] = fieldValue(content, aliases)
  const profileMarker =
    /(?:客户|学员).{0,4}档案/iu.test(path) ||
    /^(?:#{1,3}\s+.*(?:客户|学员).{0,4}档案|(?:文档类型|类型)\s*[:：]\s*(?:客户|学员)档案|\s*-\s*(?:客户|学员)档案)\s*$/imu.test(content.slice(0, 2500))
  const hasIdentity = Boolean(raw.customerCode || raw.wechatId || raw.stage)
  if (!raw.name || (!profileMarker && !hasIdentity)) return undefined

  const fields: Record<string, string> = { name: raw.name.slice(0, 50) }
  for (const key of ['customerCode', 'wechatId', 'channel', 'intent', 'occupation', 'painPoints', 'notes', 'referrer']) {
    if (raw[key]) fields[key] = raw[key]
  }
  let droppedStage: string | undefined
  if (raw.stage) {
    const mapped = STAGE_ALIASES[raw.stage] ?? raw.stage
    if (LEGAL_STAGE_KEYS.has(mapped)) fields.stage = mapped
    else droppedStage = raw.stage
  }
  if (raw.quality) {
    const quality = raw.quality.toUpperCase().match(/[A-E]/)?.[0]
    if (quality) fields.quality = quality
  }
  for (const key of ['addedDate', 'bookedDate', 'consultedDate']) {
    const date = normalizeDate(raw[key])
    if (date) fields[key] = date
  }
  return {
    path,
    content,
    fields,
    identifiers: {
      customerCode: fields.customerCode,
      name: fields.name,
      wechatId: fields.wechatId,
    },
    recommendsCode: !fields.customerCode && ['won', 'delivering'].includes(fields.stage),
    droppedStage,
  }
}

export async function readLocalCustomerProfile(app: App, path: string): Promise<LocalCustomerProfile | undefined> {
  const file = app.vault.getAbstractFileByPath(path)
  if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return undefined
  return parseLocalCustomerProfile(file.path, await app.vault.cachedRead(file))
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return '（复杂值）'
  }
}

class CustomerCrmSyncModal extends Modal {
  constructor(
    app: App,
    private readonly client: CustomerCrmApi,
    private readonly profile: LocalCustomerProfile,
    private readonly onSynced: (customer: CrmCustomer) => Promise<void> | void,
  ) {
    super(app)
  }

  onOpen(): void {
    void this.loadPreview()
  }

  private async loadPreview(): Promise<void> {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h2', { text: '同步到 AI霖子 CRM' })
    contentEl.createEl('p', {
      text: `本地来源：${this.profile.path}`,
      cls: 'setting-item-description',
    })
    contentEl.createEl('p', {
      text: '只会读取并同步这篇客户档案；不会上传来源逐字稿，也不会扫描 Vault 里的其他客户资料。',
      cls: 'setting-item-description',
    })
    const loading = contentEl.createEl('p', { text: '正在按客户编号 → 微信号 → 称呼查找 CRM…' })
    try {
      const match = (await this.client.api('/api/plugin/v1/customers/match', {
        method: 'POST',
        body: this.profile.identifiers,
      })) as MatchResponse
      loading.remove()
      this.renderMatch(match)
    } catch (error) {
      loading.setText(`读取失败：${(error as Error).message}`)
    }
  }

  private renderMatch(match: MatchResponse): void {
    const { contentEl } = this
    if (match.status === 'deleted') {
      contentEl.createEl('p', {
        text: `客户编号已被回收站中的「${match.customer.name}」占用。请先在 WebApp 恢复该客户，或给本地档案换一个编号。`,
      })
      new Setting(contentEl).addButton((button) => button.setButtonText('关闭').onClick(() => this.close()))
      return
    }
    if (match.status === 'ambiguous') {
      contentEl.createEl('p', {
        text: `CRM 中找到 ${match.customers.length} 位同名/同微信客户。为避免合并错人，本次不允许写入；请先给目标客户填写唯一的客户编号，再重新同步。`,
      })
      const list = contentEl.createEl('ul')
      for (const customer of match.customers) {
        list.createEl('li', {
          text: `${customer.customerCode || `${customer.seq}号`} · ${customer.name} · ${customer.wechatId || '无微信号'}`,
        })
      }
      new Setting(contentEl).addButton((button) => button.setButtonText('关闭').onClick(() => this.close()))
      return
    }

    const existing = match.status === 'matched' ? match.customer : undefined
    contentEl.createEl('h3', {
      text: existing
        ? `将更新：${existing.customerCode || `${existing.seq}号`} · ${existing.name}`
        : `将新建：${this.profile.fields.customerCode || this.profile.fields.name}`,
    })
    if (match.status === 'matched') {
      const label = match.matchedBy === 'customerCode' ? '客户编号' : match.matchedBy === 'wechatId' ? '微信号' : '称呼'
      contentEl.createEl('p', { text: `准确匹配依据：${label}`, cls: 'setting-item-description' })
      // 2026-08-18 小A→小B 错配实锤：编号/微信号匹配到的客户与档案称呼不一致时，
      // 必须显眼警告——占位编号或复用编号会把两个人合并成一个。
      if (
        match.matchedBy !== 'name' &&
        existing?.name &&
        this.profile.fields.name &&
        existing.name !== this.profile.fields.name
      ) {
        contentEl.createEl('p', {
          text: `⚠️ 按${label}匹配到的客户称呼是「${existing.name}」，与本地档案的「${this.profile.fields.name}」不一致。请先确认是同一个人；如果不是，请取消并检查本地档案的客户编号/微信号是否填错或占位。`,
          cls: 'ai-linzi-crm-sync-warning',
        })
      }
    }
    if (this.profile.droppedStage) {
      contentEl.createEl('p', {
        text: `说明：档案里的客户阶段「${this.profile.droppedStage}」不是 CRM 合法阶段（新增/已约咨询/已咨询/已成交/交付中/已完结/流失），本次保留 CRM 原值。`,
        cls: 'setting-item-description',
      })
    }
    if (this.profile.recommendsCode) {
      contentEl.createEl('p', {
        text: '提示：这位客户已付费/正在交付，建议先在本地档案补充“客户编号”，以后跨端匹配会更稳；本次仍可继续。',
      })
    }

    const diff = contentEl.createDiv({ cls: 'ai-linzi-vault-write-preview' })
    let changed = 0
    for (const [key, next] of Object.entries(this.profile.fields)) {
      const previous = existing ? (existing as unknown as Record<string, unknown>)[key] : undefined
      if (valueText(previous) === valueText(next)) continue
      changed += 1
      diff.createEl('p', {
        text: `${FIELD_LABELS[key] ?? key}：${valueText(previous)} → ${valueText(next)}`,
      })
    }
    if (changed === 0) diff.createEl('p', { text: '结构化字段没有变化。' })

    const canSyncArchive = this.profile.content.length <= 20_000
    let includeArchive = canSyncArchive
    new Setting(contentEl)
      .setName('同步完整客户档案正文')
      .setDesc(
        canSyncArchive
          ? `共 ${this.profile.content.length.toLocaleString('zh-CN')} 字；只同步当前这篇档案，不含逐字稿原文件。`
          : '正文超过 20,000 字，本次只同步结构化字段。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(canSyncArchive)
          .setDisabled(!canSyncArchive)
          .onChange((value) => { includeArchive = value }),
      )

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) => {
        button
          .setCta()
          .setButtonText(existing ? '确认更新 CRM' : '确认新建到 CRM')
          .onClick(() => {
            button.setDisabled(true)
            void (async () => {
              try {
                const response = (await this.client.api('/api/plugin/v1/customers/sync', {
                  method: 'POST',
                  body: {
                    mode: existing ? 'update' : 'create',
                    targetCustomerId: existing?.id,
                    expectedUpdatedAt: existing?.updatedAt,
                    fields: {
                      ...this.profile.fields,
                      ...(includeArchive ? { archiveMd: this.profile.content, archiveStatus: 'active' } : {}),
                    },
                  },
                })) as { ok?: boolean; customer?: CrmCustomer }
                if (!response.ok || !response.customer) throw new Error('服务器没有返回同步结果')
                await this.onSynced(response.customer)
                this.close()
                new Notice(`✅ 已${existing ? '更新' : '新建'} CRM 客户：${response.customer.customerCode || `${response.customer.seq}号`} · ${response.customer.name}`, 7000)
              } catch (error) {
                button.setDisabled(false)
                new Notice(`CRM 同步失败：${(error as Error).message}`, 9000)
              }
            })()
          })
      })
  }
}

export function openCustomerCrmSyncModal(
  app: App,
  client: CustomerCrmApi,
  profile: LocalCustomerProfile,
  onSynced: (customer: CrmCustomer) => Promise<void> | void,
): void {
  new CustomerCrmSyncModal(app, client, profile, onSynced).open()
}

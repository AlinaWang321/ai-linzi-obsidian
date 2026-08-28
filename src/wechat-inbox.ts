import {
  App,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
} from 'obsidian'
import qrcode from 'qrcode-generator'
import {
  WECHAT_INBOX_MAX_MEDIA_BYTES,
  WECHAT_ITEM_TYPE,
  appendRecentMessageKey,
  attachmentPath,
  dailyNoteHeader,
  detectImageExtension,
  isOwnedDirectMessage,
  localDateParts,
  messageTimestamp,
  normalizeWechatInboxFolder,
  renderWechatInboxEntry,
  safeWechatAttachmentName,
  safeWechatFileDecision,
  shortStableId,
  wechatMessageKey,
  wechatMessageMarker,
  type SavedWechatInboxPart,
  type WechatCdnMedia,
  type WechatInboundMessage,
  type WechatInboxConnection,
  type WechatInboxPersistedState,
} from './wechat-inbox-core'

const WECHAT_QR_API_BASE = 'https://ilinkai.weixin.qq.com'
const WECHAT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const WECHAT_APP_ID = 'bot'
const WECHAT_BOT_TYPE = '3'
const WECHAT_LONG_POLL_MS = 35_000
const WECHAT_REGULAR_REQUEST_MS = 15_000

interface WechatBaseInfo {
  channel_version: string
  bot_agent: string
}

interface WechatQrResponse {
  qrcode?: string
  qrcode_img_content?: string
}

type WechatQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

interface WechatQrStatusResponse {
  status?: WechatQrStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

interface WechatUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WechatInboundMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/**
 * 微信 iLink 需要 35 秒长轮询。Obsidian requestUrl 可绕过网页 CORS；这里把
 * 生命周期包装成 fetch 形状，stop/关闭弹窗时立即让调用方退出。底层请求可能
 * 仍由 Obsidian 在网络层收尾，但结果会被丢弃，不会继续写 Vault 或启动下一轮。
 */
const defaultWechatFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' || input instanceof URL
    ? String(input)
    : input.url
  const headers = new Headers(init?.headers)
  const headerRecord: Record<string, string> = {}
  headers.forEach((value, key) => {
    headerRecord[key] = value
  })
  const body = typeof init?.body === 'string' || init?.body instanceof ArrayBuffer
    ? init.body
    : undefined
  const request = requestUrl({
    url,
    method: init?.method ?? 'GET',
    headers: headerRecord,
    body,
    throw: false,
  }).then((response) => new Response(response.arrayBuffer, {
    status: response.status,
    headers: response.headers,
  }))
  const signal = init?.signal
  if (!signal) return await request
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError')
  return await new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void request.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

export type WechatInboxRuntimeStatus =
  | { kind: 'stopped'; text: string }
  | { kind: 'needs-connection'; text: string }
  | { kind: 'connecting'; text: string }
  | { kind: 'listening'; text: string; lastReceivedAt?: number; lastSavedPath?: string }
  | { kind: 'error'; text: string }

export interface WechatInboxManagerOptions {
  app: App
  pluginVersion: string
  enabled: () => boolean
  inboxFolder: () => string
  connection: () => WechatInboxConnection | null
  state: () => WechatInboxPersistedState
  persistState: (state: WechatInboxPersistedState) => Promise<void>
  reportStatus: (status: WechatInboxRuntimeStatus) => void
  fetchImpl?: typeof fetch
}

export function pluginVersionNumber(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function randomWechatUin(): string {
  const values = new Uint32Array(1)
  window.crypto.getRandomValues(values)
  return window.btoa(String(values[0] ?? 0))
}

function wechatHeaders(pluginVersion: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': WECHAT_APP_ID,
    'iLink-App-ClientVersion': String(pluginVersionNumber(pluginVersion)),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function baseInfo(pluginVersion: string): WechatBaseInfo {
  return {
    channel_version: pluginVersion,
    bot_agent: `AI-Linzi-Obsidian/${pluginVersion}`,
  }
}

function isAllowedWechatApiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      url.hostname === 'ilinkai.weixin.qq.com' ||
      (
        url.hostname.endsWith('.weixin.qq.com') &&
        !url.hostname.endsWith('.cdn.weixin.qq.com')
      )
    )
  } catch {
    return false
  }
}

function isAllowedWechatCdnUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      url.hostname === 'novac2c.cdn.weixin.qq.com' ||
      url.hostname.endsWith('.cdn.weixin.qq.com')
    )
  } catch {
    return false
  }
}

function safeWechatError(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === 'AbortError') return fallback
  if (!(error instanceof Error)) return fallback
  const message = error.message
    .replace(/Bearer\s+\S+/giu, 'Bearer ***')
    .replace(/(bot[_-]?token|token|aes[_-]?key)\s*[=:]\s*\S+/giu, '$1=***')
    .replace(/https:\/\/\S+/giu, '[微信服务地址]')
    .trim()
  return message.slice(0, 240) || fallback
}

function linkedAbortController(signal: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController
  cleanup: () => void
} {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = window.setTimeout(abort, timeoutMs)
  return {
    controller,
    cleanup: () => {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    },
  }
}

async function fetchJson<T>(params: {
  fetchImpl: typeof fetch
  url: string
  pluginVersion: string
  method: 'GET' | 'POST'
  token?: string
  body?: unknown
  signal?: AbortSignal
  timeoutMs: number
}): Promise<T> {
  const { controller, cleanup } = linkedAbortController(params.signal, params.timeoutMs)
  try {
    const response = await params.fetchImpl(params.url, {
      method: params.method,
      headers: wechatHeaders(params.pluginVersion, params.token),
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`微信服务暂时不可用（HTTP ${response.status}）`)
    return await response.json() as T
  } finally {
    cleanup()
  }
}

function qrSvg(payload: string): SVGSVGElement {
  const code = qrcode(0, 'M')
  code.addData(payload)
  code.make()
  const count = code.getModuleCount()
  const margin = 4
  const size = count + margin * 2
  const svg = createSvg('svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', '微信连接二维码')
  svg.addClass('ai-linzi-wechat-qr')
  const background = svg.createSvg('rect')
  background.setAttribute('width', String(size))
  background.setAttribute('height', String(size))
  background.setAttribute('fill', '#fff')
  const dark = svg.createSvg('path')
  let path = ''
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) path += `M${col + margin},${row + margin}h1v1h-1z`
    }
  }
  dark.setAttribute('d', path)
  dark.setAttribute('fill', '#111')
  return svg
}

export class WechatInboxConnectModal extends Modal {
  private readonly pluginVersion: string
  private readonly existingConnection: WechatInboxConnection | null
  private readonly onConnected: (connection: WechatInboxConnection) => Promise<void>
  private readonly fetchImpl: typeof fetch
  private abortController: AbortController | null = null
  private closed = false
  private statusEl: HTMLElement | null = null
  private qrEl: HTMLElement | null = null
  private verifyCode = ''

  constructor(params: {
    app: App
    pluginVersion: string
    existingConnection: WechatInboxConnection | null
    onConnected: (connection: WechatInboxConnection) => Promise<void>
    fetchImpl?: typeof fetch
  }) {
    super(params.app)
    this.pluginVersion = params.pluginVersion
    this.existingConnection = params.existingConnection
    this.onConnected = params.onConnected
    this.fetchImpl = params.fetchImpl ?? defaultWechatFetch
  }

  onOpen(): void {
    this.titleEl.setText('连接微信收件箱')
    this.contentEl.addClass('ai-linzi-wechat-connect')
    this.contentEl.createEl('p', {
      text: '请用微信扫描二维码并确认。连接成功后，只有你发给这个微信 Bot 的私聊内容会写入当前 Vault。',
    })
    this.qrEl = this.contentEl.createDiv({ cls: 'ai-linzi-wechat-qr-wrap' })
    this.statusEl = this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: '正在向微信获取二维码…',
    })
    void this.beginConnection()
  }

  onClose(): void {
    this.closed = true
    this.abortController?.abort()
    this.contentEl.empty()
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text)
  }

  private async beginConnection(): Promise<void> {
    this.abortController?.abort()
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    try {
      const response = await fetchJson<WechatQrResponse>({
        fetchImpl: this.fetchImpl,
        url: `${WECHAT_QR_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${WECHAT_BOT_TYPE}`,
        pluginVersion: this.pluginVersion,
        method: 'POST',
        body: {
          local_token_list: this.existingConnection?.token
            ? [this.existingConnection.token]
            : [],
        },
        signal,
        timeoutMs: WECHAT_REGULAR_REQUEST_MS,
      })
      const qrcodeId = response.qrcode?.trim()
      const payload = response.qrcode_img_content?.trim()
      if (!qrcodeId || !payload) throw new Error('微信没有返回可用的连接二维码')
      if (this.closed || signal.aborted) return
      this.qrEl?.empty()
      this.qrEl?.appendChild(qrSvg(payload))
      const link = this.qrEl?.createEl('a', {
        text: '二维码无法扫描？打开微信连接链接',
        href: payload,
        cls: 'ai-linzi-wechat-qr-link',
      })
      link?.setAttr('target', '_blank')
      link?.setAttr('rel', 'noopener noreferrer')
      this.setStatus('等待微信扫码…')
      await this.pollStatus(qrcodeId, WECHAT_QR_API_BASE, signal)
    } catch (error) {
      if (this.closed || signal.aborted) return
      this.setStatus(`连接失败：${safeWechatError(error, '请检查网络后重试')}`)
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('重新获取二维码').onClick(() => {
          void this.beginConnection()
        }))
    }
  }

  private async pollStatus(qrcodeId: string, initialBaseUrl: string, signal: AbortSignal): Promise<void> {
    let currentBaseUrl = initialBaseUrl
    while (!this.closed && !signal.aborted) {
      const verify = this.verifyCode
      this.verifyCode = ''
      const query = new URLSearchParams({ qrcode: qrcodeId })
      if (verify) query.set('verify_code', verify)
      let response: WechatQrStatusResponse
      try {
        response = await fetchJson<WechatQrStatusResponse>({
          fetchImpl: this.fetchImpl,
          url: `${currentBaseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
          pluginVersion: this.pluginVersion,
          method: 'GET',
          signal,
          timeoutMs: WECHAT_LONG_POLL_MS,
        })
      } catch (error) {
        if (signal.aborted || this.closed) return
        this.setStatus(`等待微信确认中…（${safeWechatError(error, '网络短暂波动')}）`)
        continue
      }
      if (response.status === 'wait') {
        this.setStatus('等待微信扫码…')
        continue
      }
      if (response.status === 'scaned') {
        this.setStatus('已经扫码，请在微信里确认连接…')
        continue
      }
      if (response.status === 'scaned_but_redirect') {
        const redirectHost = response.redirect_host?.trim()
        const redirected = redirectHost
          ? (/^https:\/\//iu.test(redirectHost) ? redirectHost : `https://${redirectHost}`)
          : ''
        if (!redirected || !isAllowedWechatApiUrl(redirected)) {
          throw new Error('微信返回了无法验证的连接地址')
        }
        currentBaseUrl = redirected.replace(/\/+$/u, '')
        continue
      }
      if (response.status === 'need_verifycode') {
        this.showVerifyCodeInput(qrcodeId, currentBaseUrl, signal)
        this.setStatus('微信要求输入配对码。请在下方填写后继续。')
        return
      }
      if (response.status === 'verify_code_blocked') {
        this.setStatus('配对码尝试过多，本次二维码已失效。请重新获取二维码。')
        return
      }
      if (response.status === 'expired') {
        this.setStatus('二维码已过期，正在重新生成…')
        await this.beginConnection()
        return
      }
      if (response.status === 'binded_redirect') {
        if (this.existingConnection) {
          this.setStatus('这个微信 Bot 已经连接，无需重复绑定。')
          await this.onConnected(this.existingConnection)
          this.close()
        } else {
          this.setStatus('这个微信 Bot 已绑定其他客户端。请先在微信侧解除原绑定，再重新连接。')
        }
        return
      }
      if (response.status === 'confirmed') {
        const token = response.bot_token?.trim()
        const botId = response.ilink_bot_id?.trim()
        const userId = response.ilink_user_id?.trim()
        const returnedBaseUrl = response.baseurl?.trim() || currentBaseUrl
        if (!token || !botId || !userId || !isAllowedWechatApiUrl(returnedBaseUrl)) {
          throw new Error('微信确认成功，但返回的连接信息不完整')
        }
        await this.onConnected({
          token,
          botId,
          userId,
          baseUrl: returnedBaseUrl.replace(/\/+$/u, ''),
          connectedAt: Date.now(),
        })
        if (!this.closed) {
          new Notice('✅ 微信收件箱已连接')
          this.close()
        }
        return
      }
    }
  }

  private showVerifyCodeInput(
    qrcodeId: string,
    currentBaseUrl: string,
    signal: AbortSignal,
  ): void {
    new Setting(this.contentEl)
      .setName('微信配对码')
      .setDesc('填写微信页面显示的配对码。')
      .addText((input) => input.setPlaceholder('输入配对码').onChange((value) => {
        this.verifyCode = value.trim()
      }))
      .addButton((button) => button.setButtonText('提交').setCta().onClick(() => {
        if (!this.verifyCode) {
          new Notice('请先填写配对码')
          return
        }
        void this.pollStatus(qrcodeId, currentBaseUrl, signal)
      }))
  }
}

export class WechatInboxManager {
  private readonly options: WechatInboxManagerOptions
  private abortController: AbortController | null = null
  private generation = 0

  constructor(options: WechatInboxManagerOptions) {
    this.options = options
  }

  start(): void {
    this.stop(false)
    if (!this.options.enabled()) {
      this.options.reportStatus({ kind: 'stopped', text: '接收已关闭' })
      return
    }
    const connection = this.options.connection()
    if (!connection) {
      this.options.reportStatus({ kind: 'needs-connection', text: '请先连接微信' })
      return
    }
    if (!isAllowedWechatApiUrl(connection.baseUrl)) {
      this.options.reportStatus({ kind: 'error', text: '微信连接地址无效，请重新连接' })
      return
    }
    const generation = ++this.generation
    this.abortController = new AbortController()
    this.options.reportStatus({ kind: 'connecting', text: '正在连接微信收件箱…' })
    void this.runLoop(connection, this.abortController.signal, generation)
  }

  restart(): void {
    this.start()
  }

  stop(report = true): void {
    this.generation += 1
    this.abortController?.abort()
    this.abortController = null
    if (report) this.options.reportStatus({ kind: 'stopped', text: '接收已停止' })
  }

  private async runLoop(
    connection: WechatInboxConnection,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    let failures = 0
    let longPollTimeout = WECHAT_LONG_POLL_MS
    while (
      !signal.aborted &&
      generation === this.generation &&
      this.options.enabled()
    ) {
      try {
        const current = this.options.state()
        const response = await fetchJson<WechatUpdatesResponse>({
          fetchImpl: this.options.fetchImpl ?? defaultWechatFetch,
          url: `${connection.baseUrl}/ilink/bot/getupdates`,
          pluginVersion: this.options.pluginVersion,
          method: 'POST',
          token: connection.token,
          body: {
            get_updates_buf: current.cursor,
            base_info: baseInfo(this.options.pluginVersion),
          },
          signal,
          timeoutMs: longPollTimeout + 5_000,
        })
        if (signal.aborted) return
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(`微信会话异常（${response.errcode ?? response.ret ?? 'unknown'}）`)
        }
        for (const message of response.msgs ?? []) {
          if (!isOwnedDirectMessage(message, connection.userId)) continue
          await this.processMessage(connection, message, signal)
          if (signal.aborted || generation !== this.generation) return
        }
        const state = this.options.state()
        const nextCursor = typeof response.get_updates_buf === 'string'
          ? response.get_updates_buf
          : state.cursor
        if (nextCursor !== state.cursor) {
          await this.options.persistState({ ...state, cursor: nextCursor })
        }
        if (
          typeof response.longpolling_timeout_ms === 'number' &&
          response.longpolling_timeout_ms >= 10_000 &&
          response.longpolling_timeout_ms <= 60_000
        ) {
          longPollTimeout = response.longpolling_timeout_ms
        }
        failures = 0
        const latest = this.options.state()
        this.options.reportStatus({
          kind: 'listening',
          text: '正在后台接收',
          lastReceivedAt: latest.lastReceivedAt,
          lastSavedPath: latest.lastSavedPath,
        })
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return
        failures += 1
        const waitMs = failures >= 5 ? 30_000 : Math.min(10_000, failures * 2_000)
        this.options.reportStatus({
          kind: 'error',
          text: `${safeWechatError(error, '微信连接暂时中断')}，${Math.round(waitMs / 1000)} 秒后重试`,
        })
        await this.waitForRetry(waitMs, signal)
      }
    }
  }

  private waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const finish = () => {
        window.clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = window.setTimeout(finish, ms)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private async processMessage(
    connection: WechatInboxConnection,
    message: WechatInboundMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    const rawKey = wechatMessageKey(message)
    const messageKey = rawKey.replace(/:/gu, '')
      ? rawKey
      : `fallback:${shortStableId(JSON.stringify({
          from: message.from_user_id,
          time: messageTimestamp(message),
          items: (message.item_list ?? []).map((item) => [item.type, item.msg_id ?? '']),
        }))}`
    const timestamp = messageTimestamp(message)
    const inboxRoot = normalizeWechatInboxFolder(this.options.inboxFolder())
    const state = this.options.state()
    const notePath = this.dailyNotePath(timestamp, inboxRoot)
    if (
      state.recentMessageKeys.includes(messageKey) ||
      await this.noteContainsMarker(notePath, wechatMessageMarker(messageKey))
    ) {
      return
    }

    const parts: SavedWechatInboxPart[] = []
    const deferred: string[] = []
    for (const [itemIndex, item] of (message.item_list ?? []).entries()) {
      const itemKey = item.msg_id
        ? `${messageKey}:${item.msg_id}`
        : `${messageKey}:item-${itemIndex}`
      if (item.type === WECHAT_ITEM_TYPE.TEXT) {
        const text = item.text_item?.text?.trim()
        if (text) parts.push({ kind: 'text', text })
      } else if (item.type === WECHAT_ITEM_TYPE.VOICE) {
        const transcript = item.voice_item?.text?.trim()
        if (transcript) parts.push({ kind: 'voice-transcript', text: transcript })
        else deferred.push('这条语音没有微信转写文字，当前版本未保存语音原声')
      } else if (item.type === WECHAT_ITEM_TYPE.IMAGE) {
        const image = await this.saveImage(item.image_item?.media, item.image_item?.aeskey, {
          timestamp,
          messageKey: itemKey,
          inboxRoot,
        }, signal)
        if (signal?.aborted) return
        parts.push({ kind: 'image', path: image })
      } else if (item.type === WECHAT_ITEM_TYPE.FILE) {
        const filename = safeWechatAttachmentName(item.file_item?.file_name ?? 'file')
        const decision = safeWechatFileDecision(filename)
        if (decision === 'deferred-media') {
          deferred.push(`暂未保存媒体文件：${filename}`)
          continue
        }
        if (decision === 'unsupported') {
          deferred.push(`暂不支持这个文件类型：${filename}`)
          continue
        }
        const expectedBytes = Number.parseInt(item.file_item?.len ?? '', 10)
        if (Number.isFinite(expectedBytes) && expectedBytes > WECHAT_INBOX_MAX_MEDIA_BYTES) {
          deferred.push(`文件超过 25MB，未保存：${filename}`)
          continue
        }
        const path = await this.saveFile(item.file_item?.media, filename, {
          timestamp,
          messageKey: itemKey,
          inboxRoot,
        }, signal)
        if (signal?.aborted) return
        parts.push({ kind: 'file', path, name: filename })
      } else if (item.type === WECHAT_ITEM_TYPE.VIDEO) {
        deferred.push('当前版本暂不保存视频')
      }
    }

    let savedPath: string | undefined
    if (parts.length > 0) {
      if (signal?.aborted) return
      await this.appendEntry(notePath, renderWechatInboxEntry({ timestamp, messageKey, parts }))
      savedPath = notePath
    }
    if (signal?.aborted) return
    const nextState: WechatInboxPersistedState = {
      ...this.options.state(),
      recentMessageKeys: appendRecentMessageKey(this.options.state().recentMessageKeys, messageKey),
      lastReceivedAt: Date.now(),
      lastSavedPath: savedPath ?? this.options.state().lastSavedPath,
    }
    await this.options.persistState(nextState)
    if (signal?.aborted) return
    const reply = savedPath
      ? `已保存到 Obsidian：${savedPath}${deferred.length ? `\n${deferred.join('；')}` : ''}`
      : deferred.join('；') || '这条消息没有可保存的内容'
    try {
      await this.acknowledge(connection, message, reply)
    } catch {
      // 保存结果是主事实；微信回执失败不应导致重复写入或回滚用户文件。
    }
  }

  private dailyNotePath(
    timestamp: number,
    root = normalizeWechatInboxFolder(this.options.inboxFolder()),
  ): string {
    return normalizePath(`${root}/${localDateParts(timestamp).date}.md`)
  }

  private async noteContainsMarker(path: string, marker: string): Promise<boolean> {
    const file = this.options.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return false
    const content = await this.options.app.vault.cachedRead(file)
    return content.includes(marker)
  }

  private async appendEntry(path: string, entry: string): Promise<void> {
    await this.ensureFolder(path.split('/').slice(0, -1).join('/'))
    const existing = this.options.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFolder) throw new Error(`微信收件箱目标被同名文件夹占用：${path}`)
    if (!(existing instanceof TFile)) {
      const date = path.split('/').at(-1)?.replace(/\.md$/u, '') ?? localDateParts(Date.now()).date
      await this.options.app.vault.create(path, `${dailyNoteHeader(date)}${entry}`)
      return
    }
    const marker = entry.match(/<!-- ai-linzi-wechat:[a-f0-9]+ -->/u)?.[0]
    await this.options.app.vault.process(existing, (content) => {
      if (marker && content.includes(marker)) return content
      return `${content.trimEnd()}\n\n${entry}`
    })
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path)
    if (!normalized || normalized === '/') return
    const parts = normalized.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const existing = this.options.app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFile) throw new Error(`路径被同名文件占用：${current}`)
      if (!existing) await this.options.app.vault.createFolder(current)
    }
  }

  private async saveImage(
    media: WechatCdnMedia | undefined,
    directHexKey: string | undefined,
    identity: { timestamp: number; messageKey: string; inboxRoot: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const bytes = await this.downloadMedia(media, directHexKey, '图片', true, signal)
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    const extension = detectImageExtension(bytes)
    if (!extension) throw new Error('微信图片格式无法识别，未写入 Vault')
    const path = normalizePath(attachmentPath({
      root: identity.inboxRoot,
      timestamp: identity.timestamp,
      messageKey: identity.messageKey,
      kind: 'image',
      imageExtension: extension,
    }))
    await this.writeBinaryOnce(path, bytes)
    return path
  }

  private async saveFile(
    media: WechatCdnMedia | undefined,
    filename: string,
    identity: { timestamp: number; messageKey: string; inboxRoot: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const bytes = await this.downloadMedia(media, undefined, '文件', false, signal)
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    const path = normalizePath(attachmentPath({
      root: identity.inboxRoot,
      timestamp: identity.timestamp,
      messageKey: identity.messageKey,
      kind: 'file',
      filename,
    }))
    await this.writeBinaryOnce(path, bytes)
    return path
  }

  private async writeBinaryOnce(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureFolder(path.split('/').slice(0, -1).join('/'))
    const existing = this.options.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFolder) throw new Error(`附件路径被同名文件夹占用：${path}`)
    if (existing instanceof TFile) return
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    await this.options.app.vault.createBinary(path, copy.buffer)
  }

  private async downloadMedia(
    media: WechatCdnMedia | undefined,
    directHexKey: string | undefined,
    label: string,
    allowPlain: boolean,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!media) throw new Error(`${label}缺少微信下载信息`)
    const url = media.full_url?.trim() || (
      media.encrypt_query_param
        ? `${WECHAT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
        : ''
    )
    if (!url || !isAllowedWechatCdnUrl(url)) throw new Error(`${label}下载地址无法验证`)
    const response = await (this.options.fetchImpl ?? defaultWechatFetch)(url, {
      redirect: 'error',
      signal,
    })
    if (!response.ok) throw new Error(`${label}下载失败（HTTP ${response.status}）`)
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(contentLength) && contentLength > WECHAT_INBOX_MAX_MEDIA_BYTES + 16) {
      throw new Error(`${label}超过 25MB，未保存`)
    }
    const encrypted = new Uint8Array(await response.arrayBuffer())
    if (encrypted.byteLength > WECHAT_INBOX_MAX_MEDIA_BYTES + 16) {
      throw new Error(`${label}超过 25MB，未保存`)
    }
    const key = this.parseMediaKey(directHexKey, media.aes_key)
    if (!key) {
      if (!allowPlain) throw new Error(`${label}缺少微信解密信息`)
      return encrypted
    }
    const cryptoModule = await import('crypto')
    const decipher = cryptoModule.createDecipheriv('aes-128-ecb', key, null)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    if (decrypted.byteLength > WECHAT_INBOX_MAX_MEDIA_BYTES) {
      throw new Error(`${label}超过 25MB，未保存`)
    }
    return new Uint8Array(decrypted)
  }

  private parseMediaKey(directHexKey?: string, encodedKey?: string): Buffer | null {
    const direct = directHexKey?.trim()
    if (direct) {
      if (!/^[0-9a-f]{32}$/iu.test(direct)) throw new Error('微信媒体解密信息无效')
      return Buffer.from(direct, 'hex')
    }
    const encoded = encodedKey?.trim()
    if (!encoded) return null
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.byteLength === 16) return decoded
    if (decoded.byteLength === 32 && /^[0-9a-f]{32}$/iu.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex')
    }
    throw new Error('微信媒体解密信息无效')
  }

  private async acknowledge(
    connection: WechatInboxConnection,
    message: WechatInboundMessage,
    text: string,
  ): Promise<void> {
    const response = await fetchJson<{ ret?: number; errmsg?: string }>({
      fetchImpl: this.options.fetchImpl ?? defaultWechatFetch,
      url: `${connection.baseUrl}/ilink/bot/sendmessage`,
      pluginVersion: this.options.pluginVersion,
      method: 'POST',
      token: connection.token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: connection.userId,
          client_id: `ai-linzi-${Date.now()}-${shortStableId(message.context_token ?? '')}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: WECHAT_ITEM_TYPE.TEXT, text_item: { text } }],
          context_token: message.context_token,
        },
        base_info: baseInfo(this.options.pluginVersion),
      },
      timeoutMs: WECHAT_REGULAR_REQUEST_MS,
    })
    if ((response.ret ?? 0) !== 0) throw new Error('微信保存回执发送失败')
  }
}

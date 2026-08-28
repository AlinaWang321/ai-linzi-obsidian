export const WECHAT_MESSAGE_TYPE_USER = 1

export const WECHAT_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export const WECHAT_INBOX_MAX_MEDIA_BYTES = 25 * 1024 * 1024
export const WECHAT_INBOX_RECENT_MESSAGE_LIMIT = 300

const SAFE_FILE_EXTENSIONS = new Set([
  '7z',
  'csv',
  'doc',
  'docx',
  'epub',
  'gif',
  'heic',
  'html',
  'jpeg',
  'jpg',
  'json',
  'md',
  'numbers',
  'pages',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'rar',
  'rtf',
  'txt',
  'webp',
  'xls',
  'xlsx',
  'zip',
])

const DEFERRED_MEDIA_EXTENSIONS = new Set([
  'aac',
  'amr',
  'avi',
  'flac',
  'flv',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'ogg',
  'opus',
  'silk',
  'wav',
  'webm',
  'wma',
  'wmv',
])

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

function removeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20)
    .join('')
}

export interface WechatCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

export interface WechatMessageItem {
  type?: number
  create_time_ms?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: {
    media?: WechatCdnMedia
    aeskey?: string
  }
  voice_item?: {
    media?: WechatCdnMedia
    text?: string
  }
  file_item?: {
    media?: WechatCdnMedia
    file_name?: string
    len?: string
  }
}

export interface WechatInboundMessage {
  seq?: number
  message_id?: number
  client_id?: string
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  group_id?: string
  message_type?: number
  item_list?: WechatMessageItem[]
  context_token?: string
}

export interface WechatInboxConnection {
  token: string
  baseUrl: string
  botId: string
  userId: string
  connectedAt: number
}

export interface WechatInboxPersistedState {
  cursor: string
  recentMessageKeys: string[]
  lastReceivedAt?: number
  lastSavedPath?: string
}

export type SavedWechatInboxPart =
  | { kind: 'text'; text: string }
  | { kind: 'voice-transcript'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'file'; path: string; name: string }

export function defaultWechatInboxState(): WechatInboxPersistedState {
  return { cursor: '', recentMessageKeys: [] }
}

export function storedWechatInboxState(value: unknown): WechatInboxPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultWechatInboxState()
  const raw = value as Record<string, unknown>
  const cursor = typeof raw.cursor === 'string' && raw.cursor.length <= 1_000_000
    ? raw.cursor
    : ''
  const recentMessageKeys = Array.isArray(raw.recentMessageKeys)
    ? raw.recentMessageKeys
        .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200)
        .slice(-WECHAT_INBOX_RECENT_MESSAGE_LIMIT)
    : []
  const lastReceivedAt = typeof raw.lastReceivedAt === 'number' && Number.isFinite(raw.lastReceivedAt)
    ? raw.lastReceivedAt
    : undefined
  const lastSavedPath = typeof raw.lastSavedPath === 'string' && raw.lastSavedPath.length <= 500
    ? raw.lastSavedPath
    : undefined
  return { cursor, recentMessageKeys, lastReceivedAt, lastSavedPath }
}

export function parseWechatInboxConnection(value: string): WechatInboxConnection | null {
  try {
    const raw = JSON.parse(value) as Partial<WechatInboxConnection>
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.replace(/\/+$/u, '') : ''
    const parsedBaseUrl = new URL(baseUrl)
    if (
      typeof raw.token !== 'string' || !raw.token.trim() ||
      parsedBaseUrl.protocol !== 'https:' ||
      !(
        parsedBaseUrl.hostname === 'ilinkai.weixin.qq.com' ||
        (
          parsedBaseUrl.hostname.endsWith('.weixin.qq.com') &&
          !parsedBaseUrl.hostname.endsWith('.cdn.weixin.qq.com')
        )
      ) ||
      typeof raw.botId !== 'string' || !raw.botId.trim() ||
      typeof raw.userId !== 'string' || !raw.userId.trim()
    ) {
      return null
    }
    return {
      token: raw.token.trim(),
      baseUrl,
      botId: raw.botId.trim(),
      userId: raw.userId.trim(),
      connectedAt: typeof raw.connectedAt === 'number' && Number.isFinite(raw.connectedAt)
        ? raw.connectedAt
        : Date.now(),
    }
  } catch {
    return null
  }
}

export function serializeWechatInboxConnection(connection: WechatInboxConnection): string {
  return JSON.stringify(connection)
}

export function normalizeWechatInboxFolder(value: string): string {
  const parts = value
    .replace(/\\/gu, '/')
    .split('/')
    .map((part) => part.normalize('NFKC').trim())
    .filter(Boolean)
  const safe = parts
    .filter((part) => part !== '.' && part !== '..' && !part.startsWith('.'))
    .map((part) => removeControlCharacters(part).replace(/[<>:"|?*]/gu, '').trim())
    .filter(Boolean)
    .slice(0, 6)
  return safe.join('/') || '000_Inbox/微信收件箱'
}

export function isOwnedDirectMessage(message: WechatInboundMessage, userId: string): boolean {
  return (
    message.message_type === WECHAT_MESSAGE_TYPE_USER &&
    message.from_user_id === userId &&
    !message.group_id
  )
}

export function wechatMessageKey(message: WechatInboundMessage): string {
  const itemIds = (message.item_list ?? [])
    .map((item) => item.msg_id ?? '')
    .filter(Boolean)
    .join(',')
  return [
    message.message_id ?? '',
    message.seq ?? '',
    message.client_id ?? '',
    message.create_time_ms ?? '',
    itemIds,
  ].join(':')
}

export function shortStableId(value: string): string {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function wechatMessageMarker(messageKey: string): string {
  return `<!-- ai-linzi-wechat:${shortStableId(messageKey)} -->`
}

export function messageTimestamp(message: WechatInboundMessage, now = Date.now()): number {
  const itemTimestamp = message.item_list
    ?.map((item) => item.create_time_ms ?? 0)
    .find((value) => value > 0)
  const candidate = itemTimestamp || message.create_time_ms || now
  return Number.isFinite(candidate) && candidate > 0 ? candidate : now
}

export function localDateParts(timestamp: number): { date: string; time: string; compactTime: string } {
  const value = new Date(timestamp)
  const year = String(value.getFullYear()).padStart(4, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hour = String(value.getHours()).padStart(2, '0')
  const minute = String(value.getMinutes()).padStart(2, '0')
  const second = String(value.getSeconds()).padStart(2, '0')
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    compactTime: `${hour}${minute}${second}`,
  }
}

export function safeWechatAttachmentName(value: string): string {
  const basename = value.replace(/\\/gu, '/').split('/').at(-1) ?? 'file'
  let safe = basename
    .normalize('NFKC')
  safe = removeControlCharacters(safe)
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/^\.+/u, '')
    .replace(/[. ]+$/u, '')
    .trim()
  if (!safe) safe = 'file'
  if (WINDOWS_RESERVED_NAMES.test(safe)) safe = `_${safe}`
  if (safe.length > 96) {
    const dot = safe.lastIndexOf('.')
    const extension = dot > 0 ? safe.slice(dot, dot + 16) : ''
    safe = `${safe.slice(0, Math.max(1, 96 - extension.length))}${extension}`
  }
  return safe
}

export function fileExtension(value: string): string {
  const safe = safeWechatAttachmentName(value)
  const dot = safe.lastIndexOf('.')
  return dot > 0 ? safe.slice(dot + 1).toLocaleLowerCase() : ''
}

export function safeWechatFileDecision(value: string): 'allow' | 'deferred-media' | 'unsupported' {
  const extension = fileExtension(value)
  if (DEFERRED_MEDIA_EXTENSIONS.has(extension)) return 'deferred-media'
  return SAFE_FILE_EXTENSIONS.has(extension) ? 'allow' : 'unsupported'
}

export function detectImageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | 'gif' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'webp'
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'gif'
  }
  return null
}

export function attachmentPath(params: {
  root: string
  timestamp: number
  messageKey: string
  kind: 'image' | 'file'
  filename?: string
  imageExtension?: string
}): string {
  const parts = localDateParts(params.timestamp)
  const id = shortStableId(params.messageKey)
  const filename = params.kind === 'image'
    ? `${parts.compactTime}-${id}.${params.imageExtension ?? 'jpg'}`
    : `${parts.compactTime}-${id}-${safeWechatAttachmentName(params.filename ?? 'file')}`
  return `${normalizeWechatInboxFolder(params.root)}/attachments/${parts.date}/${filename}`
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_{}[\]()#+.!|>-])/gu, '\\$1')
}

function quoteText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => `> ${escapeMarkdownText(line)}`)
    .join('\n')
}

export function dailyNoteHeader(date: string): string {
  return [
    '---',
    'source: wechat-inbox',
    `date: ${date}`,
    '---',
    '',
    `# 微信收件箱 · ${date}`,
    '',
  ].join('\n')
}

export function renderWechatInboxEntry(params: {
  timestamp: number
  messageKey: string
  parts: SavedWechatInboxPart[]
}): string {
  const { time } = localDateParts(params.timestamp)
  const lines = [`## ${time}`]
  for (const part of params.parts) {
    if (part.kind === 'text') {
      lines.push('', '**文字**', '', quoteText(part.text))
    } else if (part.kind === 'voice-transcript') {
      lines.push('', '**语音转写**', '', quoteText(part.text))
    } else if (part.kind === 'image') {
      lines.push('', '**图片**', '', `![[${part.path}]]`)
    } else {
      lines.push('', '**文件**', '', `[[${part.path}|${escapeMarkdownText(part.name)}]]`)
    }
  }
  lines.push('', wechatMessageMarker(params.messageKey), '')
  return lines.join('\n')
}

export function appendRecentMessageKey(
  current: string[],
  messageKey: string,
): string[] {
  return [...current.filter((key) => key !== messageKey), messageKey]
    .slice(-WECHAT_INBOX_RECENT_MESSAGE_LIMIT)
}

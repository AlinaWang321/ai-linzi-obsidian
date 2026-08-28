import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createCipheriv, randomBytes } from 'node:crypto'

const bundled = await build({
  entryPoints: ['src/wechat-inbox-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const inbox = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

console.log('微信收件箱第1组：路径与文件类型安全')
assert.equal(inbox.normalizeWechatInboxFolder(' 000_Inbox\\微信收件箱 '), '000_Inbox/微信收件箱')
assert.equal(inbox.normalizeWechatInboxFolder('../../.obsidian/plugins'), 'plugins')
assert.equal(inbox.normalizeWechatInboxFolder(''), '000_Inbox/微信收件箱')
assert.equal(inbox.safeWechatAttachmentName('../../CON.pdf'), '_CON.pdf')
assert.equal(inbox.safeWechatAttachmentName('a\u0000b?.txt'), 'ab-.txt')
assert.equal(inbox.safeWechatFileDecision('讲义.pdf'), 'allow')
assert.equal(inbox.safeWechatFileDecision('录音.MP3'), 'deferred-media')
assert.equal(inbox.safeWechatFileDecision('视频.mp4'), 'deferred-media')
assert.equal(inbox.safeWechatFileDecision('程序.exe'), 'unsupported')

console.log('微信收件箱第2组：连接与消息身份')
const connection = {
  token: 'secret-token',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  botId: 'bot-1',
  userId: 'user-1',
  connectedAt: 1,
}
assert.deepEqual(inbox.parseWechatInboxConnection(JSON.stringify(connection)), connection)
assert.equal(
  inbox.parseWechatInboxConnection(JSON.stringify({ ...connection, baseUrl: 'https://evil.example' })),
  null,
  '不得把微信 token 发往任意服务器',
)
assert.equal(
  inbox.parseWechatInboxConnection(JSON.stringify({ ...connection, baseUrl: 'https://novac2c.cdn.weixin.qq.com' })),
  null,
  'CDN 域名不能被冒充成 API 域名',
)
const owned = {
  message_type: inbox.WECHAT_MESSAGE_TYPE_USER,
  from_user_id: 'user-1',
  item_list: [{ type: inbox.WECHAT_ITEM_TYPE.TEXT, msg_id: 'item-1' }],
  message_id: 3,
  seq: 4,
}
assert.equal(inbox.isOwnedDirectMessage(owned, 'user-1'), true)
assert.equal(inbox.isOwnedDirectMessage({ ...owned, group_id: 'group' }, 'user-1'), false)
assert.equal(inbox.isOwnedDirectMessage({ ...owned, from_user_id: 'other' }, 'user-1'), false)
assert.equal(inbox.wechatMessageKey(owned), '3:4:::item-1')

console.log('微信收件箱第3组：图片识别、确定性附件与幂等标记')
assert.equal(inbox.detectImageExtension(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'png')
assert.equal(inbox.detectImageExtension(Uint8Array.from([0xff, 0xd8, 0xff])), 'jpg')
assert.equal(inbox.detectImageExtension(new TextEncoder().encode('GIF89a')), 'gif')
assert.equal(inbox.detectImageExtension(new TextEncoder().encode('not-an-image')), null)
const timestamp = new Date(2026, 7, 28, 9, 8, 7).getTime()
const firstPath = inbox.attachmentPath({
  root: '000_Inbox/微信收件箱',
  timestamp,
  messageKey: 'stable-message',
  kind: 'file',
  filename: '课堂讲义.pdf',
})
assert.equal(
  firstPath,
  inbox.attachmentPath({
    root: '000_Inbox/微信收件箱',
    timestamp,
    messageKey: 'stable-message',
    kind: 'file',
    filename: '课堂讲义.pdf',
  }),
  '同一微信消息重试时必须得到同一个附件路径',
)
const rendered = inbox.renderWechatInboxEntry({
  timestamp,
  messageKey: 'stable-message',
  parts: [
    { kind: 'text', text: '标题 #1\n第二行' },
    { kind: 'voice-transcript', text: '微信已转写' },
    { kind: 'image', path: 'attachments/a.png' },
    { kind: 'file', path: firstPath, name: '课堂讲义.pdf' },
  ],
})
assert.match(rendered, /\*\*文字\*\*/)
assert.match(rendered, /\*\*语音转写\*\*/)
assert.match(rendered, /!\[\[attachments\/a\.png\]\]/)
assert.match(rendered, /<!-- ai-linzi-wechat:[a-f0-9]{8} -->/)
assert.match(rendered, /> 标题 \\#1/, '用户文本必须转义，不能注入 Markdown 标题')
let recent = []
for (let i = 0; i < 350; i += 1) recent = inbox.appendRecentMessageKey(recent, `m-${i}`)
assert.equal(recent.length, inbox.WECHAT_INBOX_RECENT_MESSAGE_LIMIT)
assert.equal(recent.at(-1), 'm-349')

console.log('微信收件箱第3b组：真实 AES-128-ECB 媒体解密与下载门禁')
const runtimeBundle = await build({
  entryPoints: ['src/wechat-inbox.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'obsidian-test-stub',
    setup(esbuild) {
      esbuild.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
      esbuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'js',
        contents: `
          export class App {}
          export class Modal {}
          export class Notice {}
          export class Setting {}
          export class TFile {}
          export class TFolder {}
          export const normalizePath = (value) => value.replaceAll('\\\\', '/');
          export const requestUrl = async (...args) => globalThis.__obsidianRequestUrl(...args);
        `,
      }))
    },
  }],
})
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(runtimeBundle.outputFiles[0].text).toString('base64')}`
)
assert.equal(runtime.pluginVersionNumber('1.0.11'), 65_547, '客户端版本编码必须与微信官方 0x00MMNNPP 一致')
assert.equal(runtime.pluginVersionNumber('0.7.101'), 1_893)
const key = randomBytes(16)
const plainPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3])
const cipher = createCipheriv('aes-128-ecb', key, null)
const encryptedPng = Buffer.concat([cipher.update(plainPng), cipher.final()])
let responseFactory = () => new Response(encryptedPng, {
  status: 200,
  headers: { 'content-length': String(encryptedPng.byteLength) },
})
const manager = new runtime.WechatInboxManager({
  app: { vault: {} },
  pluginVersion: '0.7.101',
  inboxFolder: () => '000_Inbox/微信收件箱',
  connection: () => null,
  state: () => inbox.defaultWechatInboxState(),
  persistState: async () => undefined,
  reportStatus: () => undefined,
  fetchImpl: async () => responseFactory(),
})
const rawBase64 = key.toString('base64')
const decryptedRawKey = await manager.downloadMedia({
  full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=1',
  aes_key: rawBase64,
}, undefined, '图片', true)
assert.deepEqual(Buffer.from(decryptedRawKey), plainPng, 'base64 原始 16 字节密钥必须可解密')
const asciiHexBase64 = Buffer.from(key.toString('hex'), 'ascii').toString('base64')
const decryptedHexKey = await manager.downloadMedia({
  full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=2',
  aes_key: asciiHexBase64,
}, undefined, '文件', false)
assert.deepEqual(Buffer.from(decryptedHexKey), plainPng, 'base64 包裹 hex 的微信文件密钥必须可解密')
let obsidianNetworkRequest = null
globalThis.__obsidianRequestUrl = async (params) => {
  obsidianNetworkRequest = params
  return {
    status: 200,
    headers: { 'content-length': String(encryptedPng.byteLength) },
    arrayBuffer: encryptedPng.buffer.slice(
      encryptedPng.byteOffset,
      encryptedPng.byteOffset + encryptedPng.byteLength,
    ),
  }
}
const defaultNetworkManager = new runtime.WechatInboxManager({
  app: { vault: {} },
  pluginVersion: '0.7.101',
  inboxFolder: () => '000_Inbox/微信收件箱',
  connection: () => null,
  state: () => inbox.defaultWechatInboxState(),
  persistState: async () => undefined,
  reportStatus: () => undefined,
})
const decryptedViaObsidian = await defaultNetworkManager.downloadMedia({
  full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?official-network',
  aes_key: rawBase64,
}, undefined, '图片', true)
assert.deepEqual(Buffer.from(decryptedViaObsidian), plainPng)
assert.equal(
  obsidianNetworkRequest.url,
  'https://novac2c.cdn.weixin.qq.com/c2c/download?official-network',
  '默认网络链必须真正走 Obsidian requestUrl',
)
await assert.rejects(
  manager.downloadMedia({
    full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=3',
  }, undefined, '文件', false),
  /缺少微信解密信息/,
)
await assert.rejects(
  manager.downloadMedia({
    full_url: 'https://evil.example/download?id=4',
    aes_key: rawBase64,
  }, undefined, '图片', true),
  /下载地址无法验证/,
)
responseFactory = () => new Response(new Uint8Array(), {
  status: 200,
  headers: { 'content-length': String(inbox.WECHAT_INBOX_MAX_MEDIA_BYTES + 17) },
})
await assert.rejects(
  manager.downloadMedia({
    full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=5',
    aes_key: rawBase64,
  }, undefined, '图片', true),
  /超过 25MB/,
)

console.log('微信收件箱第3c组：文字 + 微信语音转写真实写入与幂等')
globalThis.window = {
  crypto: globalThis.crypto,
  btoa: globalThis.btoa,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  fetch: globalThis.fetch,
}
const createdNotes = []
const createdFolders = new Map()
const ackUrls = []
let persistedState = inbox.defaultWechatInboxState()
const integrationManager = new runtime.WechatInboxManager({
  app: {
    vault: {
      getAbstractFileByPath: (path) => createdFolders.get(path) ?? null,
      createFolder: async (path) => {
        createdFolders.set(path, { path, kind: 'folder' })
      },
      create: async (path, content) => {
        createdNotes.push({ path, content })
        createdFolders.set(path, { path, kind: 'file', content })
      },
    },
  },
  pluginVersion: '0.7.101',
  inboxFolder: () => '000_Inbox/微信收件箱',
  connection: () => connection,
  state: () => persistedState,
  persistState: async (value) => {
    persistedState = value
  },
  reportStatus: () => undefined,
  fetchImpl: async (url) => {
    ackUrls.push(String(url))
    return new Response(JSON.stringify({ ret: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  },
})
const textAndTranscriptMessage = {
  ...owned,
  create_time_ms: timestamp,
  context_token: 'context-1',
  item_list: [
    { type: inbox.WECHAT_ITEM_TYPE.TEXT, msg_id: 'text-1', text_item: { text: '课堂灵感' } },
    { type: inbox.WECHAT_ITEM_TYPE.VOICE, msg_id: 'voice-1', voice_item: { text: '这是微信转写' } },
  ],
}
await integrationManager.processMessage(connection, textAndTranscriptMessage)
assert.equal(createdNotes.length, 1)
assert.match(createdNotes[0].path, /000_Inbox\/微信收件箱\/2026-08-28\.md$/)
assert.match(createdNotes[0].content, /课堂灵感/)
assert.match(createdNotes[0].content, /这是微信转写/)
assert.equal(persistedState.recentMessageKeys.length, 1)
assert.equal(ackUrls.filter((url) => url.endsWith('/ilink/bot/sendmessage')).length, 1)
await integrationManager.processMessage(connection, textAndTranscriptMessage)
assert.equal(createdNotes.length, 1, '同一消息重放不得重复写入')
assert.equal(ackUrls.filter((url) => url.endsWith('/ilink/bot/sendmessage')).length, 1)

console.log('微信收件箱第3d组：图片 + 普通文件真实解密写入')
const encryptEcb = (plain) => {
  const mediaCipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([mediaCipher.update(plain), mediaCipher.final()])
}
const fileBytes = Buffer.from('%PDF-1.7\nAI Linzi test')
const encryptedFile = encryptEcb(fileBytes)
const binaryWrites = []
const mediaNotes = []
const mediaEntries = new Map()
let mediaState = inbox.defaultWechatInboxState()
let mediaInboxFolder = '000_Inbox/微信收件箱'
const mediaManager = new runtime.WechatInboxManager({
  app: {
    vault: {
      getAbstractFileByPath: (path) => mediaEntries.get(path) ?? null,
      createFolder: async (path) => {
        mediaEntries.set(path, { path, kind: 'folder' })
      },
      createBinary: async (path, buffer) => {
        binaryWrites.push({ path, bytes: Buffer.from(buffer) })
        mediaEntries.set(path, { path, kind: 'file' })
      },
      create: async (path, content) => {
        mediaNotes.push({ path, content })
        mediaEntries.set(path, { path, kind: 'file' })
      },
    },
  },
  pluginVersion: '0.7.101',
  inboxFolder: () => mediaInboxFolder,
  connection: () => connection,
  state: () => mediaState,
  persistState: async (value) => {
    mediaState = value
  },
  reportStatus: () => undefined,
  fetchImpl: async (url) => {
    const value = String(url)
    if (value.includes('image-a') || value.includes('image-b')) {
      mediaInboxFolder = '999_Changed_During_Download'
      return new Response(encryptedPng, { status: 200 })
    }
    if (value.includes('file-a')) return new Response(encryptedFile, { status: 200 })
    return new Response(JSON.stringify({ ret: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  },
})
await mediaManager.processMessage(connection, {
  ...owned,
  message_id: 30,
  seq: 40,
  create_time_ms: timestamp,
  context_token: 'context-media',
  item_list: [
    {
      type: inbox.WECHAT_ITEM_TYPE.IMAGE,
      msg_id: 'image-a',
      image_item: {
        media: {
          full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?image-a',
          aes_key: rawBase64,
        },
      },
    },
    {
      type: inbox.WECHAT_ITEM_TYPE.IMAGE,
      msg_id: 'image-b',
      image_item: {
        media: {
          full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?image-b',
          aes_key: rawBase64,
        },
      },
    },
    {
      type: inbox.WECHAT_ITEM_TYPE.FILE,
      msg_id: 'file-a',
      file_item: {
        file_name: '课堂讲义.pdf',
        len: String(fileBytes.byteLength),
        media: {
          full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?file-a',
          aes_key: asciiHexBase64,
        },
      },
    },
  ],
})
assert.equal(binaryWrites.length, 3)
assert.equal(new Set(binaryWrites.map((item) => item.path)).size, 3, '同一消息的多张图片不得路径碰撞')
assert.equal(binaryWrites.filter((item) => item.path.endsWith('.png')).length, 2)
assert.equal(binaryWrites.filter((item) => item.path.endsWith('课堂讲义.pdf')).length, 1)
assert.deepEqual(binaryWrites.find((item) => item.path.endsWith('课堂讲义.pdf')).bytes, fileBytes)
assert.equal(mediaNotes.length, 1)
assert.equal((mediaNotes[0].content.match(/\*\*图片\*\*/g) ?? []).length, 2)
assert.match(mediaNotes[0].content, /\*\*文件\*\*/)
assert.equal(
  [...binaryWrites, ...mediaNotes].every((item) => item.path.startsWith('000_Inbox/微信收件箱/')),
  true,
  '一条消息处理中修改设置，笔记和附件仍必须锁在同一个起始目录',
)

console.log('微信收件箱第3e组：停止接收会中止在途附件且不写 Vault')
let signalDownloadStarted
const signalDownloadReady = new Promise((resolve) => {
  signalDownloadStarted = resolve
})
const stoppedWrites = []
let stoppedState = inbox.defaultWechatInboxState()
const stoppedManager = new runtime.WechatInboxManager({
  app: {
    vault: {
      getAbstractFileByPath: () => null,
      createFolder: async (path) => stoppedWrites.push(['folder', path]),
      createBinary: async (path) => stoppedWrites.push(['binary', path]),
      create: async (path) => stoppedWrites.push(['note', path]),
    },
  },
  pluginVersion: '0.7.101',
  inboxFolder: () => '000_Inbox/微信收件箱',
  connection: () => connection,
  state: () => stoppedState,
  persistState: async (value) => {
    stoppedState = value
  },
  reportStatus: () => undefined,
  fetchImpl: async (_url, init) => await new Promise((resolve, reject) => {
    signalDownloadStarted()
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Request aborted', 'AbortError'))
    }, { once: true })
  }),
})
const stoppedController = new AbortController()
const stoppedRun = stoppedManager.processMessage(connection, {
  ...owned,
  message_id: 31,
  seq: 41,
  create_time_ms: timestamp,
  context_token: 'context-stop',
  item_list: [{
    type: inbox.WECHAT_ITEM_TYPE.IMAGE,
    msg_id: 'image-stop',
    image_item: {
      media: {
        full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?image-stop',
        aes_key: rawBase64,
      },
    },
  }],
}, stoppedController.signal)
await signalDownloadReady
stoppedController.abort()
await assert.rejects(stoppedRun, (error) => error?.name === 'AbortError')
assert.deepEqual(stoppedWrites, [], '停止后不得继续新建目录、附件或笔记')
assert.deepEqual(stoppedState, inbox.defaultWechatInboxState(), '停止后不得推进消息状态')

console.log('微信收件箱第4组：公开实现边界与生命周期契约')
const runtimeSource = await readFile(new URL('../src/wechat-inbox.ts', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(runtimeSource, /get_bot_qrcode\?bot_type=/, '必须走微信官方二维码入口')
assert.match(runtimeSource, /\/ilink\/bot\/getupdates/, '必须实现微信长轮询')
assert.match(runtimeSource, /requestUrl\(/, '微信官方跨域请求必须走 Obsidian 网络接口')
assert.match(runtimeSource, /\/ilink\/bot\/sendmessage/, '必须向微信返回保存结果')
assert.match(runtimeSource, /item\.voice_item\?\.text/, '语音 MVP 必须只取微信现成转写文字')
assert.match(runtimeSource, /当前版本暂不保存视频/, '视频必须明确延期')
assert.match(runtimeSource, /暂未保存媒体文件/, 'MP3 等媒体文件必须明确延期')
assert.match(runtimeSource, /aes-128-ecb/, '图片和文件必须按官方协议解密')
assert.match(runtimeSource, /import \{ createDecipheriv \} from 'crypto'/, 'AES 解密必须走 Obsidian CommonJS 可加载的静态 Node 内置模块')
assert.doesNotMatch(runtimeSource, /import\(['"]crypto['"]\)/, '生产运行时不得留下 Electron 无法解析的动态 crypto 引用')
assert.match(runtimeSource, /WECHAT_INBOX_MAX_MEDIA_BYTES/, '媒体写入必须有体积上限')
assert.match(runtimeSource, /isAllowedWechatCdnUrl/, '媒体 URL 必须有微信 CDN 白名单')
assert.match(runtimeSource, /isOwnedDirectMessage/, '只能接收已连接用户的私聊消息')
assert.match(mainSource, /DEFAULT_WECHAT_INBOX_SECRET_ID/, '连接凭证必须有独立 SecretStorage 条目')
assert.match(mainSource, /serializeWechatInboxConnection\(connection\)/, '连接凭证必须写入 SecretStorage')
assert.doesNotMatch(
  mainSource.slice(mainSource.indexOf('async saveSettings()'), mainSource.indexOf('commitWeeklyBusinessDashboardCache')),
  /wechatInboxConnection|bot_token|botToken/,
  'data.json 快照不得包含微信连接 token',
)
assert.match(mainSource, /this\.wechatInbox\?\.stop\(false\)/, '插件卸载时必须停止长轮询')
assert.doesNotMatch(mainSource, /setName\('后台接收'\)/, '连接后自动收件，不应再暴露冗余手动开关')
assert.doesNotMatch(runtimeSource, /options\.enabled/, '运行时不应再依赖手动收件开关')
assert.match(mainSource, /openWechatInboxConnection\(\(\) => this\.redisplaySettings\(\)\)/, '扫码成功后必须自动刷新设置页')
assert.match(mainSource, /电脑关机或 Obsidian 退出时不能实时接收/, '设置页必须讲清离线边界')
assert.match(mainSource, /不调用 AI，也不消耗 AI霖子积分/, '设置页必须讲清无 AI 计费')

console.log('wechat inbox tests: ok')

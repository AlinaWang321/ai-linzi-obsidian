import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/conversation-title-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const core = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const boundedBundle = await build({
  entryPoints: ['src/bounded-wait.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { boundedWait } = await import(
  `data:text/javascript;base64,${Buffer.from(boundedBundle.outputFiles[0].text).toString('base64')}`
)
globalThis.window ??= globalThis

const user = (text) => ({ role: 'user', parts: [{ text }] })
const messages = [user('自动生成的第一条问题'), { role: 'assistant', parts: [{ text: '回答' }] }]

console.log('[test-conversation-title]')

assert.equal(core.normalizeConversationTitleOverride('  我的\n  周复盘  '), '我的 周复盘')
assert.equal(core.normalizeConversationTitleOverride('   '), null)
assert.equal(Array.from(core.normalizeConversationTitleOverride('🎯'.repeat(80))).length, 60)
console.log('  ✓ 标题规范化按码点限长并压平换行')

const custom = core.conversationTitleStateAt('客户复盘', 100, false)
const cleared = core.conversationTitleStateAt(null, 101, false)
assert.equal(core.effectiveConversationTitle(messages, custom), '客户复盘')
assert.equal(core.effectiveConversationTitle(messages, cleared), '自动生成的第一条问题')
assert.equal(core.explicitConversationTitleState({ titleOverride: '坏时间', titleUpdatedAt: 0 }), undefined)
console.log('  ✓ 手工标题优先；明确清空回退首条问题；畸形状态失败关闭')

const localNewer = core.conversationTitleStateAt('本机新标题', 300, true)
const remoteOlder = core.conversationTitleStateAt('云端旧标题', 200, false)
assert.deepEqual(core.mergeConversationTitleStates(localNewer, remoteOlder), localNewer)
const remoteNewer = core.conversationTitleStateAt('云端新标题', 400, false)
assert.deepEqual(core.mergeConversationTitleStates(localNewer, remoteNewer), remoteNewer)
const remoteClear = core.conversationTitleStateAt(null, 500, false)
assert.equal(core.mergeConversationTitleStates(remoteNewer, remoteClear).titleOverride, null)
const tiedRemote = core.conversationTitleStateAt('同刻云端', 300, false)
assert.deepEqual(core.mergeConversationTitleStates(localNewer, tiedRemote), tiedRemote)
console.log('  ✓ 本机/云端按更新时间合并，清空 tombstone 与同刻远端收敛生效')

assert.equal(core.conversationTitleStatesEqual(custom, { ...custom }), true)
assert.equal(core.conversationTitleStatesEqual(custom, cleared), false)

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(main, /titleOverride\?: string \| null/)
assert.match(main, /titleSyncPending\?: boolean/)
assert.match(
  main,
  /private resetConversationIdentity\(sessionId = newPluginSessionId\(\)\): void/,
  '普通新对话仍默认生成新 session，并行叶子可注入已隔离的 session',
)
assert.ok((main.match(/this\.resetConversationIdentity\(\)/g) ?? []).length >= 5)
assert.match(main, /await this\.syncCurrentConversationTitleIfNeeded\(\)/)
assert.match(main, /mergeConversationTitleStates\(/)
assert.match(main, /requestConversationTitle\(this\.app, baseTitle\)/)
assert.match(main, /this\.api\('\/api\/plugin\/v1\/chat\/sessions',[\s\S]*?method: 'PATCH'/)
const renameStart = main.indexOf('async renameCloudConvo(')
const renameEnd = main.indexOf('\n  async loadCloudConvo(', renameStart)
const renameSource = main.slice(renameStart, renameEnd)
assert.match(renameSource, /body:\s*\{\s*sessionId: normalized, title: titleOverride \?\? ''\s*\}/)
assert.doesNotMatch(renameSource, /body:\s*JSON\.stringify/)
assert.match(main, /boundedWait\(\s*this\.plugin\.loadCloudSessions\(\),\s*4000,/)
assert.match(main, /historyBtn\.setAttribute\('aria-busy', 'true'\)/)
assert.match(
  main,
  /latestLocal\.messages\.length === 0/,
  'metadata-only 标题记录启动时必须继续从云端取正文',
)
assert.match(
  main,
  /if \(item\.convo\?\.messages\.length\)/,
  'metadata-only 标题记录不能被当成完整会话直接打开',
)
assert.match(
  main,
  /messages: \[\],[\s\S]*?titleSyncPending: true/,
  '云端摘要改名断网时也必须先保存 metadata-only 本机标题',
)
console.log('  ✓ 保存、加载、重置、云端合并、pending 重试与改名 UI 已接入同一状态链')

assert.equal(await boundedWait(Promise.resolve('本机可继续'), 50, '不应超时'), '本机可继续')
await assert.rejects(
  boundedWait(new Promise(() => {}), 5, '云端历史加载超时'),
  /云端历史加载超时/,
)
console.log('  ✓ 历史加载有明确忙碌态，云端超时回退本机，PATCH 请求体只序列化一次')

console.log('[test-conversation-title] 全部通过')

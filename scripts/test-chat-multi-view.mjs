import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/chat-view-state-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const state = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')

console.log('[test-chat-multi-view]')

assert.deepEqual(state.parseChatViewState(null), {})
assert.deepEqual(state.parseChatViewState({ sessionId: ' obsidian:one ', startFresh: true }), {
  sessionId: 'obsidian:one',
  startFresh: true,
})
assert.deepEqual(state.freshChatViewState('obsidian:two'), {
  sessionId: 'obsidian:two',
  startFresh: true,
})
assert.deepEqual(
  state.persistedChatViewState('obsidian:two'),
  { sessionId: 'obsidian:two' },
  '一次性 startFresh 不能写回布局，否则重启后会丢历史',
)

assert.match(main, /id: 'open-parallel-chat'/, '必须提供可发现的并行对话命令')
assert.match(
  main,
  /state: freshChatViewState\(newPluginSessionId\(\)\)/,
  '每个并行叶子必须在创建时获得独立 session',
)
assert.match(main, /private activeTurnAbort: AbortController \| null = null/, '停止信号必须是 ChatView 实例级')
assert.match(main, /private sending = false/, '运行状态必须是 ChatView 实例级')
assert.match(main, /private conversationMutationQueue: Promise<void>/, '并行窗口保存必须串行化')
assert.match(main, /private settingsSaveQueue: Promise<void>/, 'data.json 整体快照必须串行化')
assert.match(
  main,
  /chatViewForSession\(item\.id, this\)[\s\S]{0,220}revealLeaf\(alreadyOpen\.leaf\)/,
  '同一会话在其他叶子已打开时必须切换过去，不能双写',
)
assert.match(main, /getState\(\): Record<string, unknown>[\s\S]{0,180}persistedChatViewState/)
assert.match(main, /async setState\(state: unknown, result: ViewStateResult\)/)

console.log('[test-chat-multi-view] 全部通过')

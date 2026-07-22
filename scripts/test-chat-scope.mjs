import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(source, /const PLUGIN_SESSION_PREFIX = 'obsidian:'/, '插件会话必须有独立命名空间')
assert.match(source, /private sessionId = newPluginSessionId\(\)/, '新会话必须使用插件命名空间')
assert.match(source, /this\.sessionId = normalizePluginSessionId\(c\.id\)/, '恢复本机会话时必须迁入命名空间')
assert.match(source, /清空全部插件对话/, '清空入口必须明确限定为插件对话')
assert.match(source, /网页版和微信端对话不会被删除/, '删除确认必须明确跨端安全边界')
assert.match(
  source,
  /async deleteConvo\(sessionId: string\)[\s\S]*?filter\(\(convo\) => convo\.id !== targetId\)/,
  '本地必须支持只删除指定插件会话',
)
assert.match(
  source,
  /async deleteCloudConvo\(sessionId: string\)[\s\S]*?chat\/history\?sessionId=/,
  '云端单删必须显式传入 sessionId',
)
assert.match(source, /text: '删除',[\s\S]*?onDeleteEntry\(entry\)/, '历史列表的每条会话必须提供单独删除入口')
assert.match(
  source,
  /kind: 'cloud' as const,[\s\S]*?convo: local,[\s\S]*?if \(item\.convo\)/,
  '云端会话有本地副本时必须优先恢复本地图片候选卡片',
)
assert.match(
  source,
  /只会删除这一条 AI霖子 Obsidian 插件对话；其他插件对话、网页版和微信端对话都不受影响/,
  '单删确认必须明确不会影响其他端或其他插件会话',
)

const unsafeAssignments = [...source.matchAll(/this\.sessionId = uid\(\)/g)]
assert.equal(unsafeAssignments.length, 0, '禁止生成无命名空间的插件 sessionId')

console.log('chat scope tests: ok')

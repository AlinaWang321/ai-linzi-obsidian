import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(source, /const PLUGIN_SESSION_PREFIX = 'obsidian:'/, '插件会话必须有独立命名空间')
assert.match(source, /private sessionId = newPluginSessionId\(\)/, '新会话必须使用插件命名空间')
assert.match(source, /this\.sessionId = normalizePluginSessionId\(c\.id\)/, '恢复本机会话时必须迁入命名空间')
assert.match(source, /清空插件对话历史/, '清空入口必须明确限定为插件对话')
assert.match(source, /网页版和微信端对话不会被删除/, '删除确认必须明确跨端安全边界')

const unsafeAssignments = [...source.matchAll(/this\.sessionId = uid\(\)/g)]
assert.equal(unsafeAssignments.length, 0, '禁止生成无命名空间的插件 sessionId')

console.log('chat scope tests: ok')

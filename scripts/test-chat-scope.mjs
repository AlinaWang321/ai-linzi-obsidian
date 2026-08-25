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
  /async deleteConvo\(sessionId: string\)[\s\S]*?enqueueConversationMutation[\s\S]*?filter\(\(convo\) => normalizePluginSessionId\(convo\.id\) !== targetId\)/,
  '本地必须在并行串行队列中只删除指定插件会话',
)
assert.match(
  source,
  /async deleteCloudConvo\(sessionId: string\)[\s\S]*?chat\/history\?sessionId=/,
  '云端单删必须显式传入 sessionId',
)
assert.match(source, /text: '删除',[\s\S]*?onDeleteEntry\(entry\)/, '历史列表的每条会话必须提供单独删除入口')
assert.match(
  source,
  /kind: 'cloud' as const,[\s\S]*?convo: local,[\s\S]*?if \(item\.convo\?\.messages\.length\)/,
  '云端会话有完整本地正文副本时必须优先恢复本地图片候选卡片，metadata-only 占位不得误打开',
)
assert.match(
  source,
  /只会删除这一条 AI霖子 Obsidian 插件对话；其他插件对话、网页版和微信端对话都不受影响/,
  '单删确认必须明确不会影响其他端或其他插件会话',
)
assert.match(source, /workspace\.on\('file-open'/, '必须持续记住用户最近打开的笔记')
assert.match(
  source,
  /getLeavesOfType\('markdown'\)/,
  '插件重载后必须能从仍打开的 Markdown 标签页恢复当前笔记',
)
assert.match(
  source,
  /this\.plugin\.rememberCurrentMarkdownFile\(\)/,
  '发送带当前笔记的请求时必须使用稳定的 Markdown 笔记引用',
)
assert.match(
  source,
  /getMostRecentLeaf\(this\.app\.workspace\.rootSplit\)/,
  '右侧栏获得焦点时必须从主编辑区恢复最近使用的 Markdown 标签页',
)
assert.match(source, /active\?\.extension\.toLowerCase\(\) === 'md'/, '当前笔记锁定必须排除图片/PDF 等非 Markdown 文件')
assert.match(source, /已把当前笔记作为本轮主要材料：\$\{noteContext\.filename\}/, '自动读取时必须明确提示实际附带的主要笔记')
assert.match(
  source,
  /if \(currentNoteRequested && !noteContext\)/,
  '明确要求当前笔记但读取失败时必须阻止请求，不能让模型猜测',
)
assert.match(source, /sourceId: `current-note:\$\{noteContext\.path\}`/, '当前笔记来源必须只保留路径标记供连续对话锁定')
assert.match(
  source,
  /文件移动、删除或不再是 Markdown 时必须停止，绝不换成另一份材料/,
  '连续对话的锁定笔记失效时不得静默改读当前其他笔记',
)
assert.doesNotMatch(source, /private attachNote:/, '主对话不应继续保留长期当前笔记开关')

const unsafeAssignments = [...source.matchAll(/this\.sessionId = uid\(\)/g)]
assert.equal(unsafeAssignments.length, 0, '禁止生成无命名空间的插件 sessionId')

console.log('chat scope tests: ok')

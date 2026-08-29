import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-current-note-'))
const outfile = path.join(tempDir, 'current-note-intent.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/current-note-intent.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const core = await import(pathToFileURL(outfile).href)

for (const text of [
  '帮我总结当前笔记',
  '请把当前这篇测试笔记删除，只能移入回收站',
  '删除这篇笔记',
  '把这份文档移入废纸篓',
  '润色这篇文章',
  '分析这份咨询逐字稿',
  '根据当前笔记给我一些商业建议',
  '给正在打开的文档配图',
  '把当前会议记录整理成行动看板',
  '用 note-to-seven-day-action-course Skill 把当前笔记变成 7 天行动计划',
  '将这篇文档转换为一周行动清单',
  '整理当前会议的待办',
  '用当前周报做一次经营复盘',
]) {
  assert.equal(core.shouldUseCurrentNote(text), true, text)
}

for (const text of [
  '怎么写一篇公众号文章？',
  '今天适合做什么？',
  '帮我找一下 Vault 里的咨询逐字稿',
  '当前总统是谁？',
]) {
  assert.equal(core.shouldUseCurrentNote(text), false, text)
}

for (const text of [
  '不要读取当前笔记',
  '不要使用当前文章，只确认 Skill 能不能调用',
  '别把这篇文章作为本轮主要材料',
  '当前打开的文件不要发送给模型',
  '再帮我确认一次，但不要读取当前笔记',
  '不要读取当前笔记或任何业务文件，只读取 Skill/create-project',
  '禁止读取任何文件，只审核 Article to Video 的路由',
]) {
  assert.equal(core.shouldUseCurrentNote(text, true), false, text)
  assert.equal(core.resolveCurrentNoteReference(text, true), 'none', text)
}

assert.equal(core.isCurrentNoteSourceExplicitlyDenied('不要读取当前笔记'), true)
assert.equal(core.isAllUserContentSourceExplicitlyDenied('不要读取任何业务文件'), true)
assert.equal(
  core.shouldUseCurrentNote('不要读取其他文件，只读取当前文章'),
  true,
  '排除其他文件不能误伤明确授权的当前文章',
)
assert.equal(
  core.shouldUseCurrentNote('不要只读取当前笔记，还要结合其他资料分析'),
  true,
  '“不要只读取”是在扩大范围，不是拒绝当前笔记',
)

assert.equal(core.shouldUseCurrentNote('再短一点', true), true)
assert.equal(core.shouldUseCurrentNote('再短一点', false), false)
assert.equal(core.shouldUseCurrentNote('谢谢', true), false)

assert.equal(core.resolveCurrentNoteReference('处理这篇笔记', true), 'locked')
assert.equal(core.resolveCurrentNoteReference('处理这篇笔记', false), 'active')
assert.equal(core.resolveCurrentNoteReference('处理当前笔记', true), 'active')
assert.equal(core.resolveCurrentNoteReference('就是完整版的呀，你为什么读不了', true), 'locked')
assert.equal(core.resolveCurrentNoteReference('你读错笔记了，重新读这篇', true), 'locked')
assert.equal(core.resolveCurrentNoteReference('谢谢', true), 'none')

const searchedAndRead = [
  { sourceId: 'search-1', path: '草稿箱/候选 A.md', kind: 'search' },
  { sourceId: 'search-1', path: '草稿箱/候选 B.md', kind: 'search' },
  { sourceId: 'read-1', path: '草稿箱/8月28日文章.md', kind: 'read' },
]
assert.equal(
  core.selectLockedConversationSource(searchedAndRead),
  '草稿箱/8月28日文章.md',
  '多个搜索候选中唯一真正 read_note 的正文必须成为后续“这篇文章”',
)
assert.equal(
  core.selectLockedConversationSource([
    ...searchedAndRead,
    { sourceId: 'read-2', path: '草稿箱/另一篇.md', kind: 'read' },
  ]),
  undefined,
  '同一轮实际读取多篇时不能擅自猜下一轮指哪篇',
)
assert.equal(
  core.selectLockedConversationSource([
    { sourceId: 'search-1', path: '草稿箱/候选 A.md', kind: 'search' },
  ]),
  undefined,
  '只有搜索命中不能锁成后续正文',
)
assert.equal(
  core.selectLockedConversationSource([
    { sourceId: 'current-note:草稿箱/当前.md', path: '草稿箱/当前.md' },
    ...searchedAndRead,
  ]),
  '草稿箱/当前.md',
  '显式当前笔记优先于工具读取候选，并兼容旧会话 sourceId',
)

assert.equal(core.shouldSearchVaultBeyondCurrentNote('处理这篇笔记，只回答唯一代号'), false)
assert.equal(core.shouldSearchVaultBeyondCurrentNote('在这篇笔记里查找唯一代号'), false)
assert.equal(core.shouldSearchVaultBeyondCurrentNote('结合整个知识库的相关资料处理这篇笔记'), true)
assert.equal(core.shouldSearchVaultBeyondCurrentNote('去 Vault 里搜索相关资料，再处理当前笔记'), true)
assert.equal(core.shouldSearchVaultBeyondCurrentNote('参考其他笔记补充这篇内容'), true)

assert.equal(
  core.selectCurrentOpenMarkdownPath({
    activePath: '02_Wiki/正在看的笔记.md',
    recentRootPath: '02_Wiki/另一篇.md',
    lastActivePath: '02_Wiki/旧笔记.md',
    openPaths: ['02_Wiki/正在看的笔记.md', '02_Wiki/另一篇.md'],
  }),
  '02_Wiki/正在看的笔记.md',
  '主编辑区当前激活的笔记优先',
)
assert.equal(
  core.selectCurrentOpenMarkdownPath({
    recentRootPath: '02_Wiki/正在看的笔记.md',
    lastActivePath: '02_Wiki/旧笔记.md',
    openPaths: ['02_Wiki/正在看的笔记.md'],
  }),
  '02_Wiki/正在看的笔记.md',
  '侧边对话获得焦点时仍可使用主编辑区内仍打开的最近笔记',
)
assert.equal(
  core.selectCurrentOpenMarkdownPath({
    lastActivePath: '02_Wiki/已关闭.md',
    openPaths: ['02_Wiki/仍打开.md'],
  }),
  '02_Wiki/仍打开.md',
  '已关闭的 lastActiveFile 不能继续授权',
)
assert.equal(
  core.selectCurrentOpenMarkdownPath({
    lastActivePath: '02_Wiki/已关闭.md',
    openPaths: ['02_Wiki/A.md', '02_Wiki/B.md'],
  }),
  undefined,
  '无法确认最近激活项时不能从多个打开标签页中随便选一篇',
)
assert.equal(
  core.selectCurrentOpenMarkdownPath({
    lastActivePath: '02_Wiki/已关闭.md',
    openPaths: [],
  }),
  undefined,
  '关闭所有 Markdown 标签页后当前笔记必须为空',
)

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.doesNotMatch(main, /主对话带上当前笔记/)
assert.doesNotMatch(main, /默认带上当前笔记/)
assert.doesNotMatch(main, /attachToggleEl/)
assert.match(main, /resolveCurrentNoteReference/)
assert.match(main, /selectLockedConversationSource/)
assert.doesNotMatch(main, /renderVaultSources\(/)
assert.doesNotMatch(main, /本轮在 Vault 中找到：/)
assert.match(main, /const currentNoteSourceDenied =/)
assert.match(main, /!currentNoteSourceDenied &&/)
assert.match(main, /!allUserContentSourceDenied &&/)
assert.match(main, /localSkillQuestionNamesConcreteInputFile\(text\)/)
assert.match(main, /const currentNoteOnlyTurn = Boolean/)
assert.match(main, /!currentNoteOnlyTurn/)
assert.match(main, /shouldSearchVaultBeyondCurrentNote\(text\)/)
assert.match(main, /已把当前笔记作为本轮主要材料：/)
assert.match(main, /getAbstractFileByPath\(lockedPath\)/)
assert.match(main, /lockedFile\.extension\.toLowerCase\(\) === 'md'/)
assert.doesNotMatch(main, /openMarkdownFile\(lockedPath\)/)
assert.doesNotMatch(main, /getLastOpenFiles\(\)/, '最近打开记录不能作为当前笔记授权')

console.log('automatic current note intent tests passed')

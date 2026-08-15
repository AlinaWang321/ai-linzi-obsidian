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

assert.equal(core.shouldUseCurrentNote('再短一点', true), true)
assert.equal(core.shouldUseCurrentNote('再短一点', false), false)
assert.equal(core.shouldUseCurrentNote('谢谢', true), false)

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
assert.match(main, /shouldUseCurrentNote/)
assert.match(main, /本轮只读取当前笔记：/)
assert.match(main, /openMarkdownFile\(lockedPath\)/)
assert.doesNotMatch(main, /getLastOpenFiles\(\)/, '最近打开记录不能作为当前笔记授权')

console.log('automatic current note intent tests passed')

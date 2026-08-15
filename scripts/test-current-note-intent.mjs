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

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.doesNotMatch(main, /主对话带上当前笔记/)
assert.doesNotMatch(main, /默认带上当前笔记/)
assert.doesNotMatch(main, /attachToggleEl/)
assert.match(main, /shouldUseCurrentNote/)
assert.match(main, /本轮只读取当前笔记：/)

console.log('automatic current note intent tests passed')

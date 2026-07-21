import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

async function loadTs(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
  return module.exports
}

const notePatch = await loadTs('src/note-patch.ts')

assert.equal(notePatch.isNoteEditIntent('把文章里面的“AI霖子”都加上框框，写成「AI霖子」'), true)
assert.equal(notePatch.isNoteEditIntent('请润色这篇文章的开头两段'), true)
assert.equal(notePatch.isNoteEditIntent('我想调整一下自己的商业模式'), false)

const rawReply = `已找到 1 处需要修改，只会改这一段。

<AI_LINZI_NOTE_PATCH>
\`\`\`json
{"operations":[{"old":"旧句子。","new":"新句子。","all":false,"reason":"表达更清楚"}]}
\`\`\`
</AI_LINZI_NOTE_PATCH>`
const parsed = notePatch.parseNotePatch(rawReply)
assert.ok(parsed)
assert.equal(parsed.displayText, '已找到 1 处需要修改，只会改这一段。')
assert.deepEqual(parsed.operations, [
  { old: '旧句子。', new: '新句子。', all: false, reason: '表达更清楚' },
])

const withFrontmatter = '---\ntitle: 测试\n---\n\n第一段。\n\n旧句子。\n'
const applied = notePatch.applyNotePatch(withFrontmatter, parsed)
assert.equal(applied.content, '---\ntitle: 测试\n---\n\n第一段。\n\n新句子。\n')
assert.equal(applied.replacements, 1)
assert.match(applied.content, /^---\ntitle: 测试\n---/)

const wrapPatch = {
  displayText: '统一加上书名号。',
  operations: [{ old: 'AI霖子', new: '「AI霖子」', all: true }],
}
const wrapped = notePatch.applyNotePatch('AI霖子和「AI霖子」，还有AI霖子。', wrapPatch)
assert.equal(wrapped.content, '「AI霖子」和「AI霖子」，还有「AI霖子」。')
assert.equal(wrapped.replacements, 2)
const wrappedAgain = notePatch.applyNotePatch(wrapped.content, wrapPatch)
assert.equal(wrappedAgain.content, wrapped.content)
assert.equal(wrappedAgain.replacements, 0)
assert.equal(wrappedAgain.alreadyApplied, 1)

const alreadyApplied = notePatch.applyNotePatch('这里已经是新文本。', {
  displayText: '',
  operations: [{ old: '原来文本', new: '新文本', all: false }],
})
assert.equal(alreadyApplied.replacements, 0)
assert.equal(alreadyApplied.alreadyApplied, 1)

const ambiguousSource = '先改这里。重复词，以及另一个重复词。'
assert.throws(
  () =>
    notePatch.applyNotePatch(ambiguousSource, {
      displayText: '',
      operations: [
        { old: '先改这里', new: '已经修改', all: false },
        { old: '重复词', new: '唯一词', all: false },
      ],
    }),
  /出现了 2 次/,
)
assert.equal(ambiguousSource, '先改这里。重复词，以及另一个重复词。')

assert.equal(notePatch.parseNotePatch('没有协议标记的普通回复'), null)
assert.equal(
  notePatch.parseNotePatch('<AI_LINZI_NOTE_PATCH>{bad json}</AI_LINZI_NOTE_PATCH>'),
  null,
)

console.log('note patch regression tests passed')

import assert from 'node:assert/strict'
import esbuild from 'esbuild'

const built = await esbuild.build({
  entryPoints: ['src/weekly-business-index-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
})
const core = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)

const files = [
  { path: '02_Wiki/A.md', mtime: 10, size: 100 },
  { path: '02_Wiki/B.md', mtime: 20, size: 200 },
]
const completeA = {
  version: 1,
  ...files[0],
  totalChars: 100,
  status: 'ready',
  segments: [{ index: 0, offset: 0, nextOffset: null, summary: 'A 摘要' }],
  updatedAt: 30,
}
const partialB = {
  version: 1,
  ...files[1],
  totalChars: 200,
  status: 'ready',
  segments: [{ index: 0, offset: 0, nextOffset: 80, summary: 'B 第一段' }],
  updatedAt: 30,
}
const removed = {
  ...completeA,
  path: '02_Wiki/已删除.md',
}

const selection = core.selectWeeklyBusinessIndexWork(files, [completeA, partialB, removed])
assert.deepEqual(selection.reusable.map((item) => item.path), ['02_Wiki/A.md'])
assert.deepEqual(selection.pending.map((item) => item.path), ['02_Wiki/B.md'])
assert.deepEqual(selection.removedPaths, ['02_Wiki/已删除.md'])
assert.equal(core.nextWeeklyBusinessOffset(partialB), 80)
assert.equal(core.isWeeklyBusinessRecordComplete(partialB), false)
assert.equal(core.isWeeklyBusinessRecordComplete(completeA), true)

const changed = core.selectWeeklyBusinessIndexWork(
  [{ ...files[0], mtime: 11 }],
  [completeA],
)
assert.equal(changed.reusable.length, 0)
assert.equal(changed.pending.length, 1, 'mtime 变化后必须重新摘要')

const id1 = core.weeklyBusinessTaskId(files)
const id2 = core.weeklyBusinessTaskId([...files].reverse())
assert.equal(id1, id2, '同一快照换枚举顺序仍必须得到相同幂等 taskId')
assert.notEqual(id1, core.weeklyBusinessTaskId([{ ...files[0], size: 101 }, files[1]]))

const groups = core.groupWeeklyBusinessSummaries([
  { path: 'A', summary: 'a'.repeat(40) },
  { path: 'B', summary: 'b'.repeat(40) },
], 100)
assert.equal(groups.length, 2, '递归合并前必须按字符预算拆组')

assert.deepEqual(core.weeklyBusinessSummaryItems([completeA]), [{
  sourceId: '02_Wiki/A.md#0',
  path: '02_Wiki/A.md',
  summary: 'A 摘要',
}])

console.log('经营周报本机摘要索引与断点增量测试通过')

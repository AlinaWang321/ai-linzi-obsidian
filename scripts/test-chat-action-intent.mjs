import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/chat-action-intent.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const intent = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

assert.equal(intent.explicitMemoryContent('请记住：我现在的主推产品是年度顾问服务'), '我现在的主推产品是年度顾问服务')
assert.equal(intent.explicitMemoryContent('把我每周三做直播记住'), '我每周三做直播')
assert.equal(intent.explicitMemoryContent('我主要服务海外华人，请帮我记下来'), '我主要服务海外华人')
assert.equal(intent.explicitMemoryContent('你觉得我应该记住什么？'), undefined)

assert.equal(intent.isCurrentNoteKnowledgeSaveIntent('把当前笔记存入 AI霖子知识库'), true)
assert.equal(intent.isCurrentNoteKnowledgeSaveIntent('把这篇文章加入知识库'), true)
assert.equal(intent.isCurrentNoteKnowledgeSaveIntent('知识库应该怎么搭？'), false)
assert.equal(intent.isCurrentNoteKnowledgeSaveIntent('把客户档案存入知识库'), false)

assert.equal(intent.isFullCurrentNoteReplaceIntent('用刚才的回复覆盖当前笔记'), true)
assert.equal(intent.isFullCurrentNoteReplaceIntent('把这一版全文更新到这篇文章'), true)
assert.equal(intent.isFullCurrentNoteReplaceIntent('帮我优化当前笔记'), false)

console.log('chat natural action intent tests passed')

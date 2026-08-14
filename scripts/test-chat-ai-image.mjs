import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/chat-ai-image.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const image = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const batch = image.extractChatAiImageRequests(`我会生成两张卡片。
<<<AI_LINZI_IMAGE_REQUEST>>>
{"requests":[{"label":"封面","instruction":"生成3:4卡片，准确写「一人公司」","ratio":"3:4","editPreviousImage":false},{"label":"结尾","instruction":"生成3:4结尾卡，准确写「把自己当公司经营」","ratio":"3:4","editPreviousImage":false}]}
<<<AI_LINZI_IMAGE_REQUEST_END>>>`)
assert.equal(batch.cleanText, '我会生成两张卡片。')
assert.equal(batch.invalid, false)
assert.equal(batch.requests.length, 2)
assert.equal(batch.requests[0].ratio, '3:4')
assert.equal(batch.requests[1].label, '结尾')

const edit = image.extractChatAiImageRequests(`准备修改。
<<<AI_LINZI_IMAGE_REQUEST>>>
{"requests":[{"instruction":"把标题改成「AI一人公司」，其他内容保持不变","ratio":"3:4","editPreviousImage":true}]}
<<<AI_LINZI_IMAGE_REQUEST_END>>>`)
assert.equal(edit.requests[0].editPreviousImage, true)
assert.equal(edit.requests[0].label, '图片 1')

const broken = image.extractChatAiImageRequests(
  '正在准备\n<<<AI_LINZI_IMAGE_REQUEST>>>\n{"requests":[',
)
assert.equal(broken.invalid, true)
assert.equal(broken.requests.length, 0)
assert.equal(broken.cleanText, '正在准备')

assert.equal(image.isDirectAiImageRequest('给我生成6张小红书卡片图'), true)
assert.equal(image.isDirectAiImageRequest('做一张课程招募海报'), true)
assert.equal(image.isDirectAiImageRequest('给当前文章生成配图'), false)
assert.equal(image.isDirectAiImageRequest('讨论一下海报应该怎么设计'), false)
assert.equal(image.isDirectAiImageEditRequest('把第2张的标题改成一人公司'), true)
assert.equal(image.requestedAiImageIndex('修改第六张卡片'), 6)
assert.equal(image.requestedAiImageIndex('修改上一张'), null)

console.log('chat AI image request tests passed')

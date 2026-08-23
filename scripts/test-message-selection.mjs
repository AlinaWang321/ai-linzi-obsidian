import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/message-selection-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { installMessageTextSelection } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const inside = { id: 'inside' }
const outside = { id: 'outside' }
const listeners = new Map()
const body = {
  addEventListener(type, handler) { listeners.set(type, handler) },
  contains(node) { return node === inside },
}
let selection = null
const copyMenus = []
installMessageTextSelection(body, {
  getSelection: () => selection,
  showCopyMenu: (event, selectedText) => copyMenus.push({ event, selectedText }),
})

console.log('[test-message-selection]')

for (const type of ['pointerdown', 'mousedown', 'selectstart']) {
  let stopped = false
  let prevented = false
  listeners.get(type)({
    stopPropagation() { stopped = true },
    preventDefault() { prevented = true },
  })
  assert.equal(stopped, true, `${type} 必须阻止 Obsidian 面板拖拽监听`)
  assert.equal(prevented, false, `${type} 绝不能 preventDefault，否则鼠标无法拖选`)
}

const makeContextEvent = () => ({
  prevented: false,
  stopped: false,
  preventDefault() { this.prevented = true },
  stopPropagation() { this.stopped = true },
})

selection = { toString: () => '', anchorNode: inside, focusNode: inside }
listeners.get('contextmenu')(makeContextEvent())
assert.equal(copyMenus.length, 0, '没有选中文字时不应劫持右键')

selection = { toString: () => '可复制的回复', anchorNode: outside, focusNode: outside }
listeners.get('contextmenu')(makeContextEvent())
assert.equal(copyMenus.length, 0, '选区不在当前消息内时不应劫持右键')

selection = { toString: () => '可复制的回复', anchorNode: inside, focusNode: inside }
const contextEvent = makeContextEvent()
listeners.get('contextmenu')(contextEvent)
assert.equal(contextEvent.prevented, true)
assert.equal(contextEvent.stopped, true)
assert.deepEqual(copyMenus.map((item) => item.selectedText), ['可复制的回复'])

console.log('[test-message-selection] 全部通过')

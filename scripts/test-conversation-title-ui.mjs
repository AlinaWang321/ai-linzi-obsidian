import assert from 'node:assert/strict'
import { build } from 'esbuild'

function makeEl(tag = 'div', options = {}) {
  const el = {
    tag,
    cls: options.cls ?? '',
    text: options.text ?? '',
    attr: options.attr ?? {},
    value: '',
    children: [],
    listeners: {},
    addClass(value) { this.cls = `${this.cls} ${value}`.trim() },
    empty() { this.children = [] },
    addEventListener(type, handler) { this.listeners[type] = handler },
    focus() { this.focused = true },
    select() { this.selected = true },
  }
  const child = (nextTag, nextOptions = {}) => {
    const next = makeEl(nextTag, nextOptions)
    el.children.push(next)
    return next
  }
  el.createEl = (nextTag, nextOptions) => child(nextTag, nextOptions)
  el.createDiv = (nextOptions) => child('div', nextOptions)
  return el
}

const obsidianStub = `
  export class App {}
  export class Modal {
    constructor(app) {
      this.app = app
      this.contentEl = globalThis.__titleUi.makeEl('div')
      this.modalEl = globalThis.__titleUi.makeEl('div')
    }
    setTitle(value) { this.title = value }
    open() { this.onOpen?.(); return this }
    close() { this.closed = true; this.onClose?.() }
  }
`
const stubPlugin = {
  name: 'obsidian-title-ui-stub',
  setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }))
  },
}
const bundled = await build({
  entryPoints: ['src/conversation-title-modal.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [stubPlugin],
})
globalThis.__titleUi = { makeEl }
globalThis.window = { setTimeout: (fn) => { fn(); return 1 } }
const { ConversationTitleModal } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

function all(root, out = []) {
  for (const child of root.children) {
    out.push(child)
    all(child, out)
  }
  return out
}

console.log('[test-conversation-title-ui]')

{
  const values = []
  const modal = new ConversationTitleModal({}, '旧标题', (value) => values.push(value))
  modal.onOpen()
  const input = all(modal.contentEl).find((el) => el.tag === 'input')
  const save = all(modal.contentEl).find((el) => el.text === '保存标题')
  assert.equal(modal.title, '修改对话标题')
  assert.equal(input.value, '旧标题')
  assert.equal(input.attr.maxlength, '60')
  assert.equal(input.focused, true)
  input.value = '  新的\n周复盘  '
  save.onclick()
  assert.deepEqual(values, ['新的 周复盘'])
  assert.equal(modal.closed, true)
  console.log('  ✓ 展示现有标题、60 字上限、聚焦并保存规范化标题')
}

{
  const values = []
  const modal = new ConversationTitleModal({}, '旧标题', (value) => values.push(value))
  modal.onOpen()
  const input = all(modal.contentEl).find((el) => el.tag === 'input')
  input.value = '   '
  input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} })
  assert.deepEqual(values, [null])
  console.log('  ✓ 留空回车保存为明确清空 tombstone')
}

{
  const values = []
  const modal = new ConversationTitleModal({}, '旧标题', (value) => values.push(value))
  modal.onOpen()
  const input = all(modal.contentEl).find((el) => el.tag === 'input')
  input.listeners.keydown({ key: 'Escape', isComposing: false, preventDefault() {} })
  modal.onClose()
  assert.deepEqual(values, [undefined], '取消与 onClose 不能重复 resolve')
  console.log('  ✓ Escape 取消且关闭回调只触发一次')
}

console.log('[test-conversation-title-ui] 全部通过')

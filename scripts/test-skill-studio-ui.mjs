import assert from 'node:assert/strict'
import { build } from 'esbuild'

function makeEl(tag = 'div', options = {}) {
  const el = {
    tag,
    cls: options.cls || '',
    text: options.text || '',
    children: [],
    addClass(value) { this.cls = `${this.cls} ${value}`.trim() },
    setText(value) { this.text = value },
    empty() { this.children = [] },
  }
  const child = (nextTag, nextOptions = {}) => {
    const next = makeEl(nextTag, nextOptions)
    el.children.push(next)
    return next
  }
  el.createDiv = (nextOptions) => child('div', nextOptions)
  el.createEl = (nextTag, nextOptions) => child(nextTag, nextOptions)
  el.createSpan = (nextOptions) => child('span', nextOptions)
  return el
}

const obsidianStub = `
  function makeControl() {
    return {
      value: '',
      options: {},
      onChangeFn: undefined,
      setPlaceholder() { return this },
      setValue(value) { this.value = value; return this },
      addOption(value, label) { this.options[value] = label; return this },
      onChange(fn) { this.onChangeFn = fn; return this },
      trigger(value) { this.value = value; return this.onChangeFn?.(value) },
      setButtonText(value) { this.text = value; return this },
      setCta() { return this },
      setDisabled() { return this },
      onClick(fn) { this.onClickFn = fn; return this },
      click() { return this.onClickFn?.() },
    }
  }
  export class App {}
  export class TFile {}
  export class TFolder {}
  export class Notice {}
  export function normalizePath(value) { return value }
  export class Modal {
    constructor(app) {
      this.app = app
      this.contentEl = globalThis.__ui.makeEl('div')
      this.modalEl = globalThis.__ui.makeEl('div')
    }
    setTitle(value) { this.title = value }
    close() { this.closed = true }
  }
  export class Setting {
    constructor(container) {
      this.settingEl = container.createDiv({ cls: 'setting-item' })
      this.controls = []
      globalThis.__ui.settings.push(this)
    }
    setName(value) { this.name = value; return this }
    setDesc(value) { this.desc = value; return this }
    addDropdown(fn) { const c = makeControl(); this.controls.push(c); fn(c); return this }
    addText(fn) { const c = makeControl(); this.controls.push(c); fn(c); return this }
    addTextArea(fn) { const c = makeControl(); this.controls.push(c); fn(c); return this }
    addButton(fn) { const c = makeControl(); this.controls.push(c); fn(c); return this }
  }
`

const stubPlugin = {
  name: 'obsidian-ui-stub',
  setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: obsidianStub,
      loader: 'js',
    }))
  },
}

const bundled = await build({
  entryPoints: ['src/skill-studio.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [stubPlugin],
})
globalThis.__ui = { makeEl, settings: [] }
const { SkillStudioModal } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

function all(root, out = []) {
  for (const child of root.children) {
    out.push(child)
    all(child, out)
  }
  return out
}
const setting = (name) => [...globalThis.__ui.settings].reverse().find((item) => item.name === name)
const preview = (modal) => all(modal.contentEl).find((el) => el.cls.includes('ai-linzi-skill-invocation-preview'))

console.log('[test-skill-studio-ui] 官方模板预览随输入实时变化，安装使用同一句')
{
  const offered = []
  const modal = new SkillStudioModal({}, {
    onCreateWithAi: () => {},
    onOfferBundle: (_block, sampleInput) => offered.push(sampleInput),
  })
  modal.templateId = 'weekly-business-dashboard'
  modal.onOpen()
  assert.match(preview(modal).text, /^✅ 自动命中：生成本周经营周报看板/)
  setting('推荐调用示例').controls[0].trigger('')
  assert.match(
    preview(modal).text,
    /^✅ 自动命中：生成本周经营周报看板/,
    '清空官方示例时，预览与安装都应回退该模板自己的推荐句',
  )
  setting('推荐调用示例').controls[0].trigger('请随便分析今天的材料')
  assert.match(preview(modal).text, /^❌ 完全不命中：请随便分析今天的材料/)
  const installSetting = globalThis.__ui.settings.find((item) =>
    item.controls.some((control) => control.text === '查看详情并安装'))
  installSetting.controls.find((control) => control.text === '查看详情并安装').click()
  assert.deepEqual(offered, ['请随便分析今天的材料'])
}

console.log('[test-skill-studio-ui] 自建 Skill 的名称、触发短语和测试示例共用实时自检')
{
  globalThis.__ui.settings = []
  const modal = new SkillStudioModal({}, {
    onCreateWithAi: () => {},
    onOfferBundle: () => {},
  })
  modal.onOpen()
  setting('英文名称').controls[0].trigger('client-follow-up')
  setting('自动识别的调用说法').controls[0].trigger('生成客户跟进行动清单')
  setting('创建后测试示例').controls[0].trigger('生成客户跟进行动清单')
  assert.match(preview(modal).text, /^✅ 自动命中：生成客户跟进行动清单/)
  setting('创建后测试示例').controls[0].trigger('整理一下今天的材料')
  assert.match(preview(modal).text, /^❌ 完全不命中：整理一下今天的材料/)
  setting('创建后测试示例').controls[0].trigger('用 client-follow-up Skill 处理当前笔记')
  assert.match(preview(modal).text, /^⚠️ 显式命中：用 client-follow-up Skill 处理当前笔记/)
}

console.log('skill studio UI behavior tests: ok')

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/dynamic-dashboard-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const core = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const spec = core.parseDynamicDashboardSpec({
  title: '一人公司工作台',
  subtitle: '自动更新',
  sections: [
    { type: 'overview', roots: [] },
    { type: 'recent_files', roots: ['02_Wiki'], sinceDays: 30, limit: 8 },
    { type: 'file_list', roots: ['04_Output'], extensions: ['.md', 'HTML'], pathIncludes: ['看板'], limit: 12 },
    { type: 'quick_links', paths: ['02_Wiki/经营.md', '../越界.md', '/绝对.md'] },
    { type: 'unknown', title: '不能执行' },
  ],
})
assert.ok(spec)
assert.equal(spec.version, 1)
assert.equal(spec.sections.length, 4)
assert.deepEqual(spec.sections[2].extensions, ['md', 'html'])
assert.deepEqual(spec.sections[3].paths, ['02_Wiki/经营.md'])

const plan = core.dynamicDashboardPlanFromToolArguments({
  path: '$OUTPUT/工作台/一人公司工作台.md',
  spec,
})
assert.ok(plan)
assert.equal(plan.operations.length, 1)
assert.equal(plan.operations[0].type, 'create_note')
assert.match(plan.operations[0].content, /```ai-linzi-dashboard/)
assert.match(plan.operations[0].content, /"version": 1/)
assert.equal(core.dynamicDashboardPlanFromToolArguments({ path: '../坏路径.md', spec }), null)
assert.equal(core.dynamicDashboardPlanFromToolArguments({ path: '工作台.html', spec }), null)

const NOW = 1_700_000_000_000
const results = core.buildDynamicDashboardResults(
  spec,
  [
    { path: '02_Wiki/经营.md', extension: 'md', size: 2048, mtime: NOW - 1_000 },
    { path: '04_Output/经营看板.html', extension: 'html', size: 4096, mtime: NOW - 2_000 },
    { path: '04_Output/普通笔记.md', extension: 'md', size: 1024, mtime: NOW - 3_000 },
  ],
  [{ path: '02_Wiki' }, { path: '04_Output' }],
  NOW,
)
assert.equal(results[0].metrics?.[0].value, '3')
assert.equal(results[1].rows?.[0].path, '02_Wiki/经营.md')
assert.deepEqual(results[2].rows?.map((row) => row.path), ['04_Output/经营看板.html'])

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const renderer = readFileSync(new URL('../src/dynamic-dashboard.ts', import.meta.url), 'utf8')
assert.match(main, /registerMarkdownCodeBlockProcessor/)
assert.match(main, /DYNAMIC_DASHBOARD_CODE_BLOCK/)
assert.match(renderer, /vault\.on\('create'/)
assert.match(renderer, /vault\.on\('modify'/)
assert.match(renderer, /vault\.on\('delete'/)
assert.match(renderer, /vault\.on\('rename'/)
assert.doesNotMatch(renderer, /innerHTML|eval\(|new Function/)

// 真跑一遍渲染与刷新分支：最小 Obsidian DOM 桩，不靠源码 grep 冒充行为测试。
function makeEl(tag = 'div', options = {}) {
  const el = {
    tag,
    cls: options.cls ?? '',
    text: options.text ?? '',
    children: [],
    listeners: {},
  }
  const child = (nextTag, nextOptions = {}) => {
    const result = makeEl(nextTag, nextOptions)
    el.children.push(result)
    return result
  }
  el.createEl = (nextTag, nextOptions) => child(nextTag, nextOptions)
  el.createDiv = (nextOptions) => child('div', nextOptions)
  el.createSpan = (nextOptions) => child('span', nextOptions)
  el.empty = () => { el.children = [] }
  el.addClass = (value) => { el.cls = `${el.cls} ${value}`.trim() }
  el.addEventListener = (name, callback) => { el.listeners[name] = callback }
  return el
}
function descendants(el, output = []) {
  for (const child of el.children) {
    output.push(child)
    descendants(child, output)
  }
  return output
}
const byClass = (root, cls) => descendants(root).filter((el) => el.cls.split(/\s+/).includes(cls))

const rendererBundle = await build({
  entryPoints: ['src/dynamic-dashboard.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'obsidian-stub',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'js',
        contents: `
          export class App {}
          export class MarkdownRenderChild {
            constructor(containerEl) { this.containerEl = containerEl; this.events = [] }
            registerEvent(event) { this.events.push(event); return event }
          }
          export function setIcon(el, name) { el.icon = name }
        `,
      }))
    },
  }],
})
const dashboardRenderer = await import(
  `data:text/javascript;base64,${Buffer.from(rendererBundle.outputFiles[0].text).toString('base64')}`
)
globalThis.window = globalThis
const callbacks = { create: [], modify: [], delete: [], rename: [] }
const LIVE_NOW = Date.now()
let liveFiles = [
  { path: '02_Wiki/经营.md', extension: 'md', stat: { size: 2048, mtime: LIVE_NOW - 1_000 } },
]
const app = {
  vault: {
    getFiles: () => liveFiles,
    getAllFolders: () => [{ path: '02_Wiki' }],
    on: (name, callback) => {
      callbacks[name].push(callback)
      return { name, callback }
    },
  },
}
const opened = []
const root = makeEl()
const component = dashboardRenderer.renderDynamicDashboardBlock(
  app,
  { isProtectedPath: () => false, openPath: async (path) => { opened.push(path) } },
  JSON.stringify({
    title: '实时工作台',
    sections: [
      { type: 'overview', roots: [] },
      { type: 'recent_files', roots: ['02_Wiki'], sinceDays: 30, limit: 10 },
    ],
  }),
  root,
)
assert.ok(component)
component.onload()
assert.equal(byClass(root, 'ai-linzi-dynamic-dashboard-card').length, 2)
assert.ok(descendants(root).some((el) => el.text === '1'))
const firstRow = byClass(root, 'ai-linzi-dynamic-dashboard-row')[0]
firstRow.listeners.click()
assert.deepEqual(opened, ['02_Wiki/经营.md'])

liveFiles = [
  ...liveFiles,
  { path: '02_Wiki/新方法.md', extension: 'md', stat: { size: 1024, mtime: LIVE_NOW } },
]
callbacks.create[0]()
await new Promise((resolve) => setTimeout(resolve, 280))
assert.ok(descendants(root).some((el) => el.text === '2'), 'Vault 新建事件后应自动刷新文件数')
component.onunload()
delete globalThis.window

console.log('[test-dynamic-dashboard] 规格白名单、路径防护、真实 DOM 渲染与实时刷新通过')

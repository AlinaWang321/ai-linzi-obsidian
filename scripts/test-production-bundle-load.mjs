import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const originalLoad = Module._load
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(process.argv[2] ?? path.join(scriptDirectory, '..', 'main.js'))
const bundleSource = readFileSync(bundlePath, 'utf8')

assert.doesNotMatch(
  bundleSource,
  /require\(["']node:/,
  '生产包不得使用 Obsidian 插件加载器可能无法识别的 node: 协议模块',
)
assert.doesNotMatch(
  bundleSource,
  /import\(["']crypto["']\)/,
  '生产包不得保留 Electron 渲染器无法解析的动态 crypto 引用',
)

class EmptyComponent {
  constructor(app) {
    this.app = app
  }
}

const registeredMarkdownProcessors = []

class PluginMock extends EmptyComponent {
  constructor(app, manifest) {
    super(app)
    this.manifest = manifest
  }
  async loadData() { return {} }
  async saveData() {}
  registerEvent() {}
  registerView() {}
  registerMarkdownCodeBlockProcessor(language, processor) {
    registeredMarkdownProcessors.push({ language, processor })
  }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
}

class MarkdownViewMock extends EmptyComponent {}

const obsidianMock = new Proxy({
  Plugin: PluginMock,
  ItemView: EmptyComponent,
  Modal: EmptyComponent,
  PluginSettingTab: EmptyComponent,
  MarkdownRenderChild: EmptyComponent,
  Menu: EmptyComponent,
  SuggestModal: EmptyComponent,
  Setting: EmptyComponent,
  ButtonComponent: EmptyComponent,
  TFile: EmptyComponent,
  TFolder: EmptyComponent,
  MarkdownView: MarkdownViewMock,
  Notice: EmptyComponent,
  Platform: { isMacOS: false, isWin: true, isDesktopApp: true },
  normalizePath: (value) => value,
  parseYaml: () => ({}),
  requestUrl: async () => ({}),
  setIcon: () => undefined,
  // 0.7.71：ribbon 与标签页改用自注册的 Q 版头像图标。桩里缺这个函数时，
  // 下面的 Proxy 会回落成 EmptyComponent 类，被当函数调用直接抛
  // 「Class constructor cannot be invoked without 'new'」——本测试即为此存在。
  addIcon: () => undefined,
}, {
  get(target, key) {
    return key in target ? target[key] : EmptyComponent
  },
})

const app = {
  secretStorage: {
    getSecret: () => null,
    setSecret: () => undefined,
    deleteSecret: () => undefined,
  },
  workspace: {
    rootSplit: {},
    getLeavesOfType: () => [],
    getActiveFile: () => null,
    getMostRecentLeaf: () => null,
    onLayoutReady: (callback) => callback(),
    on: () => ({}),
  },
  vault: {
    getFiles: () => [],
    getAllLoadedFiles: () => [],
    on: () => ({}),
  },
}

// This intentionally resembles a conservative Windows renderer startup: the
// plugin must load before PDF-only browser globals become available.
delete globalThis.DOMMatrix
delete globalThis.ImageData
delete globalThis.Path2D
delete globalThis.activeWindow
delete globalThis.window

const warnings = []
const originalWarn = console.warn
console.warn = (...values) => warnings.push(values.map(String).join(' '))
Module._load = (request, parent, isMain) => {
  if (request === 'obsidian') return obsidianMock
  if (request === 'electron') return {}
  if (['fs', 'fs/promises', 'os', 'path', 'child_process'].includes(request)) {
    throw new Error(`插件启动不得提前加载 Node 本地执行依赖：${request}`)
  }
  return originalLoad(request, parent, isMain)
}

try {
  const loaded = require(bundlePath)
  assert.equal(typeof loaded.default, 'function', '生产 main.js 必须导出插件类')
  const plugin = new loaded.default(app, { id: 'ai-linzi', version: 'test' })
  await plugin.onload()
  assert.equal(
    registeredMarkdownProcessors.some(
      ({ language, processor }) => language === 'ai-linzi-dashboard' && typeof processor === 'function',
    ),
    true,
    '插件启动必须注册 ai-linzi-dashboard Markdown 渲染器',
  )
  assert.equal(
    warnings.some((warning) => /DOMMatrix|ImageData|Path2D|activeWindow/i.test(warning)),
    false,
    '插件启动不得提前初始化 PDF 浏览器依赖',
  )
  console.log('production bundle load smoke test: ok')
} finally {
  Module._load = originalLoad
  console.warn = originalWarn
}

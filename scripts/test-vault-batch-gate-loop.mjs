// 批量收尾闸门的循环级行为回归（0.7.121）。
//
// 其他 Vault 测试只覆盖纯函数和源码契约；2026-09-18 的事故出在真实的工具循环里：
// 用户点名一份逐字稿生成客户档案，句子里有「文件夹下」→ 被判成批量 → 搜索顺带命中的
// 无关文件进了必读清单 → 模型每交一次方案就被「清单没读完」打回，同样的输入整轮重跑到
// 36 轮，一份结果都没有。这里直接加载生产包 main.js，拿到真实的 ChatView，用脚本化的
// 服务端响应把整条循环跑一遍，断言它一定收敛。
//
// 用法：node scripts/test-vault-batch-gate-loop.mjs [main.js 路径] [--expect-legacy-loop]
//   --expect-legacy-loop 只用于对照取证：喂旧版生产包，确认同一剧本确实会空转到轮次上限。
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const originalLoad = Module._load
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const expectLegacyLoop = args.includes('--expect-legacy-loop')
const bundlePath = path.resolve(
  args.find((value) => !value.startsWith('--')) ?? path.join(scriptDirectory, '..', 'main.js'),
)

class EmptyComponent {
  constructor(app) {
    this.app = app
  }
}
class TFileMock extends EmptyComponent {}
class TFolderMock extends EmptyComponent {}

const viewFactories = new Map()
class PluginMock extends EmptyComponent {
  constructor(app, manifest) {
    super(app)
    this.manifest = manifest
  }
  async loadData() { return {} }
  async saveData() {}
  registerEvent() {}
  registerView(type, factory) { viewFactories.set(type, factory) }
  registerMarkdownCodeBlockProcessor() {}
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
}

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
  TFile: TFileMock,
  TFolder: TFolderMock,
  MarkdownView: EmptyComponent,
  Notice: EmptyComponent,
  Platform: { isMacOS: true, isWin: false, isDesktopApp: true },
  normalizePath: (value) => value,
  parseYaml: () => ({}),
  requestUrl: async () => ({}),
  setIcon: () => undefined,
  addIcon: () => undefined,
}, {
  get(target, key) {
    return key in target ? target[key] : EmptyComponent
  },
})

const app = {
  secretStorage: { getSecret: () => 'test-token', setSecret: () => undefined, deleteSecret: () => undefined },
  workspace: {
    rootSplit: {},
    getLeavesOfType: () => [],
    getActiveFile: () => null,
    getMostRecentLeaf: () => null,
    onLayoutReady: () => undefined,
    on: () => ({}),
    requestSaveLayout: () => undefined,
  },
  vault: {
    configDir: '.obsidian',
    adapter: { exists: async () => false, mkdir: async () => {}, write: async () => {}, rename: async () => {}, remove: async () => {} },
    getFiles: () => [],
    getAllLoadedFiles: () => [],
    getAllFolders: () => [],
    getAbstractFileByPath: () => null,
    on: () => ({}),
  },
  getViewState: () => ({ state: {} }),
}

globalThis.window = {
  activeWindow: { crypto: webcrypto },
  setTimeout: (...values) => setTimeout(...values),
  clearTimeout: (handle) => clearTimeout(handle),
}

const originalWarn = console.warn
console.warn = () => undefined
Module._load = (request, parent, isMain) => {
  if (request === 'obsidian') return obsidianMock
  if (request === 'electron') return {}
  return originalLoad(request, parent, isMain)
}

// ── 剧本素材：与事故现场同构（2 份真正相关 + 13 份搜索顺带命中的无关文件）──
const TRANSCRIPT = '01_Raw/销售逐字稿/小A-第一次售前诊断谈话.docx'
const TEMPLATE = '02_Wiki/模板/客户档案模板.md'
const UNRELATED = Array.from({ length: 13 }, (_, index) => `01_Raw/其他资料/无关文件${index + 1}.md`)
const SEARCH_HITS = {
  transcript: [TRANSCRIPT, ...UNRELATED.slice(0, 7)],
  template: [TEMPLATE, ...UNRELATED.slice(7)],
}
const PLAN = {
  title: '新建客户档案：小A',
  summary: '根据第一次售前诊断谈话，按客户档案模板生成。',
  operations: [{
    type: 'create_note',
    path: '02_Wiki/客户档案/小A.md',
    content: '---\n客户称呼: 小A\n---\n\n## 基本情况\n\n来自第一次售前诊断谈话。',
    reason: '用户要求按模板生成客户档案',
  }],
  notes: [],
}
const PLAN_TEXT = [
  '已按模板整理好客户档案，确认后写入。',
  '<<<VAULT_ORGANIZE_PLAN>>>',
  JSON.stringify(PLAN),
  '<<<VAULT_ORGANIZE_PLAN_END>>>',
].join('\n')
const proseToolCalls = (calls) => [
  '<<<VAULT_TOOL_CALLS>>>',
  JSON.stringify({ calls }),
  '<<<VAULT_TOOL_CALLS_END>>>',
].join('\n')

function executeCallsMock(calls) {
  const results = []
  const sources = []
  for (const call of calls) {
    if (call.name === 'vault_search') {
      const hits = String(call.arguments.query).includes('模板')
        ? SEARCH_HITS.template
        : SEARCH_HITS.transcript
      for (const hit of hits) {
        sources.push({ sourceId: call.id, filename: hit.split('/').at(-1), path: hit, kind: 'search' })
      }
      results.push({
        callId: call.id,
        name: call.name,
        ok: true,
        output: JSON.stringify({ query: call.arguments.query, matches: hits.map((hit) => ({ path: hit })) }),
      })
      continue
    }
    if (call.name === 'read_note') {
      const target = String(call.arguments.path)
      sources.push({ sourceId: call.id, filename: target.split('/').at(-1), path: target, kind: 'read' })
      results.push({
        callId: call.id,
        name: call.name,
        ok: true,
        output: JSON.stringify({ path: target, content: `【${target} 的正文】`, nextOffset: null }),
      })
      continue
    }
    results.push({ callId: call.id, name: call.name, ok: false, output: '剧本没有安排这个工具' })
  }
  return Promise.resolve({ results, sources })
}

async function runScenario({ question, intent = 'auto', nativeFails = false, seedTask, chatScript }) {
  const loaded = require(bundlePath)
  const plugin = new loaded.default(app, { id: 'ai-linzi', version: 'test' })
  await plugin.onload()
  const factory = viewFactories.get('ai-linzi-chat')
  assert.equal(typeof factory, 'function', '插件必须注册对话视图')
  const view = factory(app)
  view.listEl = { scrollTop: 0, scrollHeight: 0 }
  const activity = []
  view.postSkillStatus = (text) => {
    activity.push(text)
    return 'activity-1'
  }
  view.renderMessages = () => undefined
  view.persistNow = async () => undefined
  if (seedTask) view.pendingVaultTask = seedTask

  plugin.vaultAgent.executeCalls = executeCallsMock
  plugin.vaultAgent.executeReadCalls = executeCallsMock
  plugin.vaultAgent.preflightPlan = async () => undefined
  plugin.vaultFileStat = (target) => ({ path: target, mtime: 1, size: 100 })

  const requests = []
  let nativeStep = 0
  let chatRound = 0
  // 普通主对话（intent=auto）的首轮走流式接口；这里与非流式共用同一份剧本和计数。
  view.sendStreaming = async (...streamArgs) => {
    chatRound += 1
    const vaultAgent = streamArgs[7]
    requests.push({ path: '/api/plugin/v1/chat#stream', body: { vaultAgent } })
    return { kind: 'ok', text: chatScript ? chatScript(chatRound, { vaultAgent }) : PLAN_TEXT }
  }
  plugin.api = async (apiPath, init) => {
    const body = init?.body ?? {}
    requests.push({ path: apiPath, body })
    if (apiPath === '/api/plugin/v1/vault-native/step' || apiPath === '/api/plugin/v2/vault-native/step') {
      if (nativeFails) throw new Error('native: scripted failure')
      nativeStep += 1
      const responseId = `resp-${nativeStep}`
      if (nativeStep === 1) {
        return {
          status: 'completed', ok: true, responseId,
          toolCalls: [
            { callId: 'call-search-1', name: 'vault_search', arguments: { query: '小A 第一次售前诊断对话' } },
            { callId: 'call-search-2', name: 'vault_search', arguments: { query: '客户档案模板' } },
          ],
        }
      }
      if (nativeStep === 2) {
        return {
          status: 'completed', ok: true, responseId,
          toolCalls: [
            { callId: 'call-read-1', name: 'read_note', arguments: { path: TEMPLATE } },
            { callId: 'call-read-2', name: 'read_note', arguments: { path: TRANSCRIPT } },
          ],
        }
      }
      // 之后无论被提醒多少次，模型都坚持「两份相关文件已经读完」，原样再交方案。
      return {
        status: 'completed', ok: true, responseId,
        toolCalls: [{ callId: `call-plan-${nativeStep}`, name: 'propose_organize_plan', arguments: PLAN }],
      }
    }
    if (apiPath === '/api/plugin/v1/chat') {
      chatRound += 1
      return { text: chatScript ? chatScript(chatRound, body) : PLAN_TEXT }
    }
    throw new Error(`剧本没有安排这个接口：${apiPath}`)
  }

  const result = await view.runVaultAgentLoop({
    question,
    signal: undefined,
    noteContext: undefined,
    authorizedContent: undefined,
    localSkill: undefined,
    localSkillContext: undefined,
    vaultAccess: true,
    vaultSearch: undefined,
    noteEdit: false,
    noteImageIntent: false,
    intent,
  })
  return { result, requests, activity, view }
}

const INCIDENT_QUESTION =
  '帮我把raw文件夹下面根据销售逐字稿“小A-第一次售前诊断对话”，在wiki文件下按照客户档案模板生成客户档案'
const TRUE_BATCH_QUESTION = '把raw文件夹下所有和小A有关的逐字稿整理成一份客户档案，放到wiki'

try {
  console.log(`[test-vault-batch-gate-loop] ${path.basename(path.dirname(bundlePath))}/main.js${expectLegacyLoop ? '（旧版对照）' : ''}`)

  // ── 1. 事故原句：点名一份逐字稿，不是批量 ──
  {
    const { result, requests, activity } = await runScenario({ question: INCIDENT_QUESTION })
    if (expectLegacyLoop) {
      // 对照取证：旧版把它判成批量，方案被无限打回，直到 36 轮保存断点，用户拿不到任何结果。
      assert.ok(requests.length >= 36, `旧版应空转到轮次上限，实际只调用了 ${requests.length} 次`)
      assert.match(result.text, /已保存本机断点/)
      assert.doesNotMatch(result.text, /VAULT_ORGANIZE_PLAN/)
      console.log(`  ✓ 1.（旧版对照）事故原句空转 ${requests.length} 次模型调用后只返回「已保存断点」`)
    } else {
      assert.equal(requests.length, 3, `搜索 → 读取 → 交方案，一共 3 次调用；实际 ${requests.length} 次`)
      assert.equal(requests.every((item) => item.body.batchMode === false), true, '点名单份文件不得进入批量模式')
      assert.match(result.text, /<<<VAULT_ORGANIZE_PLAN>>>/)
      assert.doesNotMatch(result.text, /已保存本机断点/)
      assert.doesNotMatch(result.text, /只基于已经读完/)
      assert.equal(activity.some((line) => /批量任务 第/.test(line)), false)
      console.log('  ✓ 1. 事故原句 3 次调用直达确认卡，不再进入批量模式')
    }
  }

  if (!expectLegacyLoop) {
    // ── 2. 真批量 + 搜索顺带命中无关文件（原生引擎）：提醒一次，模型坚持 → 放行并披露 ──
    {
      const { result, requests, activity } = await runScenario({ question: TRUE_BATCH_QUESTION })
      assert.equal(requests.every((item) => item.body.batchMode === true), true)
      assert.equal(requests.length, 4, `搜索 → 读取 → 方案 → 提醒后再交方案，共 4 次；实际 ${requests.length} 次`)
      const pushback = requests[3].body.toolOutputs
      assert.equal(pushback.length, 1)
      assert.equal(pushback[0].callId, 'call-plan-3', '提醒必须回在同一个方案调用上')
      assert.match(pushback[0].output, /无关文件1\.md/)
      assert.match(pushback[0].output, /不要读取，直接重新提交最终方案/)
      assert.match(result.text, /<<<VAULT_ORGANIZE_PLAN>>>/)
      assert.match(result.text, /只基于已经读完的 2 份文件/)
      assert.match(result.text, /清单里另有 13 份/)
      assert.equal(activity.some((line) => /批量清单还有 13 项未读/.test(line)), true)
      console.log('  ✓ 2. 真批量（原生引擎）只提醒一次，模型坚持则放行并注明 13 份未读')
    }

    // Recoverable failures must not restart with the entire context in chat.
    await assert.rejects(runScenario({ question: TRUE_BATCH_QUESTION, intent: 'organize', nativeFails: true }), /scripted failure/)

    // ── 4. 对话里残留一份没读完的旧批量任务，不得拖死之后的普通提问 ──
    {
      const staleTask = {
        id: 'vault-task-stale',
        goal: '批量处理逐字稿',
        intent: 'answer',
        stage: 'source_read',
        candidatePaths: [TRANSCRIPT, ...UNRELATED],
        sourcePaths: [],
        batch: {
          version: 1,
          status: 'paused',
          pauseReason: 'user',
          completedPaths: [{ path: TRANSCRIPT, mtime: 1, size: 100 }],
          readProgress: [],
          failures: [],
          folderProgress: [],
          checkpointSeq: 3,
          resumeCount: 0,
          updatedAt: Date.now(),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const { result, requests } = await runScenario({
        question: '用一句话解释什么是私域',
        seedTask: staleTask,
        chatScript: () => '私域就是你能反复、免费触达的客户关系。',
      })
      assert.equal(requests.length, 1, `普通提问一次回答即可；实际 ${requests.length} 次`)
      assert.equal(result.text, '私域就是你能反复、免费触达的客户关系。')
      console.log('  ✓ 4. 残留的旧批量任务不再拦截同一对话里的普通提问')
    }
  } else {
    // 对照取证：旧版里残留的批量任务会把普通提问也打回到轮次上限。
    const staleTask = {
      id: 'vault-task-stale',
      goal: '批量处理逐字稿',
      intent: 'answer',
      stage: 'source_read',
      candidatePaths: [TRANSCRIPT, ...UNRELATED],
      sourcePaths: [],
      batch: {
        version: 1,
        status: 'paused',
        pauseReason: 'user',
        completedPaths: [{ path: TRANSCRIPT, mtime: 1, size: 100 }],
        readProgress: [],
        failures: [],
        folderProgress: [],
        checkpointSeq: 3,
        resumeCount: 0,
        updatedAt: Date.now(),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const { result, requests } = await runScenario({
      question: '用一句话解释什么是私域',
      seedTask: staleTask,
      chatScript: () => '私域就是你能反复、免费触达的客户关系。',
    })
    assert.ok(requests.length >= 12, `旧版应把普通提问也空转到上限，实际 ${requests.length} 次`)
    assert.match(result.text, /已保存本机断点/)
    console.log(`  ✓ 4.（旧版对照）残留批量任务让一句普通提问空转 ${requests.length} 次后只返回「已保存断点」`)
  }

  console.log('[test-vault-batch-gate-loop] 全部通过')
} finally {
  Module._load = originalLoad
  console.warn = originalWarn
}

import assert from 'node:assert/strict'
import esbuild from 'esbuild'

const obsidianMock = `
export class App {}
export class TFile {
  constructor(path, content = '', mtime = Date.now()) {
    this.path = path
    this.name = path.split('/').at(-1)
    this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''
    this.content = content
    this.stat = { size: content.length, mtime }
  }
}
export class TFolder {
  constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = [] }
}
export const normalizePath = (value) => value.replaceAll('\\\\', '/').replace(/^\\.\\//, '')
export const parseYaml = () => ({})
`

const built = await esbuild.build({
  stdin: {
    contents: `
      export { LocalVaultAgent } from './src/vault-agent.ts'
      export { TFile, TFolder } from 'obsidian'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'weekly-business-agent-test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
  plugins: [
    {
      name: 'obsidian-test-double',
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-double' }))
        build.onResolve({ filter: /local-document-text$/ }, () => ({
          path: 'local-document-text',
          namespace: 'test-double',
        }))
        build.onResolve({ filter: /vault-search$/ }, () => ({
          path: 'vault-search',
          namespace: 'test-double',
        }))
        build.onResolve({ filter: /local-skill-core$/ }, () => ({
          path: 'local-skill-core',
          namespace: 'test-double',
        }))
        build.onLoad({ filter: /.*/, namespace: 'test-double' }, (args) => {
          const contents = args.path === 'local-document-text'
            ? 'export const isLocalSearchExtension = () => true'
            : args.path === 'vault-search'
              ? 'export class LocalVaultSearch {}'
              : args.path === 'local-skill-core'
                ? 'export const extendContiguousRead = () => 0; export const localSkillLinkedPathCandidates = () => []'
                : obsidianMock
          return { contents, loader: 'js' }
        })
      },
    },
  ],
})
const module = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)

const files = new Map()
const app = {
  vault: {
    getFiles() {
      return [...files.values()].filter((value) => value instanceof module.TFile)
    },
    getAbstractFileByPath(path) {
      return files.get(path) ?? null
    },
  },
}
const search = {
  async readPathForRecentBatch(path, options) {
    const file = files.get(path)
    if (!(file instanceof module.TFile)) throw new Error(`missing: ${path}`)
    const offset = options.offset ?? 0
    const content = file.content.slice(offset, offset + options.maxChars)
    return {
      filename: file.name,
      text: content,
      totalChars: file.content.length,
      offset,
      nextOffset: offset + content.length < file.content.length ? offset + content.length : null,
    }
  },
}
const now = Date.now()
const addFile = (path, content, mtime) => {
  const file = new module.TFile(path, content, mtime)
  files.set(path, file)
  return file
}
const call = {
  id: 'weekly-dashboard-preload',
  name: 'read_recent_documents',
  arguments: { sinceDays: 7, offset: 0, maxChars: 70_000 },
}

// 首次全量：故意让 JSON 转义后的工具结果超过 180k，模拟真实 HTML/复杂正文触发截断。
addFile('02_Wiki/本周记录.md', '\u0000'.repeat(70_000), now - 1_000)
addFile('05_System/Skills/官方模板/SKILL.md', '必须排除', now)
addFile('04_Output/AI霖子输出/经营周报/旧看板.html', '不得扫描自己输出', now)
const fullAgent = new module.LocalVaultAgent(
  app,
  search,
  () => '05_System/Skills',
  () => '04_Output/AI霖子输出',
)
const full = await fullAgent.executeCalls([call])
assert.equal(JSON.parse(full.results[0].output).truncated, true)
assert.equal(full.weeklyBusinessScan?.sinceDays, 7)
assert.deepEqual(
  full.weeklyBusinessScan?.files.map((file) => file.path),
  ['02_Wiki/本周记录.md'],
  '工具输出被截断时，仍必须独立保留完整指纹',
)
assert.deepEqual(
  fullAgent.latestWeeklyBusinessScan(),
  full.weeklyBusinessScan,
  '对话返回对象丢掉附加元数据时，应能从同一次已完成快照取回指纹',
)

// 后续刷新：旧看板作为基线，只读新增/改动文件，但返回完整新指纹。
files.clear()
const unchanged = addFile('02_Wiki/本周记录.md', '本周原内容', now - 2_000)
const changed = addFile('02_Wiki/客户进展.md', '旧进展', now - 3_000)
const removed = new module.TFile('03_Dashboard/旧任务.md', '已删除任务', now - 4_000)
const baselinePath = '04_Output/AI霖子输出/经营周报/2026.08.20_经营周报交互看板.html'
addFile(baselinePath, '<html><body>上一版完整看板</body></html>', now - 5_000)
const cache = {
  version: 1,
  artifactPath: baselinePath,
  updatedAt: now - 5_000,
  capturedAt: now - 5_000,
  sinceDays: 7,
  files: [
    { path: unchanged.path, mtime: unchanged.stat.mtime, size: unchanged.stat.size },
    { path: changed.path, mtime: changed.stat.mtime, size: changed.stat.size },
    { path: removed.path, mtime: removed.stat.mtime, size: removed.stat.size },
  ],
}
changed.content = '新进展：已成交'
changed.stat = { size: changed.content.length, mtime: now - 500 }
const added = addFile('03_Dashboard/今日待办.md', '今日新增待办', now - 250)

const incrementalAgent = new module.LocalVaultAgent(
  app,
  search,
  () => '05_System/Skills',
  () => '04_Output/AI霖子输出',
  () => cache,
)
const incremental = await incrementalAgent.executeCalls([call])
const payload = JSON.parse(incremental.results[0].output)
assert.equal(payload.refreshMode, 'incremental')
assert.equal(payload.baselineDashboard.path, baselinePath)
assert.equal(payload.baselineDashboard.content.includes('上一版完整看板'), true)
assert.equal(payload.changedFiles, 2)
assert.equal(payload.unchangedFiles, 1)
assert.deepEqual(payload.removedFiles, [removed.path])
assert.deepEqual(
  payload.documents.map((document) => document.path).sort(),
  [added.path, changed.path].sort(),
)
assert.deepEqual(
  incremental.sources.map((source) => source.path).sort(),
  [added.path, changed.path].sort(),
  '增量刷新不应重复发送未变文档',
)
assert.deepEqual(
  incremental.weeklyBusinessScan?.files.map((file) => file.path).sort(),
  [added.path, changed.path, unchanged.path].sort(),
  '确认新看板后应写入完整新指纹，供下一次继续增量',
)

console.log('Weekly business agent integration tests passed')

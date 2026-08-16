import assert from 'node:assert/strict'
import esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'

const obsidianMock = `
export class App {}
export class TFile {
  constructor(path) {
    this.path = path
    this.name = path.split('/').at(-1)
    this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''
    this.stat = { size: 1, mtime: 1 }
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
    sourcefile: 'vault-trash-test-entry.ts',
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
const trashCalls = []
const search = { clearCalls: 0, clear() { this.clearCalls += 1 } }
const app = {
  vault: {
    getAbstractFileByPath(path) { return files.get(path) ?? null },
    async trash(file, system) {
      trashCalls.push({ path: file.path, system })
      files.delete(file.path)
    },
  },
  fileManager: {
    async renameFile() { throw new Error('本测试不应移动文件') },
  },
}
const agent = new module.LocalVaultAgent(app, search, () => '05_System/Skills')

const note = new module.TFile('000_Inbox/重复笔记.md')
files.set(note.path, note)
const record = await agent.applyPlan({
  title: '删除重复笔记',
  summary: '只移入回收站',
  operations: [{ type: 'trash_note', path: note.path }],
  notes: [],
})
assert.deepEqual(trashCalls, [{ path: note.path, system: true }])
assert.deepEqual(record.trashedNotes, [note.path])
assert.deepEqual(record.moves, [])
assert.equal(files.has(note.path), false)
assert.equal(search.clearCalls, 1)
await assert.rejects(agent.undo(record), /系统废纸篓\/回收站恢复/)

const attachment = new module.TFile('000_Inbox/截图.png')
files.set(attachment.path, attachment)
await assert.rejects(
  agent.applyPlan({
    title: '删除附件',
    summary: '',
    operations: [{ type: 'trash_note', path: attachment.path }],
    notes: [],
  }),
  /只允许把 Markdown 笔记移入回收站/,
)

const another = new module.TFile('000_Inbox/另一篇.md')
files.set(another.path, another)
await assert.rejects(
  agent.applyPlan({
    title: '批量删除',
    summary: '',
    operations: [
      { type: 'trash_note', path: another.path },
      { type: 'create_folder', path: '06_Archive' },
    ],
    notes: [],
  }),
  /每次确认只能把一篇/,
)
assert.deepEqual(trashCalls, [{ path: note.path, system: true }])

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(
  mainSource,
  /const record = message\.vaultActionId\s*\?\s*this\.plugin\.getVaultActionRecord\(message\.vaultActionId\)\s*:\s*undefined/,
  '没有 vaultActionId 的新确认卡不得借用上一条移动记录冒充已执行',
)

console.log('Vault trash-note integration tests passed')

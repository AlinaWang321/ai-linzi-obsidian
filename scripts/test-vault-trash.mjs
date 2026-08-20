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
  },
  fileManager: {
    async renameFile() { throw new Error('本测试不应移动文件') },
    async trashFile(file) {
      trashCalls.push({ path: file.path })
      files.delete(file.path)
    },
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
assert.deepEqual(trashCalls, [{ path: note.path }])
assert.deepEqual(record.trashedNotes, [note.path])
assert.deepEqual(record.moves, [])
assert.equal(files.has(note.path), false)
assert.equal(search.clearCalls, 1)
await assert.rejects(agent.undo(record), /系统废纸篓\/回收站恢复/)

// ── v0.7.42：任意文件类型 + 批量 + 文件夹 ──
const attachment = new module.TFile('000_Inbox/截图.png')
const slides = new module.TFile('04_Output/演示文稿/打卡营第一课.pptx')
files.set(attachment.path, attachment)
files.set(slides.path, slides)
const batchRecord = await agent.applyPlan({
  title: '清理演示产物',
  summary: '',
  operations: [
    { type: 'trash_note', path: attachment.path },
    { type: 'trash_note', path: slides.path },
  ],
  notes: [],
})
assert.deepEqual(batchRecord.trashedNotes, [attachment.path, slides.path])
assert.equal(files.has(attachment.path), false)
assert.equal(files.has(slides.path), false)
assert.equal(search.clearCalls, 2)
await assert.rejects(agent.undo(batchRecord), /系统废纸篓\/回收站恢复/)

// 文件夹整夹移入回收站（不含受保护路径时放行）
const tempFolder = new module.TFolder('04_Output/临时快照')
const insideFile = new module.TFile('04_Output/临时快照/快照.html')
tempFolder.children = [insideFile]
files.set(tempFolder.path, tempFolder)
files.set(insideFile.path, insideFile)
const folderRecord = await agent.applyPlan({
  title: '删除临时快照目录',
  summary: '',
  operations: [{ type: 'trash_note', path: tempFolder.path }],
  notes: [],
})
assert.deepEqual(folderRecord.trashedNotes, [tempFolder.path])

// 文件夹内裹挟受保护路径（本地 Skills 根目录）必须整单拒绝
const sysFolder = new module.TFolder('05_System')
const skillsRoot = new module.TFolder('05_System/Skills')
sysFolder.children = [skillsRoot]
files.set(sysFolder.path, sysFolder)
await assert.rejects(
  agent.applyPlan({
    title: '删除系统目录',
    summary: '',
    operations: [{ type: 'trash_note', path: sysFolder.path }],
    notes: [],
  }),
  /不能整夹移入回收站/,
)

// 混排（删除 + 其他操作）仍必须拒绝
const another = new module.TFile('000_Inbox/另一篇.md')
files.set(another.path, another)
await assert.rejects(
  agent.applyPlan({
    title: '混排方案',
    summary: '',
    operations: [
      { type: 'trash_note', path: another.path },
      { type: 'create_folder', path: '06_Archive' },
    ],
    notes: [],
  }),
  /不能混入/,
)

// 嵌套目标（文件夹 + 其内部文件）必须拒绝
const parentFolder = new module.TFolder('01_Raw/旧资料')
const childFile = new module.TFile('01_Raw/旧资料/旧稿.md')
parentFolder.children = [childFile]
files.set(parentFolder.path, parentFolder)
files.set(childFile.path, childFile)
await assert.rejects(
  agent.applyPlan({
    title: '嵌套删除',
    summary: '',
    operations: [
      { type: 'trash_note', path: parentFolder.path },
      { type: 'trash_note', path: childFile.path },
    ],
    notes: [],
  }),
  /已在待删除文件夹/,
)

// 重复目标必须拒绝
await assert.rejects(
  agent.applyPlan({
    title: '重复删除',
    summary: '',
    operations: [
      { type: 'trash_note', path: another.path },
      { type: 'trash_note', path: another.path },
    ],
    notes: [],
  }),
  /重复的删除目标/,
)
assert.equal(files.has(another.path), true, '被拒绝的方案不得移动任何文件')

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
assert.match(
  mainSource,
  /const record = message\.vaultActionId\s*\?\s*this\.plugin\.getVaultActionRecord\(message\.vaultActionId\)\s*:\s*undefined/,
  '没有 vaultActionId 的新确认卡不得借用上一条移动记录冒充已执行',
)

console.log('Vault trash-note integration tests passed')

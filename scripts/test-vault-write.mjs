import assert from 'node:assert/strict'
import esbuild from 'esbuild'

const obsidianMock = `
export class App {}
export class TFile {
  constructor(path, content = '') {
    this.path = path
    this.name = path.split('/').at(-1)
    this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''
    this.content = content
    this.stat = { size: content.length, mtime: 1 }
  }
}
export class TFolder {
  constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = [] }
}
export const normalizePath = (value) => value.replaceAll('\\\\', '/').replace(/^\\.\\//, '')
`

const built = await esbuild.build({
  stdin: {
    contents: `
      export { LocalVaultAgent } from './src/vault-agent.ts'
      export { TFile, TFolder } from 'obsidian'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'vault-write-test-entry.ts',
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
        build.onResolve({ filter: /local-document-text$/ }, () => ({ path: 'local-document-text', namespace: 'test-double' }))
        build.onResolve({ filter: /vault-search$/ }, () => ({ path: 'vault-search', namespace: 'test-double' }))
        build.onResolve({ filter: /local-skill-core$/ }, () => ({ path: 'local-skill-core', namespace: 'test-double' }))
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
const search = { clearCalls: 0, clear() { this.clearCalls += 1 } }
const tick = (file, content) => {
  file.content = content
  file.stat = { size: content.length, mtime: file.stat.mtime + 1 }
}
const app = {
  vault: {
    getAbstractFileByPath(path) { return files.get(path) ?? null },
    async createFolder(path) { files.set(path, new module.TFolder(path)) },
    async create(path, content) {
      if (files.has(path)) throw new Error('exists')
      const file = new module.TFile(path, content)
      files.set(path, file)
      return file
    },
    async process(file, transform) {
      const next = transform(file.content)
      tick(file, next)
    },
  },
  fileManager: {
    async renameFile() { throw new Error('本测试不应移动文件') },
  },
}
const agent = new module.LocalVaultAgent(app, search, () => '05_System/Skills')

const profilePath = '02_Wiki/客户档案/客户甲.md'
const profile = new module.TFile(profilePath, '---\n姓名: 客户甲\n---\n# 客户甲\n\n旧行动计划\n')
files.set('02_Wiki', new module.TFolder('02_Wiki'))
files.set('02_Wiki/客户档案', new module.TFolder('02_Wiki/客户档案'))
files.set(profilePath, profile)

const appendPlan = {
  title: '追加咨询记录',
  summary: '',
  operations: [{ type: 'append_note', path: profilePath, content: '## 2026-08-15 咨询记录\n\n已确认内容' }],
  notes: [],
}
const appendRecord = await agent.applyPlan(appendPlan, agent.captureWriteSnapshots(appendPlan))
assert.deepEqual(appendRecord.updatedNotes, [profilePath])
assert.match(profile.content, /旧行动计划[\s\S]*2026-08-15 咨询记录/)

const updatePlan = {
  title: '局部更新行动计划',
  summary: '',
  operations: [{ type: 'update_note', path: profilePath, replacements: [{ old: '旧行动计划', new: '新行动计划' }] }],
  notes: [],
}
await agent.applyPlan(updatePlan, agent.captureWriteSnapshots(updatePlan))
assert.match(profile.content, /新行动计划/)
assert.doesNotMatch(profile.content, /旧行动计划/)

const replacePlan = {
  title: '整篇更新',
  summary: '',
  operations: [{ type: 'replace_note', path: profilePath, content: '# 客户甲最终档案\n\n最终内容' }],
  notes: [],
}
await agent.applyPlan(replacePlan, agent.captureWriteSnapshots(replacePlan))
assert.equal(profile.content, '---\n姓名: 客户甲\n---\n# 客户甲最终档案\n\n最终内容\n')

const stalePlan = {
  title: '过期方案',
  summary: '',
  operations: [{ type: 'append_note', path: profilePath, content: '不应写入' }],
  notes: [],
}
const staleSnapshots = agent.captureWriteSnapshots(stalePlan)
tick(profile, `${profile.content}\n用户刚刚手动修改\n`)
await assert.rejects(agent.applyPlan(stalePlan, staleSnapshots), /确认前已经变化/)
assert.doesNotMatch(profile.content, /不应写入/)

const createPlan = {
  title: '新建客户档案',
  summary: '',
  operations: [{ type: 'create_note', path: '02_Wiki/新客户/客户乙.md', content: '# 客户乙' }],
  notes: [],
}
const createRecord = await agent.applyPlan(createPlan)
assert.deepEqual(createRecord.createdNotes, ['02_Wiki/新客户/客户乙.md'])
assert.ok(files.get('02_Wiki/新客户') instanceof module.TFolder)
assert.equal(files.get('02_Wiki/新客户/客户乙.md').content, '# 客户乙\n')
await assert.rejects(agent.applyPlan(createPlan), /目标笔记已存在/)

await assert.rejects(
  agent.applyPlan({
    title: '混合写入',
    summary: '',
    operations: [
      { type: 'create_folder', path: '混合目录' },
      { type: 'create_note', path: '混合目录/内容.md', content: '内容' },
    ],
    notes: [],
  }),
  /每次确认只能写入一篇/,
)

console.log('Vault single-note write integration tests passed')

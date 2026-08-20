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
export const parseYaml = (value) => {
  if (!value.trim() || value.includes('无效 YAML')) throw new Error('bad yaml')
  return Object.fromEntries(value.split(/\\r?\\n/).filter((line) => /^[^ \\t:#][^:]*:/.test(line)).map((line) => {
    const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
  }))
}
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
let failCreatePath = ''
let onFailCreate = null
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
      if (path === failCreatePath) {
        onFailCreate?.()
        throw new Error('simulated create failure')
      }
      if (files.has(path)) throw new Error('exists')
      const file = new module.TFile(path, content)
      files.set(path, file)
      return file
    },
    async createBinary(path, data) {
      if (files.has(path)) throw new Error('exists')
      const file = new module.TFile(path, '')
      file.data = data
      file.stat.size = data.byteLength
      files.set(path, file)
      return file
    },
    async process(file, transform) {
      const next = transform(file.content)
      tick(file, next)
    },
    async cachedRead(file) { return file.content },
    async delete(item) { files.delete(item.path) },
  },
  fileManager: {
    async renameFile() { throw new Error('本测试不应移动文件') },
    async trashFile(item) { files.delete(item.path) },
  },
}
const agent = new module.LocalVaultAgent(app, search, () => '05_System/Skills', () => 'AI霖子输出')

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

const frontmatterPlan = {
  title: '更新客户档案属性',
  summary: '',
  operations: [{
    type: 'update_note',
    path: profilePath,
    frontmatter: {
      old: '---\n姓名: 客户甲\n---',
      new: '---\n姓名: 客户甲\n档案状态: 已更新\n---',
    },
  }],
  notes: [],
}
await agent.preflightPlan(frontmatterPlan)
await agent.applyPlan(frontmatterPlan, agent.captureWriteSnapshots(frontmatterPlan))
assert.match(profile.content, /档案状态: 已更新/)
await assert.rejects(
  agent.preflightPlan({
    ...frontmatterPlan,
    operations: [{
      ...frontmatterPlan.operations[0],
      frontmatter: {
        old: '---\n姓名: 错误对象\n---',
        new: '---\n姓名: 客户甲\n档案状态: 错误\n---',
      },
    }],
  }),
  /YAML 属性原文与目标笔记不一致/,
)

const replacePlan = {
  title: '整篇更新',
  summary: '',
  operations: [{ type: 'replace_note', path: profilePath, content: '# 客户甲最终档案\n\n最终内容' }],
  notes: [],
}
await agent.applyPlan(replacePlan, agent.captureWriteSnapshots(replacePlan))
assert.equal(profile.content, '---\n姓名: 客户甲\n档案状态: 已更新\n---\n# 客户甲最终档案\n\n最终内容\n')

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
const templatePath = '05_System/Skills/customer-profile/references/客户档案模板.md'
files.set(templatePath, new module.TFile(
  templatePath,
  '---\n客户称呼: "{{客户称呼}}"\n档案状态: "{{档案状态}}"\n---\n# {{客户称呼}}\n\n## 一、基本背景\n\n## 二、行动计划\n',
))
await assert.rejects(
  agent.preflightPlan(createPlan, { templatePath }),
  /未通过 Skill 模板预检/,
)
const templatedCreatePlan = {
  ...createPlan,
  operations: [{
    type: 'create_note',
    path: '02_Wiki/新客户/客户丙.md',
    content: '---\n客户称呼: 客户丙\n档案状态: 初次整理\n---\n# 客户丙\n\n## 一、基本背景\n\n待补充\n\n## 二、行动计划\n\n待确认',
  }],
}
await agent.preflightPlan(templatedCreatePlan, { templatePath })
const createRecord = await agent.applyPlan(createPlan)
assert.deepEqual(createRecord.createdNotes, ['02_Wiki/新客户/客户乙.md'])
assert.ok(files.get('02_Wiki/新客户') instanceof module.TFolder)
assert.equal(files.get('02_Wiki/新客户/客户乙.md').content, '# 客户乙\n')
await assert.rejects(agent.applyPlan(createPlan), /目标笔记已存在/)

const outputAliasNotePlan = {
  title: '新建七天行动计划',
  summary: '',
  operations: [{
    type: 'create_note',
    path: '$OUTPUT/行动计划/七天计划.md',
    content: '# 七天计划',
  }],
  notes: [],
}
await agent.preflightPlan(outputAliasNotePlan)
const outputAliasNoteRecord = await agent.applyPlan(outputAliasNotePlan)
assert.deepEqual(outputAliasNoteRecord.createdNotes, ['AI霖子输出/行动计划/七天计划.md'])
assert.equal(files.has('AI霖子输出/行动计划/七天计划.md'), true)
assert.equal(files.has('$OUTPUT'), false, '不得在 Vault 根目录创建字面量 $OUTPUT 文件夹')

const multiWritePlan = {
  title: '客户档案与行动清单变更集',
  summary: '',
  operations: [
    {
      type: 'update_note',
      path: profilePath,
      replacements: [{ old: '最终内容', new: '最终内容（已复核）' }],
    },
    { type: 'create_note', path: '02_Wiki/行动清单/客户甲.md', content: '# 客户甲行动清单' },
  ],
  notes: [],
}
await agent.preflightPlan(multiWritePlan)
const multiWriteRecord = await agent.applyPlan(
  multiWritePlan,
  agent.captureWriteSnapshots(multiWritePlan),
)
assert.deepEqual(multiWriteRecord.updatedNotes, [profilePath])
assert.deepEqual(multiWriteRecord.createdNotes, ['02_Wiki/行动清单/客户甲.md'])
assert.match(profile.content, /最终内容（已复核）/)
assert.equal(files.get('02_Wiki/行动清单/客户甲.md').content, '# 客户甲行动清单\n')

const beforeRollback = profile.content
const rollbackPlan = {
  title: '失败自动回滚',
  summary: '',
  operations: [
    {
      type: 'update_note',
      path: profilePath,
      replacements: [{ old: '最终内容（已复核）', new: '不应留下的修改' }],
    },
    { type: 'create_note', path: '02_Wiki/回滚演示/第一篇.md', content: '# 第一篇' },
    { type: 'create_note', path: '02_Wiki/回滚演示/第二篇.md', content: '# 第二篇' },
  ],
  notes: [],
}
failCreatePath = '02_Wiki/回滚演示/第二篇.md'
await assert.rejects(
  agent.applyPlan(rollbackPlan, agent.captureWriteSnapshots(rollbackPlan)),
  /simulated create failure；本轮变更已自动回滚/,
)
failCreatePath = ''
assert.equal(profile.content, beforeRollback)
assert.equal(files.has('02_Wiki/回滚演示/第一篇.md'), false)
assert.equal(files.has('02_Wiki/回滚演示/第二篇.md'), false)
assert.equal(files.has('02_Wiki/回滚演示'), false)

// 回滚期间若目标已被用户并发编辑，保留用户新内容并明确报告，绝不覆盖。
const concurrentEditPlan = {
  title: '并发编辑保护',
  summary: '',
  operations: [
    {
      type: 'update_note',
      path: profilePath,
      replacements: [{ old: '最终内容（已复核）', new: '等待回滚的修改' }],
    },
    { type: 'create_note', path: '02_Wiki/并发测试/失败.md', content: '# 失败' },
  ],
  notes: [],
}
failCreatePath = '02_Wiki/并发测试/失败.md'
onFailCreate = () => tick(profile, `${profile.content}\n用户在执行期间的新编辑\n`)
await assert.rejects(
  agent.applyPlan(concurrentEditPlan, agent.captureWriteSnapshots(concurrentEditPlan)),
  /自动回滚仍有 1 项失败/,
)
failCreatePath = ''
onFailCreate = null
assert.match(profile.content, /等待回滚的修改/)
assert.match(profile.content, /用户在执行期间的新编辑/)

const artifactPlan = {
  title: '生成客户方案 Word',
  summary: '本机生成，不覆盖',
  operations: [{
    type: 'create_artifact',
    path: '$OUTPUT/文档/客户方案.docx',
    format: 'docx',
    title: '客户方案',
    content: '# 客户方案\n\n## 下一步\n\n完成第一次交付。',
    theme: 'brand',
  }],
  notes: [],
}
await agent.preflightPlan(artifactPlan)
const artifactRecord = await agent.applyPlan(artifactPlan)
assert.deepEqual(artifactRecord.createdArtifacts, ['AI霖子输出/文档/客户方案.docx'])
assert.ok(files.get('AI霖子输出/文档/客户方案.docx').data instanceof ArrayBuffer)
assert.equal(Buffer.from(files.get('AI霖子输出/文档/客户方案.docx').data).subarray(0, 2).toString(), 'PK')
await assert.rejects(agent.applyPlan(artifactPlan), /目标文件已存在/)

await assert.rejects(
  agent.applyPlan({
    title: '混合成品',
    summary: '',
    operations: [
      artifactPlan.operations[0],
      { type: 'create_folder', path: '不应创建' },
    ],
    notes: [],
  }),
  /每次确认只能生成一个成品文件/,
)
assert.equal(files.has('不应创建'), false)

await assert.rejects(
  agent.preflightPlan({
    ...artifactPlan,
    operations: [{ ...artifactPlan.operations[0], path: '05_System/Skills/越界.docx' }],
  }),
  /保护目录/,
)

// 「一键生成目录」回归（2026-08-17 客户报的 bug）：
// 模型生成的骨架方案里带着 05_System/Skills，旧逻辑整份 8 项方案连坐被拒，
// 用户看到「执行失败：方案涉及保护目录」，一个文件夹都建不出来。
const scaffoldPlan = {
  title: '搭建大脑骨架',
  summary: '',
  operations: [
    { type: 'create_folder', path: '01_Raw' },
    { type: 'create_folder', path: '02_Wiki' },
    { type: 'create_folder', path: '03_Dashboard' },
    { type: 'create_folder', path: '04_Output' },
    { type: 'create_folder', path: '05_System' },
    { type: 'create_folder', path: '05_System/Skills' },
    { type: 'create_folder', path: '06_Archive' },
  ],
  notes: [],
}
const scaffoldRecord = await agent.applyPlan(scaffoldPlan)
// Skill 目录必须是「本次真的新建出来」的，不能只是没报错
assert.equal(scaffoldRecord.createdFolders.includes('05_System/Skills'), true)
// 其余 6 个也都要落地（已存在的会被 ensureFolder 跳过，所以查最终状态而不是 createdFolders）
for (const operation of scaffoldPlan.operations) {
  assert.equal(files.get(operation.path) instanceof module.TFolder, true, `${operation.path} 应存在`)
}

// 但方案里只要有「往 Skill 目录写内容」就照样整份拒绝
await assert.rejects(
  agent.applyPlan({
    title: '越界',
    summary: '',
    operations: [{ type: 'create_folder', path: '07_New' }, { type: 'move', from: '02_Wiki/x.md', to: '05_System/Skills/x.md' }],
    notes: [],
  }),
  /保护目录/,
)

console.log('Vault multi-note transaction and artifact write integration tests passed')

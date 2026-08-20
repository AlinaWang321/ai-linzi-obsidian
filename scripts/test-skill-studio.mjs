import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'

async function importBundle(options) {
  const bundled = await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    ...options,
  })
  const source = bundled.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

const studioCore = await importBundle({ entryPoints: ['src/skill-studio-core.ts'] })
const skillParser = await importBundle({ entryPoints: ['src/create-local-skill.ts'] })
const localSkillCore = await importBundle({ entryPoints: ['src/local-skill-core.ts'] })
const questionCore = await importBundle({ entryPoints: ['src/vault-question-core.ts'] })

console.log('[test-skill-studio]')

assert.equal(studioCore.OFFICIAL_SKILL_TEMPLATES.length, 5)
for (const template of studioCore.OFFICIAL_SKILL_TEMPLATES) {
  const protocol = template.block.files
    .map((file) => `<<<Skill文件 path=${file.path}>>>\n${file.content}\n<<<Skill文件结束>>>`)
    .join('\n')
  const parsed = skillParser.parsePortableSkillBundle(template.block.name, protocol)
  assert.ok(parsed, `${template.id} 应是可移植 Skill 包`)
  const manifest = JSON.parse(
    template.block.files.find((file) => file.path === 'references/ai-linzi-skill-manifest.json').content,
  )
  assert.equal(manifest.skillVersion, '1.0.0')
  assert.equal(manifest.createdWith, 'AI霖子 Skill Studio')
  assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.length > 0)
  assert.deepEqual(manifest.programs, [])
  assert.deepEqual(manifest.sampleInputs, [template.sampleInput])
  assert.equal(template.block.files.some((file) => file.path.startsWith('scripts/')), false)
  assert.match(template.block.content, /^description: .+时使用。$/m)
  assert.match(template.block.content, /references\/ai-linzi-skill-manifest\.json/)
  assert.equal(localSkillCore.localSkillOutputFromMarkdown(template.block.content), 'create-note')
  assert.equal(studioCore.skillBlockManifest(template.block).valid, true)
  for (const file of template.block.files.filter(
    (item) => item.path.startsWith('references/') && !item.path.endsWith('ai-linzi-skill-manifest.json'),
  )) {
    assert.ok(template.block.content.includes(file.path), `${template.id} 必须在 SKILL.md 指向 ${file.path}`)
  }
}
console.log('  ✓ 5 个官方模板都可移植、触发说明完整、输出方式可解析、引用可达且不含脚本')

assert.equal(studioCore.isExplicitLocalSkillCreationIntent('帮我创建一个客户跟进 Skill'), true)
assert.equal(studioCore.isExplicitLocalSkillCreationIntent('Skill 是什么？'), false)
assert.equal(studioCore.isExplicitLocalSkillCreationIntent('列出我的 Skills'), false)
const prompt = studioCore.buildSkillStudioPrompt({
  name: 'client-follow-up',
  purpose: '把咨询记录变成后续行动清单',
  input: '当前明确打开的咨询笔记',
  steps: '提炼事实\n列行动项\n检查缺失负责人',
  triggers: ['生成客户跟进行动清单'],
  output: 'create-note',
  sampleInput: '处理当前咨询笔记',
  version: '1.0.0',
})
assert.match(prompt, /ai-linzi-skill-manifest\.json/)
assert.match(prompt, /本版禁止生成 scripts/)
assert.match(prompt, /sampleInputs=/)
assert.match(prompt, /SKILL\.md 必须链接该 manifest/)
const broadScopePrompt = studioCore.buildSkillStudioPrompt({
  name: 'weekly-review',
  purpose: '做周复盘',
  input: '知识库最近文件',
  steps: '列清单\n读必要文件\n生成复盘',
  triggers: ['生成本周复盘'],
  output: 'create-note',
  sampleInput: '生成本周复盘',
  version: '1.0.0',
})
assert.match(broadScopePrompt, /仅在用户明确要求时搜索 Vault/)
console.log('  ✓ 创建意图与 Skill Studio 结构化提示词')

const pendingQuestion = {
  callId: 'call-1',
  responseId: 'resp-1',
  question: '这次要处理当前笔记，还是整个指定文件夹？',
  options: ['当前笔记', '指定文件夹'],
  allowFreeText: true,
  round: 2,
  goal: '批量整理客户档案',
  createdAt: 123,
}
const marked = `请补充范围。\n${questionCore.formatVaultQuestionMarker(pendingQuestion)}`
const extractedQuestion = questionCore.extractVaultQuestion(marked)
assert.equal(extractedQuestion.invalid, false)
assert.equal(extractedQuestion.question.responseId, 'resp-1')
assert.equal(extractedQuestion.cleanText, '请补充范围。')
assert.equal(questionCore.extractVaultQuestion('<<<AI_LINZI_ASK_USER>>>bad').invalid, true)
console.log('  ✓ ask_user 状态可安全落盘并恢复')

const obsidianMock = `
export class App {}
export class TFile {
  constructor(path, content = '') { this.path = path; this.name = path.split('/').at(-1); this.content = content; this.stat = { size: content.length, mtime: 1 } }
}
export class TFolder {
  constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = [] }
}
export class Modal { constructor(app) { this.app = app } }
export class Notice { constructor() {} }
export class Setting { constructor() {} }
export const normalizePath = (value) => value.replaceAll('\\\\', '/').replace(/^\\.\\//, '').replace(/\\/{2,}/g, '/')
`
const obsidianPlugin = {
  name: 'obsidian-test-double',
  setup(context) {
    context.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-double' }))
    context.onLoad({ filter: /.*/, namespace: 'test-double' }, () => ({ contents: obsidianMock, loader: 'js' }))
  },
}

const atomic = await importBundle({
  stdin: {
    contents: `
      export * from './src/create-local-skill-vault.ts'
      export { TFile, TFolder } from 'obsidian'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'skill-studio-atomic-test-entry.ts',
    loader: 'ts',
  },
  plugins: [obsidianPlugin],
})
const files = new Map()
const parentPath = (path) => path.split('/').slice(0, -1).join('/')
const addToParent = (item) => {
  const parent = files.get(parentPath(item.path))
  if (parent?.children && !parent.children.includes(item)) parent.children.push(item)
}
const removeFromParent = (item) => {
  const parent = files.get(parentPath(item.path))
  if (parent?.children) parent.children = parent.children.filter((child) => child !== item)
}
for (const path of ['05_System', '05_System/Skills', 'system', 'system/skills']) {
  const folder = new atomic.TFolder(path)
  files.set(path, folder)
  addToParent(folder)
}
let failPath = '05_System/Skills/demo-skill/references/template.md'
const app = {
  vault: {
    getAbstractFileByPath(path) { return files.get(path) ?? null },
    async createFolder(path) {
      const folder = new atomic.TFolder(path)
      files.set(path, folder)
      addToParent(folder)
      return folder
    },
    async create(path, content) {
      if (path === failPath) throw new Error('simulated write failure')
      const file = new atomic.TFile(path, content)
      files.set(path, file)
      addToParent(file)
      return file
    },
    async delete(item) {
      removeFromParent(item)
      files.delete(item.path)
    },
  },
  fileManager: {
    async trashFile(item) {
      removeFromParent(item)
      files.delete(item.path)
    },
  },
}
const demoBlock = {
  name: 'demo-skill',
  description: '演示原子创建',
  content: '---\nname: demo-skill\ndescription: 演示原子创建\n---\n# Demo',
  files: [
    { path: 'SKILL.md', content: '---\nname: demo-skill\ndescription: 演示原子创建\n---\n# Demo' },
    { path: 'references/template.md', content: '# Template' },
  ],
}
await assert.rejects(
  atomic.createLocalSkillBundleAtomically(app, '05_System/Skills', demoBlock),
  /本轮已自动回滚，没有留下半成品 Skill/,
)
assert.equal(files.has('05_System/Skills/demo-skill'), false)
assert.equal(files.has('05_System/Skills/demo-skill/SKILL.md'), false)
failPath = ''
const created = await atomic.createLocalSkillBundleAtomically(app, '05_System/Skills', demoBlock)
assert.equal(created.files.length, 2)
assert.ok(files.has('05_System/Skills/demo-skill/references/template.md'))
const customRootBlock = { ...demoBlock, name: 'custom-root-skill' }
const customRootCreated = await atomic.createLocalSkillBundleAtomically(
  app,
  'system/skills',
  customRootBlock,
)
assert.equal(customRootCreated.root, 'system/skills/custom-root-skill')
assert.ok(files.has('system/skills/custom-root-skill/SKILL.md'))
console.log('  ✓ Skill 文件夹原子创建与失败回滚')

const studioUi = await importBundle({
  entryPoints: ['src/skill-studio.ts'],
  plugins: [obsidianPlugin],
})
const zipBytes = zipSync({
  'round-trip-skill/SKILL.md': strToU8('---\nname: round-trip-skill\ndescription: 可往返导入导出的测试 Skill\n---\n# Round trip'),
  'round-trip-skill/references/ai-linzi-skill-manifest.json': strToU8('{"schemaVersion":1,"skillVersion":"1.0.0","permissions":["只读"],"programs":[]}'),
  // 早期候选包曾附带 INSTALL.md；导入仍兼容，新导出包不再生成多余文件。
  'round-trip-skill/INSTALL.md': strToU8('# Install'),
})
const imported = studioUi.portableBundleFromZip(zipBytes)
assert.equal(imported.name, 'round-trip-skill')
assert.equal(imported.files.some((file) => file.path === 'INSTALL.md'), false)
assert.throws(
  () => studioUi.portableBundleFromZip(zipSync({
    'bad-skill/SKILL.md': strToU8('---\nname: bad-skill\ndescription: bad\n---\n# Bad'),
    'bad-skill/.hidden': strToU8('secret'),
  })),
  /隐藏路径/,
)
console.log('  ✓ Skill ZIP 可往返导入，并拒绝隐藏路径')

const mainSource = await (await import('node:fs/promises')).readFile('src/main.ts', 'utf8')
const studioSource = await (await import('node:fs/promises')).readFile('src/skill-studio.ts', 'utf8')
assert.doesNotMatch(studioSource, /archive\[`\$\{block\.name\}\/INSTALL\.md`\]/)
assert.match(mainSource, /message\.skillCreatorResult && !manifest\.valid/)
assert.match(mainSource, /private hasPendingSkillCreatorInterview\(\): boolean \{[\s\S]*?return message\.skillCreatorPending === true/)
assert.doesNotMatch(mainSource, /hasPendingSkillCreatorInterview[\s\S]{0,600}continue[\s\S]{0,200}skillCreatorPending === true[\s\S]{0,100}continue/)
assert.match(mainSource, /let localSkillMatch = skillCreatorTurn\s*\? \{ kind: 'none' as const \}\s*: await this\.localSkills\.resolve/)
assert.match(
  mainSource,
  /const currentRoot = this\.localSkills\.root\(\)[\s\S]{0,180}currentRoot !== root[\s\S]{0,260}this\.renderMessages\(\)/,
)
assert.match(
  mainSource,
  /const skillCreatorTurn =\s*!pendingVaultQuestion\s*&&[\s\S]{0,220}isExplicitLocalSkillCreationIntent\(text\)/,
)
assert.match(mainSource, /input\.localSkill\?\.output === 'create-note'[\s\S]{0,220}extractCreateNoteBlocks\(lastText\)\.blocks\.length > 0[\s\S]{0,80}!plan\.plan/)
assert.match(mainSource, /answerPlan\.plan && extractCreateNoteBlocks\(answer\)\.blocks\.length > 0/)
assert.match(mainSource, /Boolean\(input\.resumeQuestion\)[\s\S]{0,280}vaultWriteFlowRetryReason/)
assert.match(
  mainSource,
  /pendingVaultQuestion \|\| localSkill\?\.output === 'create-note'[\s\S]{0,120}\? 'organize'/,
)
assert.match(mainSource, /let stalledRetries = 0/)
assert.match(mainSource, /stalledRetries < 2/)
assert.match(mainSource, /stalledRetries \+= 1/)
assert.match(
  mainSource,
  /noReadRequiredCreationPlan[\s\S]{0,260}operation\.type === 'create_note'[\s\S]{0,160}operation\.type === 'create_folder'[\s\S]{0,160}operation\.type === 'create_artifact'/,
)
assert.match(
  mainSource,
  /toolResults\.length === 0[\s\S]{0,80}!noReadRequiredCreationPlan/,
)
assert.match(
  mainSource,
  /isVaultNativeTurnRequest\(lastText\)[\s\S]{0,360}intent = 'organize'[\s\S]{0,120}runNativeChannel\(\)/,
)
console.log('  ✓ Skill Creator 完成后不会被历史待访谈状态劫持')
console.log('  ✓ Skill Creator 专用提示不会被误判为本地 Skill 调用')
console.log('  ✓ create-note Skill 强制进入预览确认流程')
console.log('  ✓ create-note 兼容协议是安全循环的合法终态')

console.log('[test-skill-studio] 全部通过')

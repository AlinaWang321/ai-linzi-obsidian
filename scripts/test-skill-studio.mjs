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

assert.equal(studioCore.OFFICIAL_SKILL_TEMPLATES.length, 2)
for (const template of studioCore.OFFICIAL_SKILL_TEMPLATES) {
  const protocol = template.block.files
    .map((file) => `<<<Skill文件 path=${file.path}>>>\n${file.content}\n<<<Skill文件结束>>>`)
    .join('\n')
  const parsed = skillParser.parsePortableSkillBundle(template.block.name, protocol)
  assert.ok(parsed, `${template.id} 应是可移植 Skill 包`)
  const manifest = JSON.parse(
    template.block.files.find((file) => file.path === 'references/ai-linzi-skill-manifest.json').content,
  )
  assert.equal(manifest.skillVersion, '1.1.0')
  assert.equal(manifest.createdWith, 'AI霖子 Skill Studio')
  assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.length > 0)
  assert.deepEqual(manifest.programs, [])
  assert.deepEqual(manifest.sampleInputs, [template.sampleInput])
  assert.equal(template.block.files.some((file) => file.path.startsWith('scripts/')), false)
  assert.match(template.block.content, /^description: .+$/m)
  assert.match(template.block.content, /references\/ai-linzi-skill-manifest\.json/)
  assert.equal(
    localSkillCore.localSkillOutputFromMarkdown(template.block.content),
    template.id === 'weekly-business-dashboard' ? 'create-artifact' : 'create-note',
  )
  assert.equal(studioCore.skillBlockManifest(template.block).valid, true)
  for (const file of template.block.files.filter(
    (item) => item.path.startsWith('references/') && !item.path.endsWith('ai-linzi-skill-manifest.json'),
  )) {
    assert.ok(template.block.content.includes(file.path), `${template.id} 必须在 SKILL.md 指向 ${file.path}`)
  }
}
const consultation = studioCore.OFFICIAL_SKILL_TEMPLATES.find(
  (item) => item.id === 'consultation-client-workflow',
)
assert.match(consultation.block.content, /模板优先级/)
assert.match(consultation.block.content, /AI霖子 CRM/)
assert.match(consultation.block.content, /客户咨询简报/)
assert.match(consultation.block.content, /普通文字“继续”不能代替这次文件写入确认/)
assert.match(consultation.block.content, /不得把确认客户档案的一次操作同时解释为确认 CRM/)
assert.match(consultation.block.content, /不得把客户档案写进模板目录/)
assert.match(consultation.block.content, /必须再用 list_folder 真实列出候选父目录/)
assert.match(consultation.block.content, /客户档案保存到哪个 Vault 文件夹/)
const consultationDescriptor = localSkillCore.buildLocalSkillDescriptor(
  '05_System/Skills/consultation-client-workflow/SKILL.md',
  { name: consultation.block.name },
  consultation.block.content,
)
assert.equal(
  localSkillCore.matchLocalSkillInvocation(
    '用咨询交付闭环处理当前打开的咨询文档',
    [consultationDescriptor],
    { allowAutomatic: true },
  ).kind,
  'matched',
)
assert.equal(
  localSkillCore.matchLocalSkillInvocation(
    '咨询交付闭环这个 Skill 为什么要这样设计？',
    [consultationDescriptor],
    { allowAutomatic: true },
  ).kind,
  'none',
)
const weeklyDashboard = studioCore.OFFICIAL_SKILL_TEMPLATES.find(
  (item) => item.id === 'weekly-business-dashboard',
)
const weeklyDescriptor = localSkillCore.buildLocalSkillDescriptor(
  '05_System/Skills/weekly-business-dashboard/SKILL.md',
  { name: weeklyDashboard.block.name },
  weeklyDashboard.block.content,
)
const weeklySampleMatch = localSkillCore.matchLocalSkillInvocation(
  weeklyDashboard.sampleInput,
  [weeklyDescriptor],
  { allowAutomatic: true },
)
assert.equal(weeklySampleMatch.kind, 'matched')
assert.equal(weeklySampleMatch.automatic, true, '经营周报推荐示例必须逐字命中自动触发短语')
assert.equal(
  studioCore.previewSkillInvocation(weeklyDashboard.block, weeklyDashboard.sampleInput).kind,
  'automatic',
)
assert.equal(
  studioCore.previewSkillInvocation(consultation.block, consultation.sampleInput).kind,
  'explicit',
  '咨询闭环示例不是自动短语，但“用 + 名称”应如实显示为显式命中',
)
assert.equal(
  studioCore.previewSkillInvocation(consultation.block, '请分析一下今天的材料').kind,
  'missing',
)
assert.match(
  studioCore.skillInvocationPreviewText({ kind: 'missing', input: '测试句' }),
  /点“立即试运行”也调不起这个 Skill/,
)
const previewDraft = {
  name: 'client-follow-up',
  purpose: '整理客户跟进',
  input: '当前笔记',
  steps: '提炼事实',
  triggers: ['生成客户跟进行动清单'],
  output: 'create-note',
  sampleInput: '生成客户跟进行动清单',
  version: '1.0.0',
}
assert.equal(studioCore.previewSkillStudioDraftInvocation(previewDraft).kind, 'automatic')
assert.equal(
  studioCore.previewSkillStudioDraftInvocation({
    ...previewDraft,
    sampleInput: '用 client-follow-up Skill 处理当前笔记',
  }).kind,
  'explicit',
)
assert.equal(
  studioCore.previewSkillStudioDraftInvocation({
    ...previewDraft,
    sampleInput: '整理一下今天的材料',
  }).kind,
  'missing',
)
assert.equal(
  studioCore.previewSkillStudioDraftInvocation({ ...previewDraft, sampleInput: '' }).kind,
  'explicit',
  '空示例应与确认卡一致，检查最终会填入的默认点名句',
)
assert.match(weeklyDashboard.block.content, /read_recent_documents/)
assert.match(weeklyDashboard.block.content, /\$OUTPUT\/经营周报/)
assert.match(weeklyDashboard.block.content, /固定文件快照/)
assert.match(weeklyDashboard.block.content, /同一 snapshotId/)
assert.match(weeklyDashboard.block.content, /不得改称 03_Dashboard/)
assert.match(weeklyDashboard.block.content, /不得按扩展名笼统宣称“PDF 不可读”/)
assert.match(weeklyDashboard.block.content, /layout=dashboard/)
assert.match(weeklyDashboard.block.content, /追完文件分页和长文字符分页/)
console.log('  ✓ 2 个真实业务官方模板可移植、权限透明、引用可达且不含脚本')

assert.equal(studioCore.isExplicitLocalSkillCreationIntent('帮我创建一个客户跟进 Skill'), true)
assert.equal(studioCore.isExplicitLocalSkillCreationIntent('Skill 是什么？'), false)
assert.equal(studioCore.isExplicitLocalSkillCreationIntent('列出我的 Skills'), false)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(
    '调用 weekly-business-dashboard Skill，生成本周经营周报交互看板。',
  ),
  false,
  '运行现有 Skill 并生成业务产物时不能误入 Skill Creator',
)
assert.equal(
  studioCore.isExplicitLocalSkillRunIntent(
    '调用 weekly-business-dashboard Skill，生成本周经营周报交互看板。',
  ),
  true,
)
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
assert.match(prompt, /"skillVersion":"1\.0\.0"/)
assert.match(prompt, /绝不能写成 \{"major":1,"minor":0,"patch":0\} 对象/)
assert.equal(
  localSkillCore.localSkillForbidsVaultExpansion(`
    本 Skill 只接受一份由用户明确打开的咨询逐字稿作为输入。
    不主动扫描其他文件，不读取未指定文件。
  `),
  true,
)
assert.equal(
  localSkillCore.localSkillForbidsVaultExpansion('读取最近 7 天内修改的所有文档'),
  false,
)
const scopedInputFiles = [
  '01_Raw/销售逐字稿/20260813193042-顾晓菲英语老师1v1商业咨询-逐字稿文本-1.txt',
  '01_Raw/销售逐字稿/20260817150019-沈立冬家庭教育咨询师1v1商业咨询-逐字稿文本-1.md',
  '04_Output/AI霖子输出/销售复盘/2026.08.19_谈单复盘_沈立冬.md',
]
const scopedBindings = {
  rawRoot: '01_Raw',
  wikiRoot: '02_Wiki',
  outputRoot: '04_Output/AI霖子输出',
}
assert.deepEqual(
  localSkillCore.resolveLocalSkillScopedInput(
    '用 jingyancuiqu Skill 处理 Raw//销售逐字稿/沈立冬的咨询逐字稿',
    scopedInputFiles,
    scopedBindings,
  ),
  {
    status: 'locked',
    path: '01_Raw/销售逐字稿/20260817150019-沈立冬家庭教育咨询师1v1商业咨询-逐字稿文本-1.md',
  },
)
assert.equal(
  localSkillCore.resolveLocalSkillScopedInput(
    '处理 Raw/销售逐字稿/20260813193042-顾晓菲英语老师1v1商业咨询-逐字稿文本-1.txt',
    scopedInputFiles,
    scopedBindings,
  ).status,
  'locked',
)
assert.equal(
  localSkillCore.resolveLocalSkillScopedInput(
    '用经验萃取处理 Raw/销售逐字稿 里的咨询逐字稿',
    scopedInputFiles,
    scopedBindings,
  ).status,
  'ambiguous',
)
assert.equal(localSkillCore.localSkillQuestionNamesInputFile('处理 Raw//销售逐字稿/沈立冬的咨询逐字稿'), true)
assert.equal(localSkillCore.localSkillQuestionNamesInputFile(`处理下面粘贴的正文：${'正文'.repeat(500)}`), false)
console.log('  ✓ 受限 Skill 只按路径元数据唯一锁定一份文件，不扩大正文读取范围')
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
assert.match(prompt, /原始素材用 \$RAW\//)
assert.match(prompt, /知识库用 \$WIKI\//)
assert.match(prompt, /AI 产出用 \$OUTPUT\//)
console.log('  ✓ 创建意图与 Skill Studio 结构化提示词')

const generatedWithObjectVersion = {
  ...consultation.block,
  files: consultation.block.files.map((file) =>
    file.path === 'references/ai-linzi-skill-manifest.json'
      ? {
          ...file,
          content: JSON.stringify({
            ...JSON.parse(file.content),
            skillVersion: { major: 1, minor: 2, patch: 3 },
          }),
        }
      : file,
  ),
}
assert.equal(studioCore.skillBlockManifest(generatedWithObjectVersion).valid, false)
const normalizedGenerated = studioCore.normalizeGeneratedSkillManifest(generatedWithObjectVersion)
assert.equal(studioCore.skillBlockManifest(normalizedGenerated.block).valid, true)
assert.deepEqual(normalizedGenerated.repairs, ['已把 skillVersion 自动规范为 1.2.3'])
const generatedWithoutSampleInput = {
  ...consultation.block,
  files: consultation.block.files.map((file) =>
    file.path === 'references/ai-linzi-skill-manifest.json'
      ? {
          ...file,
          content: JSON.stringify({
            ...JSON.parse(file.content),
            sampleInputs: [],
          }),
        }
      : file,
  ),
}
assert.equal(studioCore.skillBlockManifest(generatedWithoutSampleInput).valid, false)
const normalizedSampleInput = studioCore.normalizeGeneratedSkillManifest(generatedWithoutSampleInput)
assert.equal(studioCore.skillBlockManifest(normalizedSampleInput.block).valid, true)
assert.deepEqual(
  JSON.parse(
    normalizedSampleInput.block.files.find(
      (file) => file.path === 'references/ai-linzi-skill-manifest.json',
    ).content,
  ).sampleInputs,
  ['用 consultation-client-workflow 处理当前打开的材料'],
)
assert.deepEqual(normalizedSampleInput.repairs, [
  '已补充试运行输入：用 consultation-client-workflow 处理当前打开的材料',
])
const generatedWithoutOutput = {
  ...generatedWithoutSampleInput,
  content: generatedWithoutSampleInput.content.replace(
    /\n## AI霖子输出方式\ncreate-note\s*$/u,
    '',
  ),
}
generatedWithoutOutput.files = generatedWithoutOutput.files.map((file) =>
  file.path === 'SKILL.md'
    ? { ...file, content: generatedWithoutOutput.content }
    : file,
)
const normalizedOutput = studioCore.normalizeGeneratedSkillManifest(generatedWithoutOutput)
assert.match(normalizedOutput.block.content, /## AI霖子输出方式\ncreate-note$/u)
assert.ok(normalizedOutput.repairs.includes('已补充输出方式：create-note'))
const generatedWithNarrativeOutput = {
  ...generatedWithoutSampleInput,
  content: generatedWithoutSampleInput.content.replace(
    /\n## AI霖子输出方式\ncreate-note\s*$/u,
    '\n## 输出方式\n默认先在对话中展示预览，确认后再保存。',
  ),
}
generatedWithNarrativeOutput.files = generatedWithNarrativeOutput.files.map((file) =>
  file.path === 'SKILL.md'
    ? { ...file, content: generatedWithNarrativeOutput.content }
    : file,
)
const normalizedNarrativeOutput = studioCore.normalizeGeneratedSkillManifest(
  generatedWithNarrativeOutput,
)
assert.match(normalizedNarrativeOutput.block.content, /## AI霖子输出方式\ncreate-note$/u)
assert.ok(normalizedNarrativeOutput.repairs.includes('已补充输出方式：create-note'))

const generatedWithInlineOutputAndNegativeHtml = {
  ...generatedWithoutSampleInput,
  description: '把当前笔记变成七天行动计划',
  content: generatedWithoutSampleInput.content.replace(
    /\n## AI霖子输出方式\ncreate-note\s*$/u,
    '\n## 输出格式\n输出方式为 `create-note`。\n\n本 Skill 不会生成 HTML、DOCX、PDF 或 PPTX。',
  ),
}
generatedWithInlineOutputAndNegativeHtml.files = generatedWithInlineOutputAndNegativeHtml.files.map(
  (file) =>
    file.path === 'SKILL.md'
      ? { ...file, content: generatedWithInlineOutputAndNegativeHtml.content }
      : file,
)
const normalizedInlineOutputAndNegativeHtml = studioCore.normalizeGeneratedSkillManifest(
  generatedWithInlineOutputAndNegativeHtml,
)
assert.match(
  normalizedInlineOutputAndNegativeHtml.block.content,
  /## AI霖子输出方式\ncreate-note$/u,
)
assert.ok(
  normalizedInlineOutputAndNegativeHtml.repairs.includes('已补充输出方式：create-note'),
)
console.log('  ✓ 常见的对象版 skillVersion 与空试运行输入会在本机确定性修正')

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
// 0.7.72 步 1：确认卡渲染已从 main.ts 抽到 create-local-skill-card.ts。
// 断言随代码一起搬到新文件，强度不变。
const cardSource = await (await import('node:fs/promises')).readFile(
  'src/create-local-skill-card.ts',
  'utf8',
)
assert.doesNotMatch(studioSource, /archive\[`\$\{block\.name\}\/INSTALL\.md`\]/)
assert.match(studioSource, /自动识别的调用说法/)
assert.match(studioSource, /创建后测试示例/)
assert.doesNotMatch(studioSource, /\.setName\('课堂试运行输入'\)/)
assert.match(studioSource, /refreshTemplatePreview\(\)/)
assert.match(studioSource, /refreshDraftPreview\(\)/)
assert.match(studioSource, /previewSkillInvocation\(template\.block, templateSampleInput \|\| template\.sampleInput\)/)
assert.match(studioSource, /previewSkillStudioDraftInvocation\(this\.draft\)/)
// 「Skill Creator 产出的非法包不得给创建按钮」这条守卫，现由
// scripts/test-create-local-skill-card.mjs 第 3 组**真跑分支**验证
// （断言非法包时按钮总数为 0）。这里保留源码断言作为搬迁后的位置守卫，
// 防止有人把这段判断整体删掉。
assert.match(cardSource, /message\.skillCreatorResult && !manifest\.valid/)
assert.doesNotMatch(
  mainSource,
  /message\.skillCreatorResult && !manifest\.valid/,
  '确认卡渲染已抽出，main.ts 不应再持有这段判断（避免两处实现漂移）',
)
assert.match(mainSource, /private hasPendingSkillCreatorInterview\(\): boolean \{[\s\S]*?return message\.skillCreatorPending === true/)
assert.doesNotMatch(mainSource, /hasPendingSkillCreatorInterview[\s\S]{0,600}continue[\s\S]{0,200}skillCreatorPending === true[\s\S]{0,100}continue/)
assert.match(
  mainSource,
  /let localSkillMatch = skillCreatorTurn \|\| consultationWorkflowTaskTurn\s*\? \{ kind: 'none' as const \}[\s\S]{0,180}explicitInstalledLocalSkill[\s\S]{0,120}explicitLocalSkillMatch[\s\S]{0,120}this\.localSkills\.resolve/,
)
assert.match(mainSource, /localSkillForbidsVaultExpansion\(localSkill\.fullContent\)/)
assert.match(
  mainSource,
  /uploadedSpreadsheetAttachments\.length === 0 &&\s*!localSkillCurrentOnly/,
)
assert.match(mainSource, /scopedLocalSkillInputContext\(text, localSkill\.name\)/)
assert.match(mainSource, /localSkillCurrentOnly\s*\?\s*undefined\s*:\s*await this\.authorizedContentContext/)
assert.match(
  mainSource,
  /nativeEligible &&\s*round === 0[\s\S]{0,180}isVaultNativeTurnRequest\(lastText\)/,
)
assert.match(
  mainSource,
  /!nativeEligible && isVaultNativeTurnRequest\(lastText\)[\s\S]{0,260}pendingRetryReason = 'missing_tool_use'/,
)
assert.match(mainSource, /consultationWorkflowTaskOriginId: message\.id/)
assert.match(mainSource, /consultationWorkflowTaskTurn \|\| localSkill\?\.name === CONSULTATION_WORKFLOW_SKILL_NAME/)
assert.match(mainSource, /forceCloudToolsTurn: consultationWorkflowTaskTurn/)
assert.match(mainSource, /if \(round === 0 && input\.forceCloudToolsTurn\)/)
assert.match(mainSource, /successfulWriteTools\.includes\('addTask'\)/)
assert.match(
  mainSource,
  /if \(!skillCreatorTurn && isFullCurrentNoteReplaceIntent\(text\)\)/,
  'Skill Studio 提示里的“不覆盖”不能误触发当前笔记整篇替换',
)
assert.match(
  mainSource,
  /input\.localSkill\?\.name === WEEKLY_BUSINESS_DASHBOARD_SKILL_NAME[\s\S]{0,500}id: 'weekly-dashboard-preload'[\s\S]{0,300}name: 'read_recent_documents'/,
  '官方经营周报必须由本机预读最近文档，不能等待模型自行决定是否扫描',
)
assert.match(
  cardSource,
  // 同上：已随渲染一起搬到 create-local-skill-card.ts，宿主能力改为回调注入。
  // 「目录中途变化必须中止写入并重绘」这条由 test-create-local-skill-card.mjs
  // 第 7 组真跑验证（断言 created.length === 0 且 rerendered === 1）。
  /const currentRoot = host\.skillsRoot\(\)[\s\S]{0,180}currentRoot !== root[\s\S]{0,260}host\.rerender\(\)/,
)
assert.match(
  mainSource,
  /const skillCreatorTurn =\s*!pendingVaultQuestion\s*&&[\s\S]{0,220}isExplicitLocalSkillCreationIntent\(text\)/,
)
assert.match(
  mainSource,
  /const explicitLocalSkillRun = isExplicitLocalSkillRunIntent\(text\)[\s\S]{0,500}const explicitInstalledLocalSkill = explicitLocalSkillMatch\?\.kind === 'matched'[\s\S]{0,350}options\.skillCreator === true[\s\S]{0,120}!explicitLocalSkillRun/,
  '显式运行已安装 Skill 时必须退出历史 Skill Creator 访谈状态',
)
assert.match(
  mainSource,
  /explicitInstalledLocalSkill\s*\? explicitLocalSkillMatch\s*: await this\.localSkills\.resolve\(text, \{ allowAutomatic: true \}\)/,
  '已在本机解析到的 Skill 运行意图必须复用同一匹配结果',
)
assert.match(mainSource, /input\.localSkill\?\.output === 'create-note'[\s\S]{0,220}extractCreateNoteBlocks\(lastText\)\.blocks\.length > 0[\s\S]{0,80}!plan\.plan/)
assert.match(mainSource, /answerPlan\.plan && extractCreateNoteBlocks\(answer\)\.blocks\.length > 0/)
assert.match(mainSource, /Boolean\(input\.resumeQuestion\)[\s\S]{0,280}vaultWriteFlowRetryReason/)
assert.match(
  mainSource,
  /pendingVaultQuestion \|\|[\s\S]{0,100}localSkill\?\.output === 'create-note'[\s\S]{0,100}localSkill\?\.output === 'create-artifact'[\s\S]{0,80}\? 'organize'/,
)
assert.match(studioSource, /addOption\('create-artifact'/)
assert.match(mainSource, /let stalledRetries = 0/)
assert.match(mainSource, /stalledRetries < 2/)
assert.match(mainSource, /stalledRetries \+= 1/)
assert.match(
  mainSource,
  /const structuredStall = vaultWriteFlowRetryReason[\s\S]{0,260}structuredStall \?\?[\s\S]{0,120}hasPreloadedCreateSkillEvidence \? 'deferred_answer'/,
)
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

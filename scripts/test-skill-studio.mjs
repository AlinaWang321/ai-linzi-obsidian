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
  assert.equal(
    manifest.vaultRead.scope,
    'whole-vault',
    `${template.id} 必须默认获得插件级整个 Vault 读取能力`,
  )
  assert.equal(
    manifest.vaultRead.metadataDiscovery,
    true,
    `${template.id} 必须能用本机目录和索引先筛选候选`,
  )
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
const officialContextModes = Object.fromEntries(
  studioCore.OFFICIAL_SKILL_TEMPLATES.map((template) => {
    const manifest = JSON.parse(
      template.block.files.find((file) =>
        file.path === 'references/ai-linzi-skill-manifest.json'
      ).content,
    )
    return [template.id, manifest.context?.mode]
  }),
)
assert.deepEqual(officialContextModes, {
  'consultation-client-workflow': 'source-only',
  'weekly-business-dashboard': 'vault-data',
})
const consultation = studioCore.OFFICIAL_SKILL_TEMPLATES.find(
  (item) => item.id === 'consultation-client-workflow',
)
assert.match(consultation.block.content, /保存位置与模板/)
assert.match(consultation.block.content, /AI霖子 CRM/)
assert.match(consultation.block.content, /客户咨询简报/)
assert.match(consultation.block.content, /普通文字“继续”不能代替这次文件写入确认/)
assert.match(consultation.block.content, /不得把确认客户档案的一次操作同时解释为确认 CRM/)
assert.match(consultation.block.content, /必须再用 list_folder 真实列出候选父目录/)
assert.match(consultation.block.content, /客户档案保存到哪个 Vault 文件夹/)
assert.match(consultation.block.content, /默认可按需搜索整个 Vault/)
assert.match(consultation.block.content, /不得把整个 Vault 正文一次性提交给 AI/)
assert.match(consultation.block.content, /不读取其他客户档案正文来模仿格式/)
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
assert.match(weeklyDashboard.block.content, /Map → Reduce/)
assert.match(weeklyDashboard.block.content, /\$OUTPUT\/经营周报/)
assert.match(weeklyDashboard.block.content, /固定文件清单/)
assert.match(weeklyDashboard.block.content, /IndexedDB/)
assert.match(weeklyDashboard.block.content, /不保存原始正文/)
assert.match(weeklyDashboard.block.content, /complete=false/)
assert.match(weeklyDashboard.block.content, /不得改称 03_Dashboard/)
assert.match(weeklyDashboard.block.content, /不得按扩展名笼统宣称“PDF 不可读”/)
assert.match(weeklyDashboard.block.content, /layout=dashboard/)
assert.match(weeklyDashboard.block.content, /从尚未完成的文件\/分段继续/)
console.log('  ✓ 2 个真实业务官方模板可移植、权限透明、引用可达且不含脚本')

assert.equal(studioCore.isExplicitLocalSkillCreationIntent('帮我创建一个客户跟进 Skill'), true)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(
    '以后收到访谈记录都按这套步骤复盘，请把这套做法保存成可重复使用的工作流，英文名 interview-review。',
  ),
  true,
  '自然表达“保存成可重复使用的工作流”必须进入 Skill Creator，不要求背创建 Skill 口令',
)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(
    '把每天读取一篇日记并生成复盘固定成以后可以反复使用的工作流，英文名 codex-daily-reflection。',
  ),
  true,
  '自然表达“固定成以后反复使用的工作流”同样必须进入 Skill Creator',
)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(
    '请把我前几天跑通的“客户咨询逐字稿交付流程”做成一个新的 Skill。输入里会更新现有客户档案。',
  ),
  true,
  '创建 Skill 的正文即使描述“更新客户档案”，整句仍必须判定为新建',
)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(
    '把我每次给学员做咨询的方法论和流程提炼成一个 Skill。',
  ),
  true,
  '自然表达“提炼成 Skill”必须进入新建流程',
)
const realSkillPromptUpdateRequest =
  'b2c-1v1-consultation，这个技能调用后的提示词是否可以修改。我的业务场景是，需要选中一个客户问卷，然后调用这个技能生成一份咨询方案。'
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(realSkillPromptUpdateRequest),
  false,
  'Skill 生成的是业务产物时，不能把“生成咨询方案”误判成“生成 Skill”',
)
assert.equal(
  studioCore.classifyLocalSkillManagementIntent(realSkillPromptUpdateRequest),
  'update',
  '真实截图原句必须直接进入已安装 Skill 更新器',
)
assert.equal(
  studioCore.classifyLocalSkillManagementIntent(
    '请创建一个新的 b2c-consultation Skill，同时修改现有的 b2c-1v1-consultation Skill 提示词。',
  ),
  'ambiguous',
  '同一句真的同时要求新建与修改时必须先向用户核对',
)
assert.equal(
  studioCore.classifyLocalSkillManagementIntent('修改已有 Skill'),
  'update',
  '用户回答澄清问题后必须继续走已有 Skill 更新',
)
assert.equal(
  studioCore.classifyLocalSkillManagementIntent('创建新的 Skill'),
  'create',
  '用户回答澄清问题后必须能退出旧更新上下文并新建 Skill',
)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent('在这个 Skill 里创建一个 references 说明文件。'),
  false,
  '修改现有 Skill 内部文件不能被反向词序误判为新建 Skill',
)
assert.equal(studioCore.isExplicitLocalSkillCreationIntent('Skill 是什么？'), false)
assert.equal(studioCore.isExplicitLocalSkillCreationIntent('列出我的 Skills'), false)
assert.equal(
  studioCore.isExplicitLocalSkillCreationIntent(
    '我把自己做短视频的5套Skill，全部开源了，标题改成这个。其他按照你的建议修改',
  ),
  false,
  '文章标题里回顾自己做过的 Skill 不能误入 Skill Creator',
)
assert.equal(
  studioCore.isExplicitSkillCreatorExitIntent('让你直接修改这篇文章'),
  true,
  '用户明确拉回文章任务时必须退出上一轮 pending Skill Creator',
)
assert.equal(
  studioCore.isExplicitSkillCreatorExitIntent('不是创建 Skill，直接修改当前文章'),
  true,
)
assert.equal(
  studioCore.isExplicitSkillCreatorExitIntent('继续补充这个 Skill 的输入说明'),
  false,
  '普通 Skill 访谈补充不能被误判为退出',
)
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
assert.equal(
  localSkillCore.localSkillForbidsVaultExpansion(`
    只读取用户明确指定的 Vault 文件夹。
    不得扫描其他文件夹或整个知识库。
  `),
  false,
  '“文件夹”不能因为包含“文件”二字而被误判为单篇输入锁定',
)
assert.equal(
  localSkillCore.localSkillForbidsVaultExpansion(`
    支持用户指定的 Vault 文件夹路径、一个或多个笔记名称。
    优先读取用户明确指定的 Vault 文件夹。
    只读取完成当前任务所必需的文件内容。
    对候选材料记录来源路径、标题和必要的上下文，不擅自扩大读取范围。
    读取范围不扩大：优先使用指定范围，仅在指定范围缺少材料时才搜索整个 Vault。
  `),
  false,
  '“只读任务所需内容 + 找不到搜整库”是最小必要读取，不是单文件锁定',
)
assert.equal(
  localSkillCore.localSkillForbidsVaultExpansion(`
    本 Skill 只读取当前打开的笔记。
    不得搜索其他文件或整个 Vault。
  `),
  true,
  '明确的当前单笔记合同仍必须失败关闭',
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
assert.equal(
  localSkillCore.localSkillQuestionNamesConcreteInputFile('不要读取任何业务文件，只读取 Skill/create-project'),
  false,
  'Skill 内部斜杠不能冒充文章输入路径',
)
assert.equal(
  localSkillCore.localSkillQuestionNamesConcreteInputFile('不要读取当前笔记，只读取 Output/课堂演示/文章.md'),
  true,
  '排除当前笔记后仍允许用户点名另一份准确输入',
)
console.log('  ✓ 点名文件仍能唯一锁定为主要输入，但不再阻断整个 Vault 的按需检索')
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
assert.match(broadScopePrompt, /默认可按需搜索和读取整个 Vault；优先使用用户指定的文件或文件夹/)
assert.match(broadScopePrompt, /优先范围没有所需材料时，继续搜索整个 Vault 中的任务相关候选/)
assert.match(broadScopePrompt, /不得把整个 Vault 的正文一次性提交给模型/)
const folderScopePrompt = studioCore.buildSkillStudioPrompt({
  name: 'folder-review',
  purpose: '处理指定文件夹内的一组材料',
  input: '用户运行时明确指定的一个仓库（Vault）文件夹',
  steps: '确认文件类型\n读取文件夹内材料\n生成汇总',
  triggers: ['汇总指定文件夹'],
  output: 'create-note',
  sampleInput: '用 folder-review Skill 汇总我指定的文件夹',
  version: '1.0.0',
})
assert.match(folderScopePrompt, /默认可按需搜索和读取整个 Vault；优先使用用户指定的文件或文件夹/)
assert.match(folderScopePrompt, /继续搜索整个 Vault 中的任务相关候选/)
assert.match(folderScopePrompt, /不得把整个 Vault 的正文一次性提交给模型/)
const fallbackVaultPrompt = studioCore.buildSkillStudioPrompt({
  name: 'vault-fallback-review',
  purpose: '在仓库中找到任务材料并汇总',
  input: '优先使用用户指定的仓库（Vault）文件夹；未指定或该文件夹没找到所需材料时，可搜索整个 Vault',
  steps: '查找候选\n读取相关材料\n生成汇总',
  triggers: ['搜索仓库并汇总'],
  output: 'create-note',
  sampleInput: '用 vault-fallback-review Skill 汇总相关材料',
  version: '1.0.0',
})
assert.match(fallbackVaultPrompt, /默认可按需搜索和读取整个 Vault；优先使用用户指定的文件或文件夹/)
assert.match(fallbackVaultPrompt, /继续搜索整个 Vault 中的任务相关候选/)
const explicitSingleNotePrompt = studioCore.buildSkillStudioPrompt({
  name: 'single-note-review',
  purpose: '只处理一篇笔记',
  readScope: 'current-note',
  input: '业务说明里即使提到整个知识库，也不能靠文字扩大权限',
  steps: '读取当前笔记\n生成摘要',
  triggers: ['总结当前笔记'],
  output: 'chat',
  sampleInput: '用 single-note-review Skill 总结当前笔记',
  version: '1.0.0',
})
assert.match(explicitSingleNotePrompt, /"scope":"whole-vault"/)
assert.match(explicitSingleNotePrompt, /默认可按需搜索和读取整个 Vault/)
assert.match(explicitSingleNotePrompt, /不包含电脑其他目录/)
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

const generatedWithIncompleteV2Manifest = {
  ...consultation.block,
  files: consultation.block.files.map((file) =>
    file.path === 'references/ai-linzi-skill-manifest.json'
      ? {
          ...file,
          content: JSON.stringify({
            schemaVersion: 2,
            skillVersion: '1.0.0',
            createdWith: 'AI霖子 Skill Studio',
            permissions: [],
            programs: [],
            sampleInputs: ['用 consultation-client-workflow 处理咨询材料'],
          }),
        }
      : file,
  ),
}
assert.equal(studioCore.skillBlockManifest(generatedWithIncompleteV2Manifest).valid, false)
const repairedIncompleteV2 = studioCore.normalizeGeneratedSkillManifest(generatedWithIncompleteV2Manifest)
const repairedIncompleteManifest = JSON.parse(repairedIncompleteV2.block.files.find(
  (file) => file.path === 'references/ai-linzi-skill-manifest.json',
).content)
assert.equal(studioCore.skillBlockManifest(repairedIncompleteV2.block).valid, true)
assert.deepEqual(repairedIncompleteManifest.vaultRead, {
  scope: 'whole-vault',
  metadataDiscovery: true,
  preferUserScope: true,
  fallbackToWholeVault: true,
  maxFiles: 120,
})
assert.deepEqual(repairedIncompleteManifest.vaultWrite, {
  mode: 'create-note',
  confirmation: 'single-atomic-plan',
  overwrite: false,
})
assert.ok(repairedIncompleteManifest.permissions.some((item) => /整个 Vault/u.test(item)))
assert.equal(repairedIncompleteManifest.network, 'ai-linzi-only')
assert.ok(repairedIncompleteV2.repairs.includes('已把读取权限统一为按需搜索整个 Vault'))
assert.ok(repairedIncompleteV2.repairs.includes('已按 SKILL.md 补充写入权限：create-note'))
assert.ok(repairedIncompleteV2.repairs.includes('已补充可展示的权限清单'))

const legacySingleNoteWithGenericPermission = {
  ...consultation.block,
  files: consultation.block.files.map((file) =>
    file.path === 'references/ai-linzi-skill-manifest.json'
      ? {
          ...file,
          content: JSON.stringify({
            schemaVersion: 1,
            skillVersion: '1.1.0',
            createdWith: 'AI霖子 Skill Studio',
            permissions: ['只读取用户明确指定的输入', '确认后只新建 Markdown，不覆盖'],
            programs: [],
            sampleInputs: ['用 consultation-client-workflow Skill 处理当前笔记'],
          }),
        }
      : file,
  ),
}
const normalizedLegacySingleNote = studioCore.normalizeGeneratedSkillManifest(
  legacySingleNoteWithGenericPermission,
)
assert.equal(
  JSON.parse(normalizedLegacySingleNote.block.files.find(
    (file) => file.path === 'references/ai-linzi-skill-manifest.json',
  ).content).vaultRead.scope,
  'whole-vault',
  '旧 manifest 的单篇声明只保留为主要输入，不再阻断插件级 Vault 读取能力',
)

const generatedWithUnlinkedReference = {
  ...consultation.block,
  files: [
    ...consultation.block.files,
    { path: 'references/test-cases.md', content: '# 测试用例\n\n- 输入一篇材料。' },
  ],
}
assert.equal(studioCore.skillBlockManifest(generatedWithUnlinkedReference).valid, false)
const normalizedReferenceLinks = studioCore.normalizeGeneratedSkillManifest(
  generatedWithUnlinkedReference,
)
assert.equal(studioCore.skillBlockManifest(normalizedReferenceLinks.block).valid, true)
assert.match(
  normalizedReferenceLinks.block.content,
  /\[test-cases\.md\]\(references\/test-cases\.md\)/u,
)
assert.ok(normalizedReferenceLinks.repairs.includes('已补充 1 个遗漏的 reference 链接'))

const importedWithoutManifest = {
  name: 'external-note-method',
  description: '把当前材料沉淀为一份方法论笔记',
  content: `---
name: external-note-method
description: 把当前材料沉淀为一份方法论笔记
---
# External note method

将结果新建到 wiki/方法论与框架/。

## AI霖子输出方式
create-note`,
  files: [{
    path: 'SKILL.md',
    content: `---
name: external-note-method
description: 把当前材料沉淀为一份方法论笔记
---
# External note method

将结果新建到 wiki/方法论与框架/。

## AI霖子输出方式
create-note`,
  }],
}
assert.equal(studioCore.skillBlockManifest(importedWithoutManifest).valid, false)
const adaptedExternal = studioCore.normalizeGeneratedSkillManifest(importedWithoutManifest)
assert.equal(studioCore.skillBlockManifest(adaptedExternal.block).valid, true)
assert.match(adaptedExternal.block.content, /\$WIKI\/方法论与框架\//u)
assert.match(adaptedExternal.block.content, /references\/ai-linzi-skill-manifest\.json/u)
assert.deepEqual(
  JSON.parse(adaptedExternal.block.files.find(
    (file) => file.path === 'references/ai-linzi-skill-manifest.json',
  ).content).vaultRead,
  {
    scope: 'whole-vault',
    metadataDiscovery: true,
    preferUserScope: true,
    fallbackToWholeVault: true,
    maxFiles: 120,
  },
)
assert.ok(adaptedExternal.repairs.some((item) => /默认按需读取整个 Vault/u.test(item)))

const generatedWithoutManifestAndUnlinkedReference = {
  ...importedWithoutManifest,
  name: 'business-consultation-proposal',
  files: [
    ...importedWithoutManifest.files,
    {
      path: 'references/学员商业咨询行动方案模板.md',
      content: '# 学员商业咨询行动方案模板',
    },
  ],
}
const repairedMissingManifestAndReference = studioCore.normalizeGeneratedSkillManifest(
  generatedWithoutManifestAndUnlinkedReference,
)
assert.equal(
  studioCore.skillBlockManifest(repairedMissingManifestAndReference.block).valid,
  true,
  '缺 manifest 且遗漏 reference 链接时应一次本机修复，不应要求用户重新生成',
)
assert.match(
  repairedMissingManifestAndReference.block.content,
  /\[学员商业咨询行动方案模板\.md\]\(references\/学员商业咨询行动方案模板\.md\)/u,
)
assert.ok(
  repairedMissingManifestAndReference.repairs.includes('已补充 1 个遗漏的 reference 链接'),
)

const unsafeExternalWithoutManifest = {
  ...importedWithoutManifest,
  name: 'external-script-skill',
  files: [
    ...importedWithoutManifest.files,
    { path: 'scripts/run.sh', content: '#!/bin/sh\necho test' },
  ],
}
const blockedExternal = studioCore.normalizeGeneratedSkillManifest(unsafeExternalWithoutManifest)
assert.equal(studioCore.skillBlockManifest(blockedExternal.block).valid, false)
assert.equal(
  blockedExternal.block.files.some(
    (file) => file.path === 'references/ai-linzi-skill-manifest.json',
  ),
  false,
  '缺少 manifest 的脚本包不能自动猜权限后放行',
)
const importableExternalScript = {
  ...importedWithoutManifest,
  name: 'external-script-skill',
  description: '读取 Vault 资料并运行本机脚本生成结果',
  content: importedWithoutManifest.content
    .replaceAll('external-note-method', 'external-script-skill')
    .replace('把当前材料沉淀为一份方法论笔记', '读取 Vault 资料并运行本机脚本生成结果'),
  files: [
    {
      path: 'SKILL.md',
      content: importedWithoutManifest.files[0].content
        .replaceAll('external-note-method', 'external-script-skill')
        .replace('把当前材料沉淀为一份方法论笔记', '读取 Vault 资料并运行本机脚本生成结果'),
    },
    { path: 'scripts/run.mjs', content: 'console.log("ok")' },
  ],
}
for (const scope of ['current-note', 'user-specified-files', 'user-specified-folder', 'whole-vault']) {
  const adapted = studioCore.adaptImportedSkillReadScope(importableExternalScript, scope)
  const checked = studioCore.skillBlockManifest(adapted.block)
  assert.equal(checked.valid, true, `${scope}: ${checked.problems.join('；')}`)
  const adaptedManifest = JSON.parse(adapted.block.files.find(
    (file) => file.path === 'references/ai-linzi-skill-manifest.json',
  ).content)
  assert.equal(adaptedManifest.schemaVersion, 2)
  assert.equal(adaptedManifest.vaultRead.scope, 'whole-vault')
  assert.equal(adaptedManifest.vaultRead.fallbackToWholeVault, true)
  assert.equal(adaptedManifest.vaultRead.preferUserScope, true)
  assert.deepEqual(adaptedManifest.programs, ['scripts/run.mjs'])
  assert.ok(adaptedManifest.permissions.some((item) => /不包含电脑其他目录/u.test(item)))
  assert.ok(adaptedManifest.permissions.some((item) => /声明联网.*确认卡/u.test(item)))
  assert.match(adapted.block.content, /不能访问 Vault 外的电脑文件/u)
}
assert.equal(
  studioCore.importedSkillReadScope(importableExternalScript),
  'whole-vault',
  '外部包没有有效权限声明时，导入弹窗默认当前整个 Vault',
)
assert.deepEqual(
  studioCore.IMPORTED_SKILL_READ_SCOPE_OPTIONS.map((option) => option.value),
  ['whole-vault'],
)
const fixedFolderAdapted = studioCore.adaptImportedSkillReadScope(
  importableExternalScript,
  'user-specified-folder',
  '01_Raw/课程逐字稿',
)
const fixedFolderManifest = JSON.parse(fixedFolderAdapted.block.files.find(
  (file) => file.path === 'references/ai-linzi-skill-manifest.json',
).content)
assert.equal(fixedFolderManifest.vaultRead.fixedFolder, undefined)
assert.equal(fixedFolderManifest.vaultRead.scope, 'whole-vault')
console.log('  ✓ 外部脚本 Skill 统一适配为整个 Vault，脚本不自动运行')
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
assert.equal(
  questionCore.isTerminalVaultQuestionAnswer('不执行任何操作', {
    ...pendingQuestion,
    options: ['重新核验', '不执行任何操作'],
  }),
  true,
  '明确的结束选项必须由本机直接收口，不能再次发给模型循环追问',
)
assert.equal(
  questionCore.isTerminalVaultQuestionAnswer('停止，保留当前 _02 项目', {
    ...pendingQuestion,
    options: ['允许修正', '停止，保留当前 _02 项目'],
  }),
  true,
)
assert.equal(
  questionCore.isTerminalVaultQuestionAnswer('先不做了', pendingQuestion),
  false,
  '不是卡片精确选项的自由文本不能绕过正常澄清流程',
)
const webSearchQuestion = {
  ...pendingQuestion,
  kind: 'web-search',
  question: '是否允许联网搜索？',
  options: ['允许联网搜索', '仅用现有内容'],
  allowFreeText: false,
  webSearchQuery: '2026 内容增长趋势',
  webSearchReason: '补充最新外部数据',
}
assert.equal(
  questionCore.isTerminalVaultQuestionAnswer('仅用现有内容', webSearchQuestion),
  false,
  '联网替代方案仍需交回模型继续，不属于终止整个工作流',
)
const extractedWebSearch = questionCore.extractVaultQuestion(
  questionCore.formatVaultQuestionMarker(webSearchQuestion),
)
assert.equal(extractedWebSearch.invalid, false)
assert.equal(extractedWebSearch.question.kind, 'web-search')
assert.equal(extractedWebSearch.question.allowFreeText, false)
assert.equal(extractedWebSearch.question.webSearchQuery, '2026 内容增长趋势')
assert.equal(
  questionCore.extractVaultQuestion(
    questionCore.formatVaultQuestionMarker({ ...webSearchQuestion, round: 36 }),
  ).invalid,
  false,
  '批量任务最后一轮的联网授权也必须能恢复',
)
assert.equal(
  questionCore.extractVaultQuestion(
    questionCore.formatVaultQuestionMarker({ ...webSearchQuestion, webSearchQuery: '' }),
  ).invalid,
  true,
)
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
export const parseYaml = (value) => {
  const result = {}
  for (const line of value.split(/\\r?\\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\\s*(.*)$/.exec(line.trim())
    if (!match) continue
    try { result[match[1]] = JSON.parse(match[2]) } catch { result[match[1]] = match[2] }
  }
  return result
}
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
const importedAgentSkill = studioUi.portableBundleFromZip(zipSync({
  'agent-standard-skill/SKILL.md': strToU8(`---
name: agent-standard-skill
description: "Codex 或 WorkBuddy 导出的标准 Agent Skill"
license: Apache-2.0
compatibility: Requires local files
allowed-tools: Read Grep
---
# Agent standard skill

按需读取本地资料。`),
  'agent-standard-skill/references/guide.md': strToU8('# Guide\n\nFollow this guide.'),
}))
assert.equal(importedAgentSkill.name, 'agent-standard-skill')
assert.match(importedAgentSkill.content, /^---\nname: agent-standard-skill\ndescription: /u)
assert.doesNotMatch(importedAgentSkill.content, /license:|compatibility:|allowed-tools:/u)
const adaptedAgentSkill = studioCore.adaptImportedSkillReadScope(importedAgentSkill, 'whole-vault')
assert.equal(studioCore.skillBlockManifest(adaptedAgentSkill.block).valid, true)
assert.match(adaptedAgentSkill.block.content, /references\/guide\.md/u)
const importedWithoutManifestZip = studioUi.portableBundleFromZip(zipSync({
  'plain-text-skill/SKILL.md': strToU8(`---
name: plain-text-skill
description: 整理当前一份材料的外部纯文本 Skill
---
# Plain text Skill

## AI霖子输出方式
chat`),
}))
const adaptedWithoutManifestZip = studioCore.normalizeGeneratedSkillManifest(
  importedWithoutManifestZip,
)
assert.equal(studioCore.skillBlockManifest(adaptedWithoutManifestZip.block).valid, true)
assert.ok(adaptedWithoutManifestZip.repairs.some((item) => /默认按需读取整个 Vault/u.test(item)))
assert.throws(
  () => studioUi.portableBundleFromZip(zipSync({
    'bad-skill/SKILL.md': strToU8('---\nname: bad-skill\ndescription: bad\n---\n# Bad'),
    'bad-skill/.hidden': strToU8('secret'),
  })),
  /隐藏路径/,
)
console.log('  ✓ Skill ZIP 可往返导入、缺 manifest 时安全适配为整个 Vault，并拒绝隐藏路径')

const mainSource = await (await import('node:fs/promises')).readFile('src/main.ts', 'utf8')
const studioSource = await (await import('node:fs/promises')).readFile('src/skill-studio.ts', 'utf8')
// 0.7.72 步 1：确认卡渲染已从 main.ts 抽到 create-local-skill-card.ts。
// 断言随代码一起搬到新文件，强度不变。
const cardSource = await (await import('node:fs/promises')).readFile(
  'src/create-local-skill-card.ts',
  'utf8',
)
const updateCardSource = await (await import('node:fs/promises')).readFile(
  'src/skill-update-card.ts',
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
// 「任何来源的非法包不得给创建按钮」这条守卫，现由
// scripts/test-create-local-skill-card.mjs 第 3 组**真跑分支**验证
// （断言非法包时按钮总数为 0）。这里保留源码断言作为搬迁后的位置守卫，
// 防止有人重新依赖云端历史不会保留的 skillCreatorResult 标记。
assert.match(cardSource, /const normalized = normalizeGeneratedSkillManifest\(rawBlock\)/)
assert.match(cardSource, /if \(!manifest\.valid\)/)
assert.doesNotMatch(cardSource, /message\.skillCreatorResult && !manifest\.valid/)
assert.doesNotMatch(
  mainSource,
  /if \(!manifest\.valid\)/,
  '确认卡渲染已抽出，main.ts 不应再持有这段判断（避免两处实现漂移）',
)
assert.match(mainSource, /private hasPendingSkillCreatorInterview\(\): boolean \{[\s\S]*?return message\.skillCreatorPending === true/)
assert.match(mainSource, /const exitPendingSkillCreator = pendingSkillCreatorInterview/)
assert.match(mainSource, /!exitPendingSkillCreator && pendingSkillCreatorInterview/)
assert.doesNotMatch(mainSource, /hasPendingSkillCreatorInterview[\s\S]{0,600}continue[\s\S]{0,200}skillCreatorPending === true[\s\S]{0,100}continue/)
assert.match(
  mainSource,
  /let localSkillMatch = skillCreatorTurn \|\| skillUpdaterTurn \|\| consultationWorkflowTaskTurn\s*\? \{ kind: 'none' as const \}[\s\S]{0,180}explicitInstalledLocalSkill[\s\S]{0,120}explicitLocalSkillMatch[\s\S]{0,120}this\.localSkills\.resolve/,
)
assert.match(mainSource, /localSkillForbidsVaultExpansion\(localSkill\.fullContent\)/)
assert.match(
  mainSource,
  /vaultAccess: true,/,
)
assert.match(mainSource, /scopedLocalSkillInputContext\(text, localSkill\.name\)/)
assert.match(mainSource, /localSkillHasPrimaryInput \|\| skillUpdaterTurn\s*\? undefined\s*:\s*await this\.authorizedContentContext/)
assert.match(
  mainSource,
  /nativeAvailable &&\s*round === 0[\s\S]{0,180}isVaultNativeTurnRequest\(lastText\)/,
)
assert.match(
  mainSource,
  /!nativeAvailable && isVaultNativeTurnRequest\(lastText\)[\s\S]{0,260}pendingRetryReason = 'missing_tool_use'/,
)
assert.match(mainSource, /consultationWorkflowTaskOriginId: message\.id/)
assert.match(mainSource, /consultationWorkflowTaskTurn \|\| localSkill\?\.name === CONSULTATION_WORKFLOW_SKILL_NAME/)
assert.match(mainSource, /forceCloudToolsTurn: consultationWorkflowTaskTurn/)
assert.match(mainSource, /if \(round === 0 && input\.forceCloudToolsTurn\)/)
assert.match(mainSource, /successfulWriteTools\.includes\('addTask'\)/)
assert.match(
  mainSource,
  /private async consultationWorkflowSourceContext\([\s\S]{0,700}isConsultationTranscriptPath\(lockedPath\)[\s\S]{0,700}readLocalDocumentText\(this\.app, file, maxChars, 'skill'\)/,
  '闭环后续步骤必须按已锁定路径读取 MD\/TXT\/PDF\/DOCX，不得只读当前 Markdown 标签页',
)
assert.match(
  mainSource,
  /const currentNoteRequested =\s*!skillCreatorTurn\s*&&\s*!skillUpdaterTurn\s*&&\s*!consultationWorkflowTaskTurn/,
  '咨询闭环按钮续跑时，不得因指令中的“当前咨询材料”误走当前笔记门禁',
)
assert.match(
  mainSource,
  /let noteContext = consultationWorkflowTaskTurn\s*\? await this\.consultationWorkflowSourceContext\(consultationWorkflowSourcePath\)/,
  '第 4 步必须在云端 addTask 前重读第 1 步锁定的原始材料',
)
assert.match(
  mainSource,
  /sourceId: consultationWorkflowTaskTurn\s*\? `consultation-workflow-source:\$\{noteContext\.path\}`\s*:\s*`current-note:\$\{noteContext\.path\}`/,
  '闭环原始 TXT 不得伪装成当前 Markdown 笔记，否则下一轮会再次丢失上下文',
)
assert.match(
  mainSource,
  /if \(!skillCreatorTurn && !skillUpdaterTurn && isFullCurrentNoteReplaceIntent\(text\)\)/,
  'Skill Studio 提示里的“不覆盖”不能误触发当前笔记整篇替换',
)
assert.match(
  mainSource,
  /localSkill\?\.name === WEEKLY_BUSINESS_DASHBOARD_SKILL_NAME\s*\? await this\.runWeeklyBusinessDashboard\(vaultAgentInput\)/,
  '官方经营周报必须进入本机断点摘要专用管道，不能落回重复大上下文循环',
)
assert.match(mainSource, /private async runWeeklyBusinessDashboard/)
assert.match(mainSource, /\/api\/plugin\/v1\/weekly-business/)
assert.match(mainSource, /weeklyBusinessIndex\.put\(record\)/)
assert.match(mainSource, /phase: 'map'/)
assert.match(mainSource, /phase: 'reduce'/)
assert.match(mainSource, /phase: 'final'/)
assert.match(
  cardSource,
  // 同上：已随渲染一起搬到 create-local-skill-card.ts，宿主能力改为回调注入。
  // 「目录中途变化必须中止写入并重绘」这条由 test-create-local-skill-card.mjs
  // 第 7 组真跑验证（断言 created.length === 0 且 rerendered === 1）。
  /const currentRoot = host\.skillsRoot\(\)[\s\S]{0,180}currentRoot !== root[\s\S]{0,260}host\.rerender\(\)/,
)
const runSendTurnSource =
  /private async runSendTurn\([\s\S]*?\n  private async startLongDocumentTask/.exec(mainSource)?.[0] ?? ''
assert.match(runSendTurnSource, /let skillCreatorTurn = false/)
assert.match(
  runSendTurnSource,
  /const skillManagementIntent = options\.skillCreator === true[\s\S]{0,120}options\.skillUpdatePath[\s\S]{0,120}classifyLocalSkillManagementIntent\(text\)/,
  'Studio 已锁定的创建或更新必须优先；自然主对话再做创建、修改、冲突三态判定',
)
assert.match(
  runSendTurnSource,
  /const naturalSkillUpdate = options\.skillCreator !== true &&[\s\S]{0,160}skillManagementIntent !== 'create'/,
  'Skill Studio 已锁定为新建时必须在自然语言修改解析之前短路，不能被提示词里的“修改/更新”截走',
)
assert.match(
  runSendTurnSource,
  /你是想修改已有的[\s\S]{0,220}创建一个新的 Skill/,
  '创建与修改语义同时成立时必须先向用户核对，不能擅自猜测',
)
assert.match(
  runSendTurnSource,
  /skillCreatorTurn =\s*!pendingVaultQuestion\s*&&\s*!skillUpdaterTurn\s*&&[\s\S]{0,420}!exitPendingSkillCreator && pendingSkillCreatorInterview[\s\S]{0,120}explicitSkillCreation/,
  'Skill Creator 路由必须复用同一个新建意图结果，并允许明确文章任务退出错误 pending',
)
assert.match(
  runSendTurnSource,
  /const skillCreatorExtraction = extractCreateLocalSkillBlocks\(answer\)[\s\S]{0,160}const returnedSkillCreatorBlock = skillCreatorExtraction\.blocks\.length > 0[\s\S]{0,1800}skillCreatorResult: skillCreatorTurn \|\| returnedSkillCreatorBlock \|\| undefined/,
  '主模型按语义返回的新建协议也必须走完整 Creator 校验，非法包不能出现安装按钮',
)
assert.match(
  runSendTurnSource,
  /const continuePendingSkillDraft = shouldContinuePendingSkillDraft\([\s\S]{0,160}pendingSkillCreatorDraft\?\.name/,
  '刚生成但尚未安装的草稿必须能在“更新 Skill 吧”之后继续走 Creator，不能误查已安装目录',
)
assert.match(runSendTurnSource, /explicitSkillCreation \|\|\s*continuePendingSkillDraft/)
assert.match(mainSource, /Skill 包格式没有通过本机校验/, '无法修复的 Skill 协议必须显式显示失败卡')
assert.match(
  runSendTurnSource,
  /const explicitLocalSkillRun = forcedLocalSkill[\s\S]{0,100}isExplicitLocalSkillRunIntent\(text\)[\s\S]{0,520}const explicitInstalledLocalSkill = explicitLocalSkillMatch\?\.kind === 'matched'[\s\S]{0,380}options\.skillCreator === true[\s\S]{0,140}!explicitLocalSkillRun/,
  '显式运行已安装 Skill 时必须退出历史 Skill Creator 访谈状态',
)
assert.match(
  mainSource,
  /explicitInstalledLocalSkill\s*\? explicitLocalSkillMatch\s*: await this\.localSkills\.resolve\(text, \{ allowAutomatic: true \}\)/,
  '已在本机解析到的 Skill 运行意图必须复用同一匹配结果',
)
assert.match(studioSource, /addOption\('update', '更新已经安装的 Skill'\)/)
assert.match(studioSource, /onUpdateWithAi\(skill, this\.updateInstruction\)/)
assert.match(
  runSendTurnSource,
  /const pendingSkillUpdatePath = skillManagementIntent === 'create'[\s\S]{0,100}this\.recentPendingSkillUpdatePath\(\)/,
  '用户明确改为创建新 Skill 时必须退出旧更新访谈；其他补充继续锁定原 Skill',
)
assert.match(
  runSendTurnSource,
  /skillUpdateTargetPath = options\.skillUpdatePath \?\? pendingSkillUpdatePath/,
)
assert.match(runSendTurnSource, /buildSkillUpdateSource\(this\.skillUpdateHost, skillUpdateRoot, skillUpdateTarget\.name\)/)
assert.doesNotMatch(
  runSendTurnSource,
  /更新 Skill 时不会顺带发送聊天附件/,
  '截图可以作为只读上下文帮助修改 Skill，不能再要求用户先移除附件',
)
assert.match(runSendTurnSource, /skillCreator: skillCreatorRequest/)
assert.match(runSendTurnSource, /extractSkillUpdateProposals\(answer\)/)
assert.match(runSendTurnSource, /this\.skillUpdateTransaction\.prepare\([\s\S]{0,180}skillUpdateTarget\.path/)
assert.match(runSendTurnSource, /skillUpdatePendingPath = skillUpdaterTurn && !skillUpdateOffer/)
assert.match(mainSource, /\.filter\(\(message\) =>[\s\S]{0,220}!message\.localSkillStatus && !message\.localSkillChoice[\s\S]{0,120}\.map\(\(\{ id, role, parts \}\)/)
assert.match(updateCardSource, /确认并更新到/)
assert.match(
  updateCardSource,
  /const lockedParent = prepared\.skillRoot\.split\('\/'\)\.slice\(0, -1\)\.join\('\/'\)[\s\S]{0,120}lockedParent !== currentRoot/,
)
assert.match(updateCardSource, /不会额外保存 Skill 历史版本/)
assert.doesNotMatch(updateCardSource, /prepareRestore|确认恢复到|单独确认删除/)
assert.match(mainSource, /input\.localSkill\?\.output === 'create-note'[\s\S]{0,220}extractCreateNoteBlocks\(lastText\)\.blocks\.length > 0[\s\S]{0,80}!plan\.plan/)
assert.match(mainSource, /answerPlan\.plan && extractCreateNoteBlocks\(answer\)\.blocks\.length > 0/)
assert.match(mainSource, /Boolean\(input\.resumeQuestion\)[\s\S]{0,280}vaultWriteFlowRetryReason/)
assert.match(
  mainSource,
  /const localSkillTurnPolicy = localSkill[\s\S]{0,160}resolveLocalSkillTurnPolicy\(localSkill\.output, text\)/,
  '每轮必须先按用户只读要求覆盖 Skill 默认输出',
)
assert.match(
  mainSource,
  /output: localSkillTurnPolicy\?\.output \?\? localSkill\.output/,
  '发给模型的 Skill 输出方式必须使用本轮策略',
)
assert.match(
  runSendTurnSource,
  /const currentNoteRequested =[\s\S]{0,420}localSkillTurnPolicy\?\.output === 'update-current-note'/,
  '只读本轮不能被 Skill 默认的 update-current-note 强行送进改写通道',
)
assert.match(
  runSendTurnSource,
  /if \(currentNoteRequested && !noteContext\) \{\s*throw new Error\('没有读取到目标笔记/,
  '只有本轮真正要求当前笔记时，才能触发 Markdown 标签页门禁',
)
assert.match(
  mainSource,
  /pendingVaultQuestion \|\|[\s\S]{0,100}localSkillTurnPolicy\?\.forceOrganize[\s\S]{0,80}\? 'organize'/,
  '只有本轮允许落盘的 create-note/create-artifact Skill 才能强制进入确认流程',
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
console.log('  ✓ Skill 更新专用源、精确目标、确认卡与续问状态已接入且不上传本机元数据')
console.log('  ✓ create-note Skill 仅在本轮允许落盘时强制进入预览确认流程')
console.log('  ✓ create-note 兼容协议是安全循环的合法终态')

console.log('[test-skill-studio] 全部通过')

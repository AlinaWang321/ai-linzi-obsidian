import type { CreateLocalSkillBlock } from './create-local-skill'

export type SkillStudioOutput = 'chat' | 'create-note' | 'update-current-note'

export interface SkillStudioTemplate {
  id: string
  label: string
  description: string
  sampleInput: string
  permissions: string[]
  block: CreateLocalSkillBlock
}

export interface SkillStudioDraft {
  name: string
  purpose: string
  input: string
  steps: string
  triggers: string[]
  output: SkillStudioOutput
  sampleInput: string
  version: string
}

const CREATE_SKILL_INTENT =
  /(?:创建|生成|新建|做|制作|设计|搭建|保存成|沉淀成).{0,18}(?:skill|技能|工作流)|(?:skill|技能|工作流).{0,18}(?:创建|生成|新建|做|制作|设计|搭建)/iu

export function isExplicitLocalSkillCreationIntent(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || /(?:什么是|怎么用|如何用|介绍|解释|查看|列出|有哪些).{0,12}(?:skill|技能)/iu.test(normalized)) {
    return false
  }
  return CREATE_SKILL_INTENT.test(normalized)
}

function manifestFile(
  templateId: string,
  version: string,
  permissions: string[],
  sampleInput: string,
): { path: string; content: string } {
  return {
    path: 'references/ai-linzi-skill-manifest.json',
    content: JSON.stringify(
      {
        schemaVersion: 1,
        skillVersion: version,
        createdWith: 'AI霖子 Skill Studio',
        templateId,
        permissions,
        programs: [],
        sampleInputs: [sampleInput],
      },
      null,
      2,
    ),
  }
}

function skillEntry(input: {
  name: string
  description: string
  title: string
  triggers: string[]
  when: string
  steps: string[]
  output: SkillStudioOutput
  outputRequirements: string[]
  templateLink?: string
}): string {
  const template = input.templateLink
    ? `\n## AI霖子模板校验\n[输出模板](${input.templateLink})\n`
    : ''
  const triggerDescription = input.when.replace(/[.。]+$/u, '')
  const outputInstruction = input.output === 'chat'
    ? '只在对话中交付，不写入文件。'
    : input.output === 'create-note'
      ? '先交付完整 Markdown 预览；只有用户确认后才新建笔记，绝不覆盖同名文件。'
      : '先交付完整差异预览；只有用户确认后才更新发送时锁定的当前笔记，目标变化立即停止。'
  return `---
name: ${input.name}
description: ${input.description}。在${triggerDescription}时使用。
---
# ${input.title}

## 何时使用
${input.when}

## AI霖子自动调用
${input.triggers.map((item) => `- ${item}`).join('\n')}

## 输入
- 只使用用户本轮明确指定的笔记、文件或范围。
- 材料缺失时先说明缺口，不猜测、不补写不存在的事实。

## 运行边界
- 执行前先读取 [AI霖子 Skill 权限与版本](references/ai-linzi-skill-manifest.json)。
- 不扩大读取范围、不额外联网、不运行本机程序；任何写入都必须先预览再确认。

## 工作步骤
${input.steps.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## 输出要求
${input.outputRequirements.map((item) => `- ${item}`).join('\n')}
${template}
## AI霖子输出方式
${outputInstruction}`
}

function makeTemplate(input: {
  id: string
  label: string
  description: string
  sampleInput: string
  permissions: string[]
  entry: string
  references?: { path: string; content: string }[]
}): SkillStudioTemplate {
  const files = [
    { path: 'SKILL.md', content: input.entry },
    ...(input.references ?? []),
    manifestFile(input.id, '1.0.0', input.permissions, input.sampleInput),
  ]
  const name = /^name:\s*([^\r\n]+)/m.exec(input.entry)?.[1]?.trim() ?? input.id
  return {
    ...input,
    block: {
      name,
      description: input.description,
      content: input.entry,
      files,
    },
  }
}

export const OFFICIAL_SKILL_TEMPLATES: SkillStudioTemplate[] = [
  makeTemplate({
    id: 'knowledge-card',
    label: '方法论知识卡',
    description: '把当前笔记提炼成可复用的方法论知识卡',
    sampleInput: '把当前笔记提炼成方法论知识卡',
    permissions: ['读取当前明确打开的笔记', '确认后新建一篇 Markdown', '不运行本机程序', '不额外联网'],
    entry: skillEntry({
      name: 'knowledge-card',
      description: '把当前笔记提炼成可复用的方法论知识卡',
      title: '方法论知识卡',
      triggers: ['把当前笔记提炼成方法论知识卡', '从当前笔记提取方法论'],
      when: '用户希望把一篇经验、课程或复盘笔记沉淀成以后能反复调用的方法论时。',
      steps: [
        '读取发送瞬间锁定的当前笔记，区分事实、观点、步骤和案例。',
        '提炼核心判断、适用场景、执行步骤、常见误区和原文案例。',
        '按 references/知识卡模板.md 生成完整 Markdown；原文没有的内容标为“待补充”。',
      ],
      output: 'create-note',
      outputRequirements: ['保留作者的原意和有辨识度的表达。', '输出必须能脱离原笔记独立阅读。'],
      templateLink: 'references/知识卡模板.md',
    }),
    references: [{
      path: 'references/知识卡模板.md',
      content: '# {{方法论名称}}\n\n## 核心判断\n\n## 适用场景\n\n## 执行步骤\n\n## 常见误区\n\n## 原文案例\n\n## 下一步行动\n',
    }],
  }),
  makeTemplate({
    id: 'meeting-actions',
    label: '会议行动看板',
    description: '把会议记录整理成负责人和截止时间清晰的行动看板',
    sampleInput: '把当前会议记录整理成行动看板',
    permissions: ['读取当前明确打开的笔记', '确认后新建一篇 Markdown', '不运行本机程序', '不额外联网'],
    entry: skillEntry({
      name: 'meeting-actions',
      description: '把会议记录整理成负责人和截止时间清晰的行动看板',
      title: '会议行动看板',
      triggers: ['把当前会议记录整理成行动看板', '整理当前会议的待办'],
      when: '用户开完会，需要把讨论内容变成可以直接执行和追踪的任务清单时。',
      steps: [
        '读取当前会议记录，分别识别结论、分歧、待办和未决问题。',
        '每项待办提取负责人、截止时间、验收标准和依赖；原文没有就写“待确认”。',
        '按优先级输出本周行动看板，并把未决问题单独列出。',
      ],
      output: 'create-note',
      outputRequirements: ['不把讨论意见误写成已拍板结论。', '每个行动项都必须有明确验收口径。'],
    }),
  }),
  makeTemplate({
    id: 'content-repurpose',
    label: '一稿多平台',
    description: '把一篇长内容拆成公众号、小红书和口播三个版本',
    sampleInput: '把当前文章拆成三个平台版本',
    permissions: ['读取当前明确打开的笔记', '确认后新建一篇 Markdown', '不运行本机程序', '不额外联网'],
    entry: skillEntry({
      name: 'content-repurpose',
      description: '把一篇长内容拆成公众号、小红书和口播三个版本',
      title: '一稿多平台',
      triggers: ['把当前文章拆成三个平台版本', '用当前文章做一稿多发'],
      when: '用户已经有一篇完整原创内容，希望适配多个平台而不是简单缩写时。',
      steps: [
        '锁定原文的核心观点、关键故事和不可改变的事实。',
        '分别生成可直接继续定稿的公众号成稿、小红书图文成稿和 60—90 秒口播成稿，不只给大纲。',
        '每个版本按平台阅读习惯重组，但不添加原文没有的经历或数据。',
      ],
      output: 'create-note',
      outputRequirements: ['三个版本共享同一核心观点，但开头、节奏和行动号召不同。', '输出清楚标注三个平台分区；小红书附 3 个标题和 5—8 个话题，口播稿必须能直接朗读。'],
    }),
  }),
  makeTemplate({
    id: 'customer-consultation-brief',
    label: '客户咨询简报',
    description: '把咨询记录整理成客户可读的诊断与行动简报',
    sampleInput: '用客户咨询简报处理当前笔记',
    permissions: ['读取当前明确打开的笔记', '确认后新建一篇 Markdown', '不自动写 CRM', '不运行本机程序', '不额外联网'],
    entry: skillEntry({
      name: 'customer-consultation-brief',
      description: '把咨询记录整理成客户可读的诊断与行动简报',
      title: '客户咨询简报',
      triggers: ['用客户咨询简报处理当前笔记', '把当前咨询记录生成客户简报'],
      when: '用户需要把一份咨询记录转成可以发给客户确认的共识、诊断和下一步行动时。',
      steps: [
        '读取当前咨询记录，区分客户原话、顾问判断、双方共识和待确认事项。',
        '提炼现状、核心卡点、关键判断、行动计划和下一次沟通重点。',
        '删除内部推理和不适合直接发给客户的措辞，保留证据来源。',
      ],
      output: 'create-note',
      outputRequirements: ['不把意向写成承诺，不把建议写成客户已经完成。', '不写入 CRM；涉及隐私时使用用户指定的称呼，未指定时统一写“客户”。'],
    }),
  }),
  makeTemplate({
    id: 'vault-weekly-review',
    label: '知识库周复盘',
    description: '扫描用户明确授权的近期文件，生成一周知识与行动复盘',
    sampleInput: '生成最近 7 天的知识库周复盘',
    permissions: ['按用户要求搜索 Vault', '读取检索命中的必要片段', '确认后新建一篇 Markdown', '不运行本机程序'],
    entry: skillEntry({
      name: 'vault-weekly-review',
      description: '扫描用户明确授权的近期文件，生成一周知识与行动复盘',
      title: '知识库周复盘',
      triggers: ['生成最近 7 天的知识库周复盘', '做本周知识库复盘'],
      when: '用户希望回顾最近一周新增或修改的内容，并从中找出进展、重复主题和下一步时。',
      steps: [
        '优先用当前宿主可用的“按最近修改时间列文件”能力获取最近 7 天清单；在 AI霖子中使用 list_folder(sortBy=modified, sinceDays=7)。若宿主不支持，请用户提供文件清单，不假装已扫描。',
        '只读取与本周目标相关的必要文件；数量过多时先列范围并让用户取舍。',
        '输出本周完成、关键洞察、反复出现的问题、未完成事项和下周前三优先级。',
      ],
      output: 'create-note',
      outputRequirements: ['明确统计口径与实际读取范围。', '每个判断都能追溯到本周真实文件。'],
    }),
  }),
]

export function buildSkillStudioPrompt(draft: SkillStudioDraft): string {
  const triggers = draft.triggers.map((item) => item.trim()).filter(Boolean).slice(0, 8)
  const permissions = [
    /(?:整个|全部|所有|全库|整库|知识库|vault|obsidian|文件夹|目录|最近)/iu.test(draft.input)
      ? '仅在用户明确要求时搜索 Vault'
      : '只读取用户明确指定的输入',
    draft.output === 'chat'
      ? '只在聊天中输出，不写文件'
      : draft.output === 'create-note'
        ? '确认后只新建 Markdown，不覆盖'
        : '确认后只更新发送时锁定的当前笔记',
    '不运行本机程序',
    '不额外联网',
  ]
  return `请用 AI霖子 Skill Creator 创建一个完整、可移植、可测试的 Skill 文件夹。

名称：${draft.name}
版本：${draft.version}
用途：${draft.purpose}
输入范围：${draft.input}
工作步骤：${draft.steps}
自动触发短语：${triggers.join('；') || '不要自动触发，只允许点名调用'}
输出方式：${draft.output}
课堂试运行输入：${draft.sampleInput || '由用户创建后自行输入'}

要求：
1. SKILL.md 必须把何时使用、输入、步骤、输出、事实边界和验收标准写清楚；复杂规范拆到 references/，且 SKILL.md 必须用相对链接指向每个会用到的 reference。
2. 自动触发必须使用上面给出的完整动作短语，不要只写名词。
3. 同时生成 references/ai-linzi-skill-manifest.json，内容必须是合法 JSON，包含 schemaVersion=1、skillVersion=${draft.version}、createdWith="AI霖子 Skill Studio"、permissions=${JSON.stringify(permissions)}、programs=[]、sampleInputs=${JSON.stringify([draft.sampleInput || `用 ${draft.name} 处理一份测试材料`])}。SKILL.md 必须链接该 manifest，并在正文重复“读取范围不扩大、写入先预览再确认、不覆盖”的关键边界，不能只把安全规则放在 manifest。
4. 本版禁止生成 scripts；材料不足时先通过对话说明缺什么，不得猜测。
5. 只输出一个 <<<新建Skill>>> 文件夹协议，等待我确认，不要改动任何现有文件。`
}

export function skillBlockManifest(block: CreateLocalSkillBlock): {
  version: string
  permissions: string[]
  valid: boolean
  problems: string[]
} {
  const file = block.files.find((item) => item.path === 'references/ai-linzi-skill-manifest.json')
  if (!file) return {
    version: '未声明',
    permissions: ['以 SKILL.md 和确认卡为准'],
    valid: false,
    problems: ['缺少 references/ai-linzi-skill-manifest.json'],
  }
  try {
    const value = JSON.parse(file.content) as Record<string, unknown>
    const version = typeof value.skillVersion === 'string' ? value.skillVersion : '未声明'
    const permissions = Array.isArray(value.permissions)
      ? value.permissions.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
      : []
    const programs = Array.isArray(value.programs)
      ? value.programs.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : []
    const sampleInputs = Array.isArray(value.sampleInputs)
      ? value.sampleInputs.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : []
    const problems: string[] = []
    if (value.schemaVersion !== 1) problems.push('schemaVersion 必须为 1')
    if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push('skillVersion 必须是三段版本号')
    if (value.createdWith !== 'AI霖子 Skill Studio') problems.push('createdWith 声明不正确')
    if (permissions.length === 0) problems.push('权限清单不能为空')
    if (sampleInputs.length === 0) problems.push('至少需要一条试运行输入')
    if (!block.content.includes(file.path)) problems.push('SKILL.md 未指向权限与版本 manifest')
    const scripts = block.files.filter((item) => item.path.startsWith('scripts/'))
    if (scripts.length > 0 && programs.length === 0) problems.push('包含脚本却没有声明 programs')
    if (scripts.length === 0 && programs.length > 0) problems.push('声明了 programs 但没有对应脚本')
    for (const reference of block.files.filter(
      (item) => item.path.startsWith('references/') && item.path !== file.path,
    )) {
      if (!block.content.includes(reference.path)) problems.push(`SKILL.md 未指向 ${reference.path}`)
    }
    return {
      version,
      permissions: permissions.length > 0 ? permissions : ['权限清单无效'],
      valid: problems.length === 0,
      problems,
    }
  } catch {
    return {
      version: '格式无效',
      permissions: ['元数据格式无效，本次不要执行程序'],
      valid: false,
      problems: ['manifest 不是合法 JSON'],
    }
  }
}

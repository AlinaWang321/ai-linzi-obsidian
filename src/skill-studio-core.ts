import type { CreateLocalSkillBlock } from './create-local-skill'

export type SkillStudioOutput =
  | 'chat'
  | 'create-note'
  | 'update-current-note'
  | 'create-artifact'

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
    id: 'consultation-client-workflow',
    label: '咨询交付闭环',
    description: '把一份咨询逐字稿依次变成客户档案、CRM 客户、跟进任务和客户咨询简报',
    sampleInput: '用咨询交付闭环处理当前逐字稿',
    permissions: [
      '读取当前明确打开的一份逐字稿',
      '搜索并读取用户已有客户档案模板或样例',
      '确认后新建或更新一份客户档案',
      '分步确认后写入 AI霖子 CRM 与任务清单',
      '最终调用 AI霖子客户咨询简报并生成 PNG',
      '不运行任意本机程序，不访问第三方网站',
    ],
    entry: `---
name: consultation-client-workflow
description: 把当前一份咨询逐字稿处理成客户档案，确认后分步写入 AI霖子 CRM、创建跟进任务，并生成客户可见的咨询简报 PNG。用于销售咨询、商业咨询或交付咨询结束后的完整沉淀。
---
# 咨询交付闭环

## AI霖子自动调用
- 用咨询交付闭环处理当前逐字稿
- 一条龙处理当前咨询逐字稿

## 输入
- 必须由用户打开并明确发送当前这一份逐字稿；一次只处理一位客户的一份逐字稿。
- 开始前先读取 [权限与版本](references/ai-linzi-skill-manifest.json)、[客户档案兜底模板](references/customer-profile-fallback.md) 和 [五步验收规则](references/workflow-checklist.md)。

## 模板优先级
1. 先在 Vault 中搜索“客户档案模板”“客户模板”以及含 CRM 字段的既有客户档案。
2. 找到用户自己的明确模板时，完整保留它的 frontmatter 字段、章节顺序和命名方式；用户自定义字段不得删除。模板若在“模板库”，不得把客户档案写进模板目录：继续查找该模板对应的真实客户库或既有档案目录。
   - 产出客户档案方案前，必须再用 list_folder 真实列出候选父目录，确认目标文件夹已存在。不得从模板文件名或搜索片段猜造目录，不得把没有 list_folder 回执的路径说成“已核实”。
3. 没有模板文件但有既有客户档案时，读取同一客户库中一份结构完整的近期档案作为样例，并沿用其结构、文件夹和命名规则。
4. 多套模板无法判断时，列出候选模板的完整路径、关键字段和章节差异，只问用户选择哪一套。
5. 完全找不到模板或样例时才使用 references/customer-profile-fallback.md，并只追问一次“客户档案保存到哪个 Vault 文件夹”；用户确认文件夹后按“{{客户称呼}}_客户档案.md”命名，不猜目录、不写到 AI霖子输出目录。

## 五步工作流
### 第 1 步：处理咨询逐字稿
完整读取逐字稿，区分客户原话、顾问判断、双方共识、承诺、顾虑与待确认事实。缺失信息写“待补充”，不得把报价当收入、把意向当成交、把建议当已完成。

### 第 2 步：生成客户档案
按“模板优先级”生成完整客户档案。已有同一客户档案时先 read_note，再提出局部更新；没有时只新建到已经核实的真实客户库。展示全文或差异确认卡后停下。**必须等待用户点击本地确认卡并收到“已新建/已更新客户档案”的真实回执；普通文字“继续”不能代替这次文件写入确认。** 档案真实写入后，再提示“回复继续，进入 CRM”。

### 第 3 步：添加到 AI霖子 CRM
只有第 2 步已有真实文件写入回执且用户随后回复“继续”，才用确认后的档案事实写入 CRM；不得把确认客户档案的一次操作同时解释为确认 CRM。成功必须原样复述 CRM 客户编号；没有真实工具成功回执，绝不说已添加。完成后提示“回复继续，创建跟进任务”。

### 第 4 步：添加客户跟进任务
根据双方明确约定创建一条带时间、动作、对象和验收标准的任务。原文没有日期时先问一个问题，不擅自设定。真实写入成功后提示再次回复“继续”。

### 第 5 步：生成咨询简报
用户再次回复“继续”后，调用 AI霖子现有“客户咨询简报”能力，并继续使用第 1 步锁定的原逐字稿。让用户在本机弹窗确认客户称呼、咨询师称呼等信息；最终 PNG 必须保存到用户设置的 AI霖子输出目录下“客户咨询简报”文件夹。不得自己伪造已经生成。
若此 Skill 被导入到没有 AI霖子客户咨询简报能力的其他 Agent，只能如实交付已经完成的前四步并说明第五步需要回到 AI霖子执行，不得虚构 PNG。

## 安全边界
- 本地档案、CRM、任务、咨询简报四类写入分别确认；用户可以在任一步停止。
- 读取范围不扩大；客户隐私只用于本轮明确任务，不写入 Skill 文件，不额外联网。
- 所有文件只新建或基于已读原文更新，不覆盖未知同名文件。

## AI霖子输出方式
create-note`,
    references: [
      {
        path: 'references/customer-profile-fallback.md',
        content: `# 客户档案兜底模板

仅在用户 Vault 中没有自己的模板或既有客户档案样例时使用。

\`\`\`markdown
---
客户称呼: 待补充
客户编号: 待补充
微信号: 待补充
渠道来源: 待补充
客户阶段: 已咨询
精准度: 待补充
意向产品: 待补充
职业背景: 待补充
核心痛点: 待补充
备注: 待补充
推荐人: 待补充
加微信日期: 待补充
约咨询日期: 待补充
咨询日期: 待补充
---

# {{客户称呼}}客户档案

## 基本情况

## 目标与真实需求

## 核心卡点与顾虑

## 关键原话与判断依据

## 产品意向与成交进度

## 双方共识

## 下一步跟进
\`\`\`

客户阶段只能使用：新增、已约咨询、已咨询、已成交、交付中、已完结、流失。精准度只在证据充分时填 A/B/C，无法判断就写“待补充”。`,
      },
      {
        path: 'references/workflow-checklist.md',
        content: `# 五步验收规则

1. 逐字稿：确认已读完整原文，列出无法确认的信息。
2. 客户档案：优先沿用用户模板；写入前显示全文或精确差异。
3. CRM：必须有真实成功回执和客户编号。
4. 跟进任务：必须包含时间、动作、对象、验收标准。
5. 咨询简报：必须由 AI霖子现有简报能力生成 PNG，并进入用户设置的输出目录。

任一步失败就停在该步，不把后续动作说成已完成。`,
      },
    ],
  }),
  makeTemplate({
    id: 'weekly-business-dashboard',
    label: '经营周报交互看板',
    description: '批量读取最近 7 天改动的文档，突出昨日进展和今日待办，生成可交互 HTML 经营看板',
    sampleInput: '生成本周经营周报看板',
    permissions: [
      '用户明确调用后读取最近 7 天内改动的可读文档正文',
      '读取 AI霖子当前任务清单用于今日待办',
      '确认后在用户设置的 AI霖子输出目录生成一个 HTML',
      '不修改源文件，不运行本机程序，不访问第三方网站',
    ],
    entry: `---
name: weekly-business-dashboard
description: 批量读取 Obsidian 最近 7 天内改动的文档内容，单独突出昨天进展并结合 AI霖子当前任务，生成可搜索、可勾选、带进度统计的 HTML 经营周报看板。
---
# 经营周报交互看板

## AI霖子自动调用
- 生成本周经营周报看板
- 做最近七天经营复盘看板

## 输入与授权
- 用户调用本 Skill，即授权本轮按修改时间读取 Vault 最近 7 天内的可读文档；不读取隐藏目录、Skills 目录或插件保护文件。
- 开始前先读取 [权限与版本](references/ai-linzi-skill-manifest.json) 和 [经营看板分析规范](references/weekly-dashboard-spec.md)。
- 只把本轮实际读取的文档正文发送给 AI霖子分析，不建立云端 Vault 索引，不在聊天历史保存本地正文。

## 工作步骤
1. 先调用 list_folder(sortBy="modified", sinceDays=7, offset=0, maxEntries=160) 取得文件清单和数量；只要 nextOffset 不是 null 就继续按 offset 分页，直到得到完整清单。若 scanTruncated=true，则总数只能标为“至少 N 份”，不得冒充精确全量。
2. 再用 read_recent_documents(sinceDays=7, offset=0, maxChars=70000) 读取正文。AI霖子 0.7.68+ 会在本机自动追完文件分页和长文字符分页；你必须以所有 read_recent_documents 工具结果的合集统计已读数，不得只看第一条。不得拿文件名、搜索片段或一份样例冒充全量扫描。
3. 如果工具明确达到预算上限或仍有未读文件，停止生成并如实报告“已读/未读数量”，不要输出伪完整周报。
4. 以北京时间区分最近 7 天、昨天和今天；昨天单列发生了什么、形成了什么结果、遗留什么。
5. 结合系统提供的 AI霖子当前任务，生成今天待办。没有任务数据时写“未读取到 AI霖子任务”，绝不编造。
6. 按 references/weekly-dashboard-spec.md 生成完整 Markdown 真相源，再提交一个 create_artifact：format=html、layout=dashboard、path=$OUTPUT/经营周报/YYYY.MM.DD_经营周报交互看板.html。

## 验收边界
- 看板必须显示统计口径、总文件数、成功读取数、跳过数和来源文件清单。
- 可读/跳过必须以本机工具的 readable 和实际成功回执为准。PDF、DOCX、HTML、PPTX、XLSX 都可能被本机提取，不得按扩展名笼统宣称“PDF 不可读”；只有工具明确失败的文件才记为失败。
- 事实、原因假设、待验证问题分开；报价不算收入，意向不算成交，计划不算完成。
- HTML 只在本机固定模板渲染，自包含、无外链、无追踪；确认前不写入，同名文件不覆盖。
- 对话摘要、确认卡和最终成功回执都必须如实写上面的 $OUTPUT/经营周报 路径，不得改称 03_Dashboard、Vault 根目录或仓库外文件夹。

## AI霖子输出方式
create-artifact`,
    references: [{
      path: 'references/weekly-dashboard-spec.md',
      content: `# 经营看板分析规范

## 经营链路
按“内容 → 有效线索 → 咨询 → 成交 → 收入/回款 → 交付/复购”组织事实。材料没有某类数据时写“未记录”，不要写 0。

## HTML 看板 Markdown 结构

\`\`\`markdown
# 本周经营复盘｜{{日期范围}}
> 扫描 {{总数}} 份，完整读取 {{读取数}} 份，跳过 {{跳过数}} 份

## 经营总览
### 关键结果
### 经营链路
### 最大差距

## 昨日重点
### 昨日完成
### 昨日结果
### 昨日遗留

## 今日待办
### 今天必须推进
- [ ] {{具体任务}}
### 完成一项即可
- [ ] {{具体任务}}

## 七天轨迹
### 每日进展
### 反复出现的主题
### 可复制动作

## 下周决策
### 三个优先行动
- [ ] {{行动}}
### 不做清单

## 数据依据
### 实际读取文件
### 跳过或失败文件
### 待补数据
\`\`\`

今日任务必须是动词开头、对象明确、能勾选完成；“推进项目”“跟进客户”这类空话不合格。`,
    }],
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
        : draft.output === 'create-artifact'
          ? '确认后只生成一个本机成品文件，不覆盖'
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
4. 本版禁止生成 scripts；材料不足时先通过对话说明缺什么，不得猜测。create-artifact 只用于 HTML/DOCX/PDF/PPTX 成品，路径必须使用 $OUTPUT/ 开头并由用户确认。
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

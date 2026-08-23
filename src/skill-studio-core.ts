import type { CreateLocalSkillBlock } from './create-local-skill'
import {
  buildLocalSkillDescriptor,
  localSkillOutputFromMarkdown,
  matchLocalSkillInvocation,
} from './local-skill-core'
import {
  parseLocalSkillManifest,
  type LocalSkillVaultReadScope,
} from './local-skill-manifest'

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
  /** 默认搜索方式；真正的读取上限始终是当前整个 Vault。 */
  readScope?: LocalSkillVaultReadScope
  input: string
  steps: string
  triggers: string[]
  output: SkillStudioOutput
  sampleInput: string
  version: string
}

export const SKILL_STUDIO_READ_SCOPE_OPTIONS: {
  value: LocalSkillVaultReadScope
  label: string
  description: string
}[] = [
  {
    value: 'whole-vault',
    label: '整个 Vault',
    description: '默认可按需搜索整个知识库；用户在运行时点名文件或文件夹，只是缩小当次搜索范围。',
  },
]

/** 外部 Skill 也统一适配为当前整个 Vault；运行时仍可点名文件/文件夹加速。 */
export const IMPORTED_SKILL_READ_SCOPE_OPTIONS = SKILL_STUDIO_READ_SCOPE_OPTIONS

export function skillStudioReadScope(draft: Pick<SkillStudioDraft, 'readScope' | 'input'>): LocalSkillVaultReadScope {
  // 读取权限不再由新手表单或输入描述缩小；点名范围只影响当次搜索顺序。
  void draft
  return 'whole-vault'
}

export function skillReadScopePermission(scope: LocalSkillVaultReadScope, fixedFolder?: string): string {
  if (scope === 'current-note') return '默认可读取整个 Vault；本轮优先处理用户打开或点名的一篇笔记'
  if (scope === 'user-specified-files') return '默认可读取整个 Vault；本轮优先处理用户指定的多份文件'
  if (scope === 'user-specified-folder') {
    return fixedFolder
      ? `默认可读取整个 Vault；优先搜索文件夹：${fixedFolder}`
      : '默认可读取整个 Vault；优先搜索用户指定的文件夹'
  }
  return '默认可按需搜索和读取整个 Vault；优先使用用户指定的文件或文件夹'
}

export function skillReadPolicy(_scope: LocalSkillVaultReadScope, _metadataDiscovery = false, _fixedFolder?: string): {
  scope: LocalSkillVaultReadScope
  fixedFolder?: string
  metadataDiscovery: boolean
  preferUserScope: boolean
  fallbackToWholeVault: boolean
  maxFiles: number
} {
  return {
    scope: 'whole-vault',
    metadataDiscovery: true,
    preferUserScope: true,
    fallbackToWholeVault: true,
    maxFiles: 120,
  }
}

export function skillTestInputForReadScope(name: string, scope: LocalSkillVaultReadScope): string {
  if (scope === 'current-note') return `用 ${name} Skill 处理当前笔记`
  if (scope === 'user-specified-files') return `用 ${name} Skill 处理我指定的这些文件`
  if (scope === 'user-specified-folder') return `用 ${name} Skill 处理我指定的文件夹`
  return `用 ${name} Skill 在整个 Vault 中完成这项任务`
}

export type SkillInvocationPreview = {
  kind: 'automatic' | 'explicit' | 'missing'
  input: string
}

/** 「立即试运行」与创建前自检必须使用同一句输入，避免预览绿但按钮填入另一句话。 */
export function skillTestInput(block: CreateLocalSkillBlock, sampleInput: string): string {
  return sampleInput.trim() || `用 ${block.name} Skill 处理当前笔记`
}

/** 用生产匹配器检查一条测试输入到底能否调起这一个待创建 Skill。 */
export function previewSkillInvocation(
  block: CreateLocalSkillBlock,
  sampleInput: string,
): SkillInvocationPreview {
  const entry = block.files.find((file) => file.path.toLocaleLowerCase() === 'skill.md')
  const content = entry?.content || block.content
  const descriptor = buildLocalSkillDescriptor(
    `05_System/Skills/${block.name}/SKILL.md`,
    { name: block.name, description: block.description },
    content,
  )
  const input = skillTestInput(block, sampleInput)
  if (!descriptor) return { kind: 'missing', input }
  const match = matchLocalSkillInvocation(input, [descriptor], { allowAutomatic: true })
  if (match.kind !== 'matched') return { kind: 'missing', input }
  return { kind: match.automatic === true ? 'automatic' : 'explicit', input }
}

export function skillInvocationPreviewText(preview: SkillInvocationPreview): string {
  if (preview.kind === 'automatic') return `✅ 自动命中：${preview.input}`
  if (preview.kind === 'explicit') {
    return `⚠️ 显式命中：${preview.input}（靠“用/调用 + 名称”，不会被自然说法自动触发）`
  }
  return `❌ 完全不命中：${preview.input}（点“立即试运行”也调不起这个 Skill）`
}

/** Studio 尚未生成完整包时，用当前表单构造最小 SKILL.md，再走同一个生产匹配器。 */
export function previewSkillStudioDraftInvocation(draft: SkillStudioDraft): SkillInvocationPreview {
  const name = draft.name.trim() || 'preview-skill'
  const triggerLines = draft.triggers
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n')
  const content = [
    '---',
    `name: ${name}`,
    `description: ${draft.purpose.trim() || '待填写用途'}`,
    '---',
    `# ${name}`,
    '',
    '## AI霖子自动调用',
    triggerLines,
  ].join('\n')
  return previewSkillInvocation(
    {
      name,
      description: draft.purpose.trim() || '待填写用途',
      content,
      files: [{ path: 'SKILL.md', content }],
    },
    draft.sampleInput,
  )
}

const CREATE_SKILL_INTENT =
  /(?:创建|生成|新建|做|制作|设计|搭建|保存成|沉淀成|固定成|固化成|封装成).{0,18}(?:skill|技能|工作流)|(?:skill|技能|工作流).{0,18}(?:创建|生成|新建|做|制作|设计|搭建|固定|固化|封装)/iu

export function isExplicitLocalSkillRunIntent(text: string): boolean {
  return /(?:^|[，,。.!！?？:：]|请|帮我)(?:用|使用|调用|运行|执行|启用)\s*[^\r\n]{1,80}?(?:skill|技能)(?:\s|，|,|来)*(?:处理|整理|生成|制作|运行|执行|分析|改写|更新|创建)(?![^\r\n]{0,18}(?:skill|技能))/iu.test(
    text.trim(),
  )
}

export function isExplicitLocalSkillCreationIntent(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || /(?:什么是|怎么用|如何用|介绍|解释|查看|列出|有哪些).{0,12}(?:skill|技能)/iu.test(normalized)) {
    return false
  }
  // “调用某个 Skill，生成/创建一份业务产物”是在运行现有 Skill，不是在创建
  // 新 Skill。这里必须先让显式调用进入本地 Skill 解析器，否则带“生成”二字的
  // 正常调用（例如经营周报）会被 Skill Creator 抢走。
  if (isExplicitLocalSkillRunIntent(normalized)) return false
  return CREATE_SKILL_INTENT.test(normalized)
}

function manifestFile(
  templateId: string,
  version: string,
  permissions: string[],
  sampleInput: string,
  entry: string,
  explicitReadScope?: LocalSkillVaultReadScope,
  metadataDiscovery = false,
): { path: string; content: string } {
  const joined = permissions.join('\n').normalize('NFKC')
  // 官方模板必须显式声明输入权限。不能从整段产品文案猜：例如咨询模板会把
  // PNG 保存到“输出目录”，若按“目录”二字推断，就会把本应读取当前笔记的
  // Skill 错配成“必须指定输入文件夹”。推断仅保留给旧调用方兼容。
  const scope: LocalSkillVaultReadScope = explicitReadScope ?? (
    /(?:最近\s*7\s*天|整个|全部|所有|全库|整库).{0,12}(?:Vault|知识库|文档)/iu.test(joined)
      ? 'whole-vault'
      : /(?:当前(?:打开)?|一份|一个|一篇|单篇|单个)/u.test(joined)
        ? 'current-note'
        : /(?:文件夹|目录)/u.test(joined)
          ? 'user-specified-folder'
          : 'user-specified-files'
  )
  const output = localSkillOutputFromMarkdown(entry)
  return {
    path: 'references/ai-linzi-skill-manifest.json',
    content: JSON.stringify(
      {
        schemaVersion: 2,
        skillVersion: version,
        createdWith: 'AI霖子 Skill Studio',
        templateId,
        permissions,
        vaultRead: skillReadPolicy(scope, metadataDiscovery),
        vaultWrite: {
          mode: output,
          confirmation: 'single-atomic-plan',
          overwrite: false,
        },
        network: 'ai-linzi-only',
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
  vaultReadScope?: LocalSkillVaultReadScope
  metadataDiscovery?: boolean
  references?: { path: string; content: string }[]
}): SkillStudioTemplate {
  const files = [
    { path: 'SKILL.md', content: input.entry },
    ...(input.references ?? []),
    manifestFile(
      input.id,
      '1.1.0',
      input.permissions,
      input.sampleInput,
      input.entry,
      input.vaultReadScope,
      input.metadataDiscovery,
    ),
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
    sampleInput: '用咨询交付闭环处理当前打开的咨询文档',
    permissions: [
      '默认可按需搜索整个 Vault；优先锁定你当前打开或点名的一份咨询材料',
      '只读取完成咨询交付所需的相关内容，不把整个 Vault 正文一次性提交给 AI',
      '默认使用内置客户档案模板；路径不唯一或已有同名档案时先询问',
      '你确认后，新建或更新这位客户的档案',
      '继续确认后，同步到 AI霖子客户管理并创建跟进任务',
      '最后生成客户咨询简报 PNG，保存到你设置的 AI霖子输出目录',
      '不会运行本机脚本，也不会访问无关网站',
    ],
    vaultReadScope: 'whole-vault',
    metadataDiscovery: true,
    entry: `---
name: consultation-client-workflow
description: 把当前一份咨询逐字稿处理成客户档案，确认后分步写入 AI霖子 CRM、创建跟进任务，并生成客户可见的咨询简报 PNG。用于销售咨询、商业咨询或交付咨询结束后的完整沉淀。
---
# 咨询交付闭环

## AI霖子自动调用
- 用咨询交付闭环处理当前逐字稿
- 用咨询交付闭环处理当前咨询文档
- 用咨询交付闭环处理这份咨询记录
- 一条龙处理当前咨询逐字稿

## 输入
- 必须由用户打开并明确发送当前这一份咨询逐字稿、咨询文档或咨询记录；一次只处理一位客户的一份材料。
- 默认可按需搜索整个 Vault；先锁定用户点名的咨询材料，再按任务需要查找客户库、模板或相关方法论。不得把整个 Vault 正文一次性提交给 AI。
- 开始前先读取 [权限与版本](references/ai-linzi-skill-manifest.json)、[客户档案兜底模板](references/customer-profile-fallback.md) 和 [五步验收规则](references/workflow-checklist.md)。

## 保存位置与模板
1. 先列出 Vault 根目录和必要的下级目录，只根据真实文件夹路径定位客户库；不得假设所有用户都使用 02_Wiki 或任何固定目录名，只读取完成本次交付所需的相关正文。
2. 只有一个名称明确包含“客户档案”或“客户库”的现有文件夹时，使用它作为候选保存位置；有多个或没有候选时，只追问一次“客户档案保存到哪个 Vault 文件夹”。
3. 产出客户档案方案前，必须再用 list_folder 真实列出候选父目录，确认目标文件夹已存在。不得从文件名或片段猜造目录，不得把没有 list_folder 回执的路径说成“已核实”。
4. 默认使用 references/customer-profile-fallback.md 的 14 个标准字段和章节；没有事实的字段写“待补充”。本轮不读取其他客户档案正文来模仿格式。
5. 目录元数据里已经出现可能的同一客户档案时，不覆盖、不猜内容，先询问用户是否改走“更新已有 Skill/档案”的单独流程。

## 五步工作流
### 第 1 步：处理咨询逐字稿
完整读取逐字稿，区分客户原话、顾问判断、双方共识、承诺、顾虑与待确认事实。缺失信息写“待补充”，不得把报价当收入、把意向当成交、把建议当已完成。

### 第 2 步：生成客户档案
按“保存位置与模板”生成完整客户档案，新建到已经核实或由用户确认的客户库。展示全文确认卡后停下。**必须等待用户点击本地确认卡并收到“已新建客户档案”的真实回执；普通文字“继续”不能代替这次文件写入确认。** 档案真实写入后，插件应显示“下一步：同步到 AI霖子 CRM”，不让用户猜下一句该说什么。

### 第 3 步：添加到 AI霖子 CRM
只有第 2 步已有真实文件写入回执且用户点击“下一步：同步到 AI霖子 CRM”或明确回复继续，才用确认后的档案事实写入 CRM；不得把确认客户档案的一次操作同时解释为确认 CRM。成功必须原样复述 CRM 客户编号；没有真实工具成功回执，绝不说已添加。完成后显示“下一步：确认创建跟进任务”。

### 第 4 步：添加客户跟进任务
用户点击“下一步：确认创建跟进任务”即代表本次写入确认。根据双方已经明确的共识创建一条本周任务；标题必须以动词开头，写清对象和完成标准。原文有具体日期时写入标题，没有日期时只使用“本周”周期，不编造具体日期。这个步骤直接进入 AI霖子任务写入，不得重新扫描 Vault。真实写入成功后显示“下一步：生成客户咨询简报”。

### 第 5 步：生成咨询简报
用户点击“下一步：生成客户咨询简报”或明确回复继续后，调用 AI霖子现有“客户咨询简报”能力，并继续使用第 1 步锁定的原咨询材料。让用户在本机弹窗确认客户称呼、咨询师称呼等信息；最终 PNG 必须保存到用户设置的 AI霖子输出目录下“客户咨询简报”文件夹。不得自己伪造已经生成。
若此 Skill 被导入到没有 AI霖子客户咨询简报能力的其他 Agent，只能如实交付已经完成的前四步并说明第五步需要回到 AI霖子执行，不得虚构 PNG。

## 安全边界
- 本地档案、CRM、任务、咨询简报四类写入分别确认；用户可以在任一步停止。
- 读取能力只到当前 Vault；客户隐私只用于本轮明确任务，不写入 Skill 文件，不额外联网。
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
      '首次读取最近 7 天内改动的可读文档正文，后续只读取新增或改动正文',
      '本机只保存文件路径、修改时间、大小和上一份看板路径，不保存正文索引',
      '结合 AI霖子当前任务清单整理今天待办',
      '你确认后，在设置的 AI霖子输出目录生成一个 HTML 看板',
      '不会修改源文件、运行本机脚本或访问无关网站',
    ],
    vaultReadScope: 'whole-vault',
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
- 首次运行做完整扫描；用户确认生成完整 HTML 后，本机只保存路径、mtime、size 与成品路径作为增量基线。以后刷新会读取上一份完整看板和新增/改动正文，不把旧正文重复发送给 AI。

## 工作步骤
1. 调用 read_recent_documents(sinceDays=7, offset=0, maxChars=70000) 建立本轮固定文件快照并读取正文。AI霖子会在本机自动沿同一 snapshotId 追完文件分页和长文字符分页；你必须以所有工具结果的合集统计总数、已读数与跳过数，不得只看第一条，也不得拿文件名或一份样例冒充全量扫描。
   - refreshMode=full：用本轮全部正文生成完整看板。
   - refreshMode=incremental：以上一次 baselineDashboard 为完整基线，只合并 changedFiles 对应的新增/修改正文，并按 removedFiles 移除已删除或已移出七天窗口的来源；最终仍必须提交一份完整看板，不能只交一份“增量摘要”。
2. 默认排除用户设置的整个 AI霖子输出目录、我的 Skills 目录和插件保护文件，避免把 AI 自己的产物再次总结成本周经营动作。图片、音视频等未提取附件进入“跳过”清单，不冒充已读正文。
3. 看板必须显示工具返回的统计口径提醒：最近 7 天按文件修改时间计算，同步、git pull 或批量脚本改写可能影响口径。如果工具结果被截断、达到预算上限或仍有未读文件，停止生成并如实报告，不输出伪完整周报。
4. 以北京时间区分最近 7 天、昨天和今天；昨天单列发生了什么、形成了什么结果、遗留什么。
5. 结合系统提供的 AI霖子当前任务，生成今天待办。没有任务数据时写“未读取到 AI霖子任务”，绝不编造。
6. 按 references/weekly-dashboard-spec.md 生成完整 Markdown 真相源，再提交一个 create_artifact：format=html、layout=dashboard、path=$OUTPUT/经营周报/YYYY.MM.DD_经营周报交互看板.html。

## 验收边界
- 看板必须显示统计口径、刷新模式、总文件数、本次读取数、复用基线数、跳过数和来源文件清单；首次全量时复用基线数为 0。
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
> {{用一句话说清本周最重要的经营判断}}
> 扫描 {{总数}} 份，完整读取 {{读取数}} 份，跳过 {{跳过数}} 份

## 今日待办
### 今天必须推进
- [ ] {{具体任务}}
### 完成一项即可
- [ ] {{具体任务}}

## 经营链路
| 环节 | 本周 | 上周 |
|---|---:|---:|
| 内容 | {{数量}} | {{数量或未记录}} |
| 有效线索 | {{数量}} | {{数量或未记录}} |
| 咨询 | {{数量}} | {{数量或未记录}} |
| 成交 | {{数量}} | {{数量或未记录}} |
| 收入/回款 | {{金额或未记录}} | {{金额或未记录}} |
| 交付/复购 | {{数量或未记录}} | {{数量或未记录}} |
### 最大漏点
{{用一句话说明当前卡在哪一步；没有完整数字时明确写待补数据}}

## 本周数字
| 指标 | 本周 | 环比 |
|---|---:|---:|
| {{关键指标}} | {{数值}} | {{▲/▼/持平 + 百分比，或未记录}} |

## 七天节奏
### 每日进展
| 日期 | 数值 | 主线 | 结果 | 一句话 |
|---|---:|---|---|---|
| {{日期}} | {{当天线索等可比较数值}} | {{主线}} | {{结果}} | {{一句话}} |
### 反复出现的主题
### 可复制动作

## 昨天发生了什么
### 昨日完成
- [x] {{已经完成的事实}}
### 昨日结果
### 昨日遗留
- [ ] {{尚未完成的遗留}}

## 下周决策
### 三个优先行动
1. {{行动}}
### 不做清单

## 数据依据
### 实际读取文件
### 跳过或失败文件
### 待补数据
> 口径提醒：最近 7 天按文件修改时间统计，同步、git pull 或批量脚本改写可能影响本周口径。
\`\`\`

今日任务必须是动词开头、对象明确、能勾选完成；“推进项目”“跟进客户”这类空话不合格。`,
    }],
  }),
]

export function buildSkillStudioPrompt(draft: SkillStudioDraft): string {
  const triggers = draft.triggers.map((item) => item.trim()).filter(Boolean).slice(0, 8)
  const readScope = skillStudioReadScope(draft)
  const inputPermission = skillReadScopePermission(readScope)
  const vaultRead = skillReadPolicy(readScope)
  const vaultWrite = {
    mode: draft.output,
    confirmation: 'single-atomic-plan',
    overwrite: false,
  }
  const inputScopeRequirement = readScope === 'user-specified-folder'
    ? '读取能力默认覆盖当前整个 Vault：先搜索用户在本轮点名的文件或文件夹；该范围没有所需材料时，继续在整个 Vault 中搜索相关候选，不要直接回答“没有”。搜索和筛选在本机完成，只读取并提交完成任务所必需的文件内容，不得把整个 Vault 的正文一次性提交给模型，也永远不能访问 Vault 外的电脑文件。'
    : '读取能力默认覆盖当前整个 Vault：优先使用用户点名的文件或文件夹；未指定范围，或优先范围没有所需材料时，继续搜索整个 Vault 中的任务相关候选。搜索和筛选在本机完成，只读取并提交完成任务所必需的文件内容，不得把整个 Vault 的正文一次性提交给模型，也永远不能访问 Vault 外的电脑文件。'
  const permissions = [
    inputPermission,
    '读取权限仅限当前 Obsidian Vault，不包含电脑其他目录',
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
读取权限：${inputPermission}
输入材料说明：${draft.input}
工作步骤：${draft.steps}
自动触发短语：${triggers.join('；') || '不要自动触发，只允许点名调用'}
输出方式：${draft.output}
试运行指令：${draft.sampleInput || '由用户创建后自行输入'}

要求：
1. SKILL.md 必须把何时使用、输入、步骤、输出、事实边界和验收标准写清楚；复杂规范拆到 references/，且 SKILL.md 必须用相对链接指向每个会用到的 reference。
2. 自动触发必须使用上面给出的完整动作短语，不要只写名词。
3. 同时生成 references/ai-linzi-skill-manifest.json，内容必须是合法 JSON，包含 schemaVersion=2、"skillVersion":${JSON.stringify(draft.version)}、createdWith="AI霖子 Skill Studio"、permissions=${JSON.stringify(permissions)}、vaultRead=${JSON.stringify(vaultRead)}、vaultWrite=${JSON.stringify(vaultWrite)}、network="ai-linzi-only"、programs=[]、sampleInputs=${JSON.stringify([draft.sampleInput || `用 ${draft.name} 处理一份测试材料`])}。skillVersion 必须是上面这种带双引号的 JSON 字符串，绝不能写成 {"major":1,"minor":0,"patch":0} 对象。SKILL.md 必须链接该 manifest，并在正文重复“读取只限当前 Vault、按需读取相关内容、写入一次原子确认、不覆盖”的关键边界，不能只把安全规则放在 manifest。
4. ${inputScopeRequirement}
5. 本版禁止生成 scripts；材料不足时先通过对话说明缺什么，不得猜测。所有 Vault 路径必须可移植：原始素材用 $RAW/，知识库用 $WIKI/，AI 产出用 $OUTPUT/；不要把 raw/wiki/output 或 01_Raw/02_Wiki/04_Output 写成固定字面目录。create-artifact 只用于 HTML/DOCX/PDF/PPTX/XLSX 成品，路径必须使用 $OUTPUT/ 开头并由用户确认。
6. 只输出一个 <<<新建Skill>>> 文件夹协议，等待我确认，不要改动任何现有文件。`
}

const SKILL_MANIFEST_PATH = 'references/ai-linzi-skill-manifest.json'

/**
 * 外部 Skill 常把作者自己的 01_Raw/02_Wiki/04_Output 写死。只改明确位于
 * 路径边界的三类目录，不碰普通英文单词（例如 draw/outputting），让同一份
 * Skill 可以在不同用户的 Vault 别名设置下运行。
 */
function portableVaultPaths(content: string): { content: string; changed: boolean } {
  let changed = false
  const replace = (pattern: RegExp, alias: string) => {
    content = content.replace(pattern, (_match, prefix: string) => {
      changed = true
      return `${prefix}${alias}/`
    })
  }
  replace(/(^|[^\p{L}\p{N}_$])(?:01_Raw|raw)\//gimu, '$RAW')
  replace(/(^|[^\p{L}\p{N}_$])(?:02_Wiki|wiki)\//gimu, '$WIKI')
  replace(/(^|[^\p{L}\p{N}_$])(?:04_Output|output)\//gimu, '$OUTPUT')
  return { content, changed }
}

/**
 * 大模型常把语义版本写成 { major, minor, patch } 对象。它表达的信息完整、
 * 修复规则又是唯一的，因此在确认卡前本机转成跨端约定的 "1.0.0" 字符串；
 * 其他缺字段或含糊值仍交给严格校验拦下，不能替模型猜。
 */
export function normalizeGeneratedSkillManifest(block: CreateLocalSkillBlock): {
  block: CreateLocalSkillBlock
  repairs: string[]
} {
  let pathsChanged = false
  const portableFiles = block.files.map((file) => {
    const normalized = portableVaultPaths(file.content)
    pathsChanged ||= normalized.changed
    return normalized.changed ? { ...file, content: normalized.content } : file
  })
  const portableEntry = portableFiles.find((file) => file.path === 'SKILL.md')
  const portableFallback = portableVaultPaths(block.content)
  pathsChanged ||= portableFallback.changed
  const workingBlock: CreateLocalSkillBlock = pathsChanged
    ? {
        ...block,
        content: portableEntry?.content ?? portableFallback.content,
        files: portableFiles,
      }
    : block
  const initialRepairs = pathsChanged
    ? ['已把固定 Raw/Wiki/Output 路径改为可移植变量']
    : []
  const manifestIndex = workingBlock.files.findIndex(
    (item) => item.path === SKILL_MANIFEST_PATH,
  )
  if (manifestIndex < 0) {
    // 没有 manifest 的纯文本 Skill 默认获得当前整个 Vault 的按需读取能力。包含
    // scripts 的包不能靠猜测 programs 权限自动放行，仍保留为不可安装状态。
    if (workingBlock.files.some((item) => item.path.startsWith('scripts/'))) {
      return { block: workingBlock, repairs: initialRepairs }
    }
    const output = localSkillOutputFromMarkdown(workingBlock.content)
    const outputPermission = output === 'chat'
      ? '只在聊天中输出，不写文件'
      : output === 'create-artifact'
        ? '确认后只生成一个本机成品文件，不覆盖'
        : output === 'update-current-note'
          ? '确认后只更新发送时锁定的当前笔记，不静默覆盖'
          : '确认后只新建 Markdown，不覆盖'
    const permissions = [
      '默认可按需搜索和读取整个 Vault；优先使用用户点名的文件或文件夹',
      outputPermission,
      '不运行本机程序',
      '不额外联网',
    ]
    const manifest = {
      schemaVersion: 2,
      skillVersion: '1.0.0',
      createdWith: 'AI霖子 Skill Studio',
      adaptedFrom: 'external-skill-without-manifest',
      permissions,
      vaultRead: skillReadPolicy('whole-vault', true),
      vaultWrite: {
        mode: output,
        confirmation: 'single-atomic-plan',
        overwrite: false,
      },
      network: 'ai-linzi-only',
      programs: [],
      sampleInputs: [`用 ${workingBlock.name} Skill 处理当前笔记`],
    }
    const manifestLink = `[权限与版本](${SKILL_MANIFEST_PATH})`
    let skillContent = workingBlock.content.includes(SKILL_MANIFEST_PATH)
      ? workingBlock.content
      : `${workingBlock.content.trim()}\n\n## AI霖子兼容权限\n- ${manifestLink}\n- 默认可按需读取整个 Vault；优先搜索点名范围；写入前一次原子确认；不覆盖未知同名文件。`
    const unlinkedReferences = workingBlock.files
      .filter((item) =>
        item.path.startsWith('references/') &&
        item.path !== SKILL_MANIFEST_PATH &&
        !skillContent.includes(item.path),
      )
      .map((item) => item.path)
    if (unlinkedReferences.length > 0) {
      const links = unlinkedReferences
        .map((path) => `- [${path.replace(/^references\//u, '')}](${path})`)
        .join('\n')
      skillContent = `${skillContent.trim()}\n\n## AI霖子参考文件\n${links}`
    }
    const files = [
      ...workingBlock.files.map((file) =>
        file.path === 'SKILL.md' ? { ...file, content: skillContent } : file,
      ),
      { path: SKILL_MANIFEST_PATH, content: JSON.stringify(manifest, null, 2) },
    ]
    return {
      block: { ...workingBlock, content: skillContent, files },
      repairs: [
        ...initialRepairs,
        '缺少权限清单，已补充 AI霖子兼容 manifest（默认按需读取整个 Vault）',
        ...(unlinkedReferences.length > 0
          ? [`已补充 ${unlinkedReferences.length} 个遗漏的 reference 链接`]
          : []),
      ],
    }
  }
  try {
    const value = JSON.parse(workingBlock.files[manifestIndex].content) as Record<string, unknown>
    const repairs: string[] = [...initialRepairs]
    const version = value.skillVersion
    if (version && typeof version === 'object' && !Array.isArray(version)) {
      const parts = ['major', 'minor', 'patch'].map((key) =>
        (version as Record<string, unknown>)[key],
      )
      if (parts.every((part) => Number.isInteger(part) && Number(part) >= 0)) {
        const normalizedVersion = parts.map(Number).join('.')
        value.skillVersion = normalizedVersion
        repairs.push(`已把 skillVersion 自动规范为 ${normalizedVersion}`)
      }
    }

    // 试运行输入只负责给“立即试运行”按钮填一句示例话术，不会扩大读取或
    // 写入权限。模型偶尔会生成空数组；为此拒绝整个已完整生成的 Skill 包
    // 对用户没有帮助，因此本机补一条固定、可见、可修改的点名调用示例。
    const sampleInputs = value.sampleInputs
    if (
      sampleInputs === undefined ||
      (Array.isArray(sampleInputs) && !sampleInputs.some(
        (item) => typeof item === 'string' && Boolean(item.trim()),
      ))
    ) {
      const sampleInput = `用 ${workingBlock.name} 处理当前打开的材料`
      value.sampleInputs = [sampleInput]
      repairs.push(`已补充试运行输入：${sampleInput}`)
    }

    let skillContent = workingBlock.content
    if (!skillContent.includes(SKILL_MANIFEST_PATH)) {
      skillContent = `${skillContent.trim()}\n\n## AI霖子兼容权限\n- [权限与版本](${SKILL_MANIFEST_PATH})`
      repairs.push('已补充 SKILL.md 中遗漏的权限清单链接')
    }
    const unlinkedReferences = workingBlock.files
      .filter((item) =>
        item.path.startsWith('references/') &&
        item.path !== SKILL_MANIFEST_PATH &&
        !skillContent.includes(item.path),
      )
      .map((item) => item.path)
    if (unlinkedReferences.length > 0) {
      const links = unlinkedReferences
        .map((path) => `- [${path.replace(/^references\//u, '')}](${path})`)
        .join('\n')
      skillContent = `${skillContent.trim()}\n\n## AI霖子参考文件\n${links}`
      repairs.push(`已补充 ${unlinkedReferences.length} 个遗漏的 reference 链接`)
    }
    // 普通的“## 输出方式”说明段落不是机器可执行声明。只有标题下一行明确写了
    // chat/create-note/update-current-note/create-artifact，才算已有输出路由；否则
    // 仍要补上 AI霖子的确定性声明，避免 Skill 创建成功后静默退回聊天输出。
    const hasExecutableOutput =
      /^#{1,6}\s*(?:AI\s*霖子\s*)?输出方式\s*$\r?\n\s*`?(?:chat|create-note|update-current-note|create-artifact|新建笔记|创建笔记|更新当前笔记|修改当前笔记|生成成品|生成HTML看板|生成交互看板)`?\s*$/imu.test(
        skillContent,
      )
    if (!hasExecutableOutput) {
      const permissions = Array.isArray(value.permissions)
        ? value.permissions.filter((item): item is string => typeof item === 'string')
        : []
      // 先尊重正文中明确写出的输出路由。模型常写成“输出方式为
      // `create-note`”，而不是标准标题；同时又会在能力边界里写“不会生成
      // HTML”。如果直接对整篇正文搜索 HTML，会把这种否定说明误判成
      // create-artifact，造成同一份 Skill 自相矛盾。
      const inlineOutput = skillContent.match(
        /(?:输出方式|输出路由)\s*(?:为|是|[:：])\s*`?(chat|create-note|update-current-note|create-artifact|新建笔记|创建笔记|更新当前笔记|修改当前笔记|生成成品|生成HTML看板|生成交互看板)`?/iu,
      )?.[1]
      const normalizedInlineOutput = inlineOutput
        ? /^(?:新建笔记|创建笔记)$/u.test(inlineOutput)
          ? 'create-note'
          : /^(?:更新当前笔记|修改当前笔记)$/u.test(inlineOutput)
            ? 'update-current-note'
            : /^(?:生成成品|生成HTML看板|生成交互看板)$/u.test(inlineOutput)
              ? 'create-artifact'
              : inlineOutput
        : ''
      const output = normalizedInlineOutput || (
        /(?:html|dashboard|看板|交互成品|本机成品文件)/iu.test(
          `${workingBlock.description}\n${permissions.join('\n')}`,
        )
          ? 'create-artifact'
          : permissions.some((item) => /(?:write|create|update|sync|写入|创建|更新|同步)/iu.test(item))
            ? 'create-note'
            : 'chat'
      )
      skillContent = `${skillContent.trim()}\n\n## AI霖子输出方式\n${output}`
      repairs.push(`已补充输出方式：${output}`)
    }

    if (value.schemaVersion === 2) {
      // Skill Creator 偶尔会生成“看起来是 v2”但缺 vaultRead/vaultWrite
      // 的半成品。这两项的修复结果是唯一的：读取默认到当前整个
      // Vault；写入方式从 SKILL.md 已展示的输出声明确定，仍需一次原子确认且不覆盖。
      const output = localSkillOutputFromMarkdown(skillContent)
      const expectedVaultRead = skillReadPolicy('whole-vault', true)
      const currentVaultRead = value.vaultRead && typeof value.vaultRead === 'object' &&
        !Array.isArray(value.vaultRead)
        ? value.vaultRead as Record<string, unknown>
        : undefined
      if (
        !currentVaultRead ||
        currentVaultRead.scope !== 'whole-vault' ||
        currentVaultRead.metadataDiscovery !== true ||
        currentVaultRead.preferUserScope !== true ||
        currentVaultRead.fallbackToWholeVault !== true ||
        currentVaultRead.maxFiles !== 120 ||
        currentVaultRead.fixedFolder !== undefined
      ) {
        value.vaultRead = expectedVaultRead
        repairs.push('已把读取权限统一为按需搜索整个 Vault')
      }
      const expectedVaultWrite = {
        mode: output,
        confirmation: 'single-atomic-plan',
        overwrite: false,
      }
      const currentVaultWrite = value.vaultWrite && typeof value.vaultWrite === 'object' &&
        !Array.isArray(value.vaultWrite)
        ? value.vaultWrite as Record<string, unknown>
        : undefined
      if (
        !currentVaultWrite ||
        currentVaultWrite.mode !== output ||
        currentVaultWrite.confirmation !== 'single-atomic-plan' ||
        currentVaultWrite.overwrite !== false
      ) {
        value.vaultWrite = expectedVaultWrite
        repairs.push(`已按 SKILL.md 补充写入权限：${output}`)
      }
      const currentPermissions = Array.isArray(value.permissions)
        ? value.permissions.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        : []
      if (currentPermissions.length === 0) {
        value.permissions = [
          skillReadScopePermission('whole-vault'),
          '读取权限仅限当前 Obsidian Vault，不包含电脑其他目录',
          importedSkillOutputPermission(output),
          '不运行本机程序',
          '不额外联网',
        ]
        repairs.push('已补充可展示的权限清单')
      } else if (!currentPermissions.some((item) => /(?:整个|全部|所有|全库|整库).{0,16}(?:Vault|知识库|仓库)/iu.test(item))) {
        value.permissions = [skillReadScopePermission('whole-vault'), ...currentPermissions]
        repairs.push('已在权限清单中明确整个 Vault 读取范围')
      }
      if (value.network !== 'none' && value.network !== 'ai-linzi-only') {
        value.network = 'ai-linzi-only'
        repairs.push('已补充 AI霖子专用网络边界')
      }
      const scripts = workingBlock.files.filter((item) => item.path.startsWith('scripts/'))
      if (!Array.isArray(value.programs) && scripts.length === 0) {
        value.programs = []
        repairs.push('已补充空的本机程序清单')
      }
      if (value.createdWith !== 'AI霖子 Skill Studio') {
        if (typeof value.createdWith === 'string' && value.createdWith.trim()) {
          value.adaptedFrom = value.createdWith.trim()
        }
        value.createdWith = 'AI霖子 Skill Studio'
        repairs.push('已补充 AI霖子 Skill Studio 兼容声明')
      }
      if (value.skillVersion === undefined) {
        value.skillVersion = '1.0.0'
        repairs.push('已补充 skillVersion：1.0.0')
      }
    }

    if (value.schemaVersion === 1) {
      const legacy = parseLocalSkillManifest(
        workingBlock.files[manifestIndex].content,
        localSkillOutputFromMarkdown(skillContent),
      )
      if (legacy.kind === 'valid') {
        const inferredSingleInput = legacy.policy.vaultRead.scope === 'user-specified-files' &&
          /(?:只读取|一次只处理|最多读取).{0,36}(?:当前|单篇|一篇|一份|1\s*个文件)/iu.test(skillContent)
        const vaultReadScope: LocalSkillVaultReadScope = inferredSingleInput
          ? 'current-note'
          : legacy.policy.vaultRead.scope
        value.schemaVersion = 2
        value.vaultRead = skillReadPolicy(
          vaultReadScope,
          true,
          inferredSingleInput ? undefined : legacy.policy.vaultRead.fixedFolder,
        )
        value.vaultWrite = legacy.policy.vaultWrite
        value.network = legacy.policy.network
        repairs.push('已把旧版文字权限清单升级为机器可读权限合同')
      }
    }

    if (repairs.length === 0) return { block: workingBlock, repairs }
    const files = workingBlock.files.map((file, index) =>
      file.path === 'SKILL.md'
        ? { ...file, content: skillContent }
        : index === manifestIndex
        ? { ...file, content: JSON.stringify(value, null, 2) }
        : file,
    )
    return {
      block: { ...workingBlock, content: skillContent, files },
      repairs,
    }
  } catch {
    return { block: workingBlock, repairs: initialRepairs }
  }
}

function importedSkillOutputPermission(output: SkillStudioOutput): string {
  if (output === 'chat') return '只在聊天中输出，不写文件'
  if (output === 'create-artifact') return '确认后只生成一个本机成品文件，不覆盖'
  if (output === 'update-current-note') return '确认后只更新发送时锁定的当前笔记，不静默覆盖'
  return '确认后只新建 Markdown，不覆盖'
}

/** 外部 Skill 默认授权当前整个 Vault；新安装不保留固定文件夹权限。 */
export function importedSkillReadScope(_block: CreateLocalSkillBlock): LocalSkillVaultReadScope {
  return 'whole-vault'
}

export function importedSkillFixedFolder(_block: CreateLocalSkillBlock): string | undefined {
  return undefined
}

function replaceCompatibilitySection(content: string, section: string): string {
  const pattern = /\n## AI霖子兼容权限\s*\n[\s\S]*?(?=\n##\s|\s*$)/u
  if (pattern.test(content)) return content.replace(pattern, `\n${section}`)
  return `${content.trim()}\n\n${section}`
}

/**
 * 外部 Skill 没有 AI霖子 manifest 时，本机按整个 Vault 生成可见权限合同。
 * 即使包内有脚本也只完成安装适配：本地程序总开关
 * 仍默认关闭，运行时仍逐步确认，绝不因导入而执行。
 */
export function adaptImportedSkillReadScope(
  sourceBlock: CreateLocalSkillBlock,
  _scope: LocalSkillVaultReadScope,
  _fixedFolder?: string,
): { block: CreateLocalSkillBlock; repairs: string[] } {
  const scope: LocalSkillVaultReadScope = 'whole-vault'
  const firstPass = normalizeGeneratedSkillManifest(sourceBlock)
  const block = firstPass.block
  const manifestFile = block.files.find((item) => item.path === SKILL_MANIFEST_PATH)
  let previous: Record<string, unknown> = {}
  if (manifestFile) {
    try {
      const parsed: unknown = JSON.parse(manifestFile.content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        previous = parsed as Record<string, unknown>
      }
    } catch {
      // 用户已经在导入弹窗明确授权；损坏的外部 manifest 由本机重建为最小合同。
    }
  }
  const output = localSkillOutputFromMarkdown(block.content)
  const scripts = block.files
    .filter((item) => item.path.startsWith('scripts/'))
    .map((item) => item.path)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const previousVersion = typeof previous.skillVersion === 'string' &&
    /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(previous.skillVersion)
    ? previous.skillVersion
    : '1.0.0'
  const sampleInput = skillTestInputForReadScope(block.name, scope)
  const normalizedFolder = undefined
  const permissions = [
    skillReadScopePermission(scope, normalizedFolder),
    '读取权限仅限当前 Obsidian Vault，不包含电脑其他目录',
    importedSkillOutputPermission(output),
    scripts.length > 0
      ? `包含 ${scripts.length} 个本机脚本；导入时不执行，开启本地程序后每一步仍需确认`
      : '不运行本机程序',
    scripts.length > 0
      ? '脚本如声明联网，会在该步确认卡中明确提示'
      : '不额外联网',
  ]
  const manifest = {
    schemaVersion: 2,
    skillVersion: previousVersion,
    createdWith: 'AI霖子 Skill Studio',
    adaptedFrom: typeof previous.createdWith === 'string'
      ? previous.createdWith
      : 'external-skill',
    permissions,
    vaultRead: skillReadPolicy(scope, false, normalizedFolder),
    vaultWrite: {
      mode: output,
      confirmation: 'single-atomic-plan',
      overwrite: false,
    },
    network: 'ai-linzi-only',
    programs: scripts,
    sampleInputs: [sampleInput],
  }
  const compatibilitySection = [
    '## AI霖子兼容权限',
    `- [权限与版本](${SKILL_MANIFEST_PATH})`,
    `- ${skillReadScopePermission(scope, normalizedFolder)}`,
    '- 权限上限是当前 Obsidian Vault，不能访问 Vault 外的电脑文件。',
    '- 全库搜索只在本机用目录和索引筛选候选，只向 AI 提交完成任务所需的文件正文。',
    `- ${importedSkillOutputPermission(output)}；写入使用一次原子确认。`,
    scripts.length > 0
      ? `- 包含 ${scripts.length} 个本机脚本；安装不等于运行，程序默认关闭且每一步仍需确认。`
      : '- 不运行本机程序。',
    ...(scripts.length > 0 ? ['- 脚本如声明联网，会在该步确认卡中明确提示。'] : []),
  ].join('\n')
  const skillContent = replaceCompatibilitySection(block.content, compatibilitySection)
  const files = block.files
    .filter((item) => item.path !== SKILL_MANIFEST_PATH)
    .map((item) => item.path === 'SKILL.md' ? { ...item, content: skillContent } : item)
  files.push({ path: SKILL_MANIFEST_PATH, content: JSON.stringify(manifest, null, 2) })
  const secondPass = normalizeGeneratedSkillManifest({ ...block, content: skillContent, files })
  const repairs = [
    ...firstPass.repairs.filter((item) => !/最低权限兼容 manifest/u.test(item)),
    `导入时已选择读取范围：${skillReadScopePermission(scope)}`,
    ...(scripts.length > 0 ? [`已登记 ${scripts.length} 个脚本；不会自动运行`] : []),
    ...secondPass.repairs,
  ]
  return { block: secondPass.block, repairs: [...new Set(repairs)] }
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
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
      problems.push('schemaVersion 必须为 1 或 2')
    }
    const runtimeManifest = parseLocalSkillManifest(file.content, localSkillOutputFromMarkdown(block.content))
    if (runtimeManifest.kind === 'invalid') problems.push(runtimeManifest.message)
    if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) {
      problems.push('skillVersion 必须是三段版本号，且每段不超过 9 位')
    }
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

import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/create-local-skill.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const skill = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

console.log('[test-create-local-skill]')

assert.equal(skill.shouldContinuePendingSkillDraft('OK，更新 skill 吧', 'update', 'course-notes'), true)
assert.equal(skill.shouldContinuePendingSkillDraft('修改 course-notes Skill', 'update', 'course-notes'), true)
assert.equal(skill.shouldContinuePendingSkillDraft('修改 another-skill Skill', 'update', 'course-notes'), false)
assert.equal(skill.shouldContinuePendingSkillDraft('更新 skill 吧', 'none', 'course-notes'), false)

const portable = `---
name: consultation-brief
description: 把咨询逐字稿整理成客户可读简报
---
# 咨询简报

## 何时使用
用户需要把咨询记录整理成简报时使用。

## AI霖子输出方式
create-note`

{
  const text =
    `我已经整理成可复用工作流，请确认创建。\n` +
    `<<<新建Skill name=consultation-brief>>>\n${portable}\n<<<新建Skill结束>>>`
  const result = skill.extractCreateLocalSkillBlocks(text)
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0].name, 'consultation-brief')
  assert.equal(result.blocks[0].description, '把咨询逐字稿整理成客户可读简报')
  assert.equal(result.blocks[0].content, portable)
  assert.deepEqual(result.blocks[0].files, [{ path: 'SKILL.md', content: portable }])
  assert.ok(!result.cleanText.includes('<<<'))
  console.log('  ✓ 标准 Skill 提取与标记剥离')
}

{
  const bundle = `<<<新建Skill name=customer-profile>>>
<<<Skill文件 path=SKILL.md>>>
---
name: customer-profile
description: 按统一模板创建或更新客户档案
---
# 客户档案管理

## AI霖子自动调用
- 创建客户档案

## AI霖子模板校验
[模板](references/客户档案模板.md)
<<<Skill文件结束>>>
<<<Skill文件 path=references/客户档案模板.md>>>
---
客户称呼: "{{客户称呼}}"
---
# {{客户称呼}}
<<<Skill文件结束>>>
<<<新建Skill结束>>>`
  const result = skill.extractCreateLocalSkillBlocks(bundle)
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0].files.length, 2)
  assert.equal(result.blocks[0].files[1].path, 'references/客户档案模板.md')
  assert.equal(skill.normalizeSkillBundlePath('../secret.md'), null)
  assert.equal(skill.normalizeSkillBundlePath('assets/theme.css'), 'assets/theme.css')
  assert.equal(skill.normalizeSkillBundlePath('bin/run.exe'), null)
  console.log('  ✓ 完整 Skill 文件夹与 references 安全提取')
}

{
  const bundle = `这套做法以后可以重复调用，确认后才会写入。
<<<新建Skill name=agent2-interview-review>>>
<<<Skill文件 path=SKILL.md>>>
---
name: agent2-interview-review
description: 提炼访谈背景、核心问题与行动项并输出复盘
---
# 学员访谈复盘

按[复盘模板](references/interview-review-template.md)输出。
<<<Skill文件结束>>>
<<<Skill文件 path=references/interview-review-template.md>>>
# 复盘模板

- 背景
- 核心问题
- 行动项
<<<Skill文件结束>>>
<<<Skill文件 path=references/ai-linzi-skill-manifest.json>>>
{"schemaVersion":1,"skillVersion":"1.0.0","permissions":["读取用户提供的访谈"],"programs":[],"sampleInputs":["复盘这份访谈"]}
<<<Skill文件结束>>>
<<<新建Skill结束>>>`
  const result = skill.extractCreateLocalSkillBlocks(bundle)
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0].files.length, 3)
  assert.doesNotMatch(result.cleanText, /<<<新建Skill|<<<Skill文件/)
  console.log('  ✓ 主对话自然创建的完整三文件协议被隐藏并渲染为确认卡')
}

{
  const malformedBundle = `<<<新建Skill name=course-transcript-knowledge>>>
<<<Skill文件 path=SKILL.md>>>
---
name: course-transcript-knowledge
description: 把课程逐字稿整理成可复用课程笔记
---
# 课程逐字稿整理

[模板](references/course-note-template.md)
<<<Skill文件结束>>>
<<<新建Skill path=references/course-note-template.md>>>
# 课程笔记模板
<<<Skill文件结束>>>
<<<新建Skill path=references/ai-linzi-skill-manifest.json>>>
{"schemaVersion":2,"skillVersion":"1.0.0"}
<<<Skill文件结束>>>
<<<新建Skill结束>>>`
  const result = skill.extractCreateLocalSkillBlocks(malformedBundle)
  assert.equal(result.blocks.length, 1, '生产真实出现的子文件起始标记笔误应确定性修复')
  assert.equal(result.blocks[0].files.length, 3)
  assert.equal(result.repairedFileMarkers, 2)
  assert.equal(result.invalidBlocks, 0)
  assert.deepEqual(result.candidateNames, ['course-transcript-knowledge'])
  console.log('  ✓ 常见子文件标记笔误经原路径安全校验后自修复')
}

{
  const unsafeBundle = `<<<新建Skill name=customer-profile>>>
<<<Skill文件 path=SKILL.md>>>
---
name: customer-profile
description: 测试
---
# 测试
<<<Skill文件结束>>>
<<<Skill文件 path=../secret.md>>>
越界
<<<Skill文件结束>>>
<<<新建Skill结束>>>`
  const result = skill.extractCreateLocalSkillBlocks(unsafeBundle)
  assert.equal(result.blocks.length, 0)
  assert.equal(result.invalidBlocks, 1)
  console.log('  ✓ Skill 子文件越界整包拒绝')
}

{
  assert.equal(skill.isPortableSkillName('weekly-review'), true)
  assert.equal(skill.isPortableSkillName('周复盘'), false)
  assert.equal(skill.isPortableSkillName('../weekly-review'), false)
  assert.equal(skill.isPortableSkillName('Weekly_Review'), false)
  console.log('  ✓ 可移植名称限制')
}

{
  const extraField = portable.replace(
    'description: 把咨询逐字稿整理成客户可读简报',
    'description: 把咨询逐字稿整理成客户可读简报\noutput: create-note',
  )
  assert.equal(
    skill.parsePortableSkillContent('consultation-brief', extraField),
    null,
    '额外私有 frontmatter 字段必须拒绝',
  )
  assert.equal(
    skill.parsePortableSkillContent('weekly-review', portable),
    null,
    '标记名与 frontmatter name 不一致必须拒绝',
  )
  console.log('  ✓ 只允许 name/description 且名称一致')
}

{
  const malicious =
    '<<<新建Skill name=../../etc>>>\n---\nname: ../../etc\ndescription: bad\n---\n# bad\n<<<新建Skill结束>>>'
  const result = skill.extractCreateLocalSkillBlocks(malicious)
  assert.equal(result.blocks.length, 0)
  assert.ok(!result.cleanText.includes('<<<'), '非法块也应从展示文本剥离')
  console.log('  ✓ 路径注入被拒绝')
}

console.log('[test-create-local-skill] 全部通过')

// 创建与更新共同组成 Skill Studio 的本地写入边界；主门禁从这里串起更新协议、
// 事务失败注入和真实 DOM 确认卡测试，避免新增测试只在开发者手工运行时生效。
await import('./test-skill-update-core.mjs')
await import('./test-skill-update-transaction.mjs')
await import('./test-skill-update-card.mjs')

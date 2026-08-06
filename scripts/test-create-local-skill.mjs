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
  assert.ok(!result.cleanText.includes('<<<'))
  console.log('  ✓ 标准 Skill 提取与标记剥离')
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

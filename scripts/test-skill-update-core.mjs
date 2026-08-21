import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/skill-update-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const update = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

console.log('[test-skill-update-core]')

assert.equal(update.isSkillSemver('1.2.3'), true)
assert.equal(update.isSkillSemver('123456789.0.1'), true)
assert.equal(update.isSkillSemver('1234567890.0.1'), false)
assert.ok(Number.isNaN(update.compareSkillSemver('1234567890.0.1', '1.0.0')))
console.log('  ✓ 三段版本号数值与快照路径有界，超长数字不能制造 Infinity 绕过比较')

const skillMd = `---
name: weekly-review
description: 把每周资料整理成复盘
---
# 周复盘

## 何时使用
用户明确要求复盘时使用。`

const manifest = (version) => JSON.stringify({ schemaVersion: 1, skillVersion: version }, null, 2)

const validProposal = {
  name: 'weekly-review',
  expectedBaseVersion: '1.0.0',
  reason: '增加固定复盘结构，并删除已经废弃的参考文件。',
  writeFiles: [
    { path: 'SKILL.md', content: skillMd },
    { path: 'references/ai-linzi-skill-manifest.json', content: manifest('1.1.0') },
    { path: 'references/template.md', content: '# 新模板' },
  ],
  deleteFiles: ['references/legacy.md'],
}

{
  const wire = update.formatSkillUpdateProposal(validProposal)
  const result = update.extractSkillUpdateProposals(`更新说明。\n${wire}\n请确认。`)
  assert.equal(result.proposals.length, 1)
  assert.equal(result.invalidBlocks, 0)
  assert.equal(result.cleanText, '更新说明。\n\n请确认。')
  assert.deepEqual(result.proposals[0], validProposal)
  assert.equal(update.proposalNextVersion(result.proposals[0]), '1.1.0')
  console.log('  ✓ 标准更新包提取、剥离与版本读取')
}

{
  const unsafeWrites = [
    '../secret.md',
    '/absolute.md',
    '.versions/old/metadata.json',
    'references/.hidden.md',
    'scripts/run.js',
    'assets/run.exe',
  ]
  for (const path of unsafeWrites) assert.equal(update.normalizeSkillUpdateWritePath(path), null, path)
  assert.equal(update.normalizeSkillUpdateWritePath('references/guide.md'), 'references/guide.md')
  assert.equal(update.normalizeSkillUpdateWritePath('assets/theme.css'), 'assets/theme.css')
  assert.equal(update.normalizeSkillUpdateWritePath('SKILL.md'), 'SKILL.md')
  console.log('  ✓ 写入路径拒绝越界、隐藏目录、脚本与二进制')
}

{
  const unsafeDeletes = [
    '../secret.md',
    'SKILL.md',
    'references/ai-linzi-skill-manifest.json',
    'references/.hidden.md',
    '.versions/old/metadata.json',
  ]
  for (const path of unsafeDeletes) assert.equal(update.normalizeSkillUpdateDeletePath(path), null, path)
  assert.equal(update.normalizeSkillUpdateDeletePath('scripts/legacy.js'), 'scripts/legacy.js')
  assert.equal(update.normalizeSkillUpdateDeletePath('assets/old.png'), 'assets/old.png')
  console.log('  ✓ 删除路径独立白名单且保护入口、版本清单与历史')
}

{
  const noManifest = {
    ...validProposal,
    writeFiles: validProposal.writeFiles.filter((file) => !file.path.endsWith('manifest.json')),
  }
  const sameVersion = {
    ...validProposal,
    writeFiles: validProposal.writeFiles.map((file) =>
      file.path.endsWith('manifest.json') ? { ...file, content: manifest('1.0.0') } : file,
    ),
  }
  const downVersion = {
    ...validProposal,
    writeFiles: validProposal.writeFiles.map((file) =>
      file.path.endsWith('manifest.json') ? { ...file, content: manifest('0.9.9') } : file,
    ),
  }
  for (const proposal of [noManifest, sameVersion, downVersion]) {
    const result = update.extractSkillUpdateProposals(update.formatSkillUpdateProposal(proposal))
    assert.equal(result.proposals.length, 0)
    assert.equal(result.invalidBlocks, 1)
  }
  console.log('  ✓ 缺版本清单、同版本与降级更新整包拒绝')
}

{
  const overlap = {
    ...validProposal,
    deleteFiles: ['references/template.md'],
  }
  const duplicate = update
    .formatSkillUpdateProposal(validProposal)
    .replace(
      '<<<Skill删除 path=references/legacy.md>>>',
      '<<<Skill删除 path=references/legacy.md>>>\n<<<Skill删除 path=references/legacy.md>>>',
    )
  for (const wire of [update.formatSkillUpdateProposal(overlap), duplicate]) {
    const result = update.extractSkillUpdateProposals(wire)
    assert.equal(result.proposals.length, 0)
    assert.equal(result.invalidBlocks, 1)
    assert.ok(!result.cleanText.includes('<<<更新Skill'), '非法完整块仍必须从用户可见文本剥离')
  }
  console.log('  ✓ 写删重叠与重复删除整包拒绝')
}

{
  const malformed = '先说明。\n<<<更新Skill name=weekly-review base=1.0.0>>>\n没有结束标记'
  const result = update.extractSkillUpdateProposals(malformed)
  assert.equal(result.proposals.length, 0)
  assert.equal(result.invalidBlocks, 1)
  console.log('  ✓ 残缺更新协议被识别为无效')
}

{
  const left = {
    sha256: 'tree',
    files: [{ path: 'SKILL.md', mtime: 100, size: 10, sha256: 'a' }],
  }
  assert.equal(update.skillTreeFingerprintsEqual(left, structuredClone(left)), true)
  assert.equal(
    update.skillTreeFingerprintsEqual(left, {
      ...left,
      files: [{ ...left.files[0], mtime: 101 }],
    }),
    false,
    '仅 mtime 改变也必须中止，防止确认期间被改写又还原文本',
  )
  assert.equal(
    update.skillTreeFingerprintsEqual(left, {
      ...left,
      files: [{ ...left.files[0], sha256: 'b' }],
    }),
    false,
  )
  console.log('  ✓ 确认前指纹同时锁定路径、mtime、大小与哈希')
}

console.log('[test-skill-update-core] 全部通过')

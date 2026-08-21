import assert from 'node:assert/strict'
import { build } from 'esbuild'

function makeEl(tag = 'div') {
  const el = { tag, cls: '', text: '', children: [], disabled: false, onclick: null }
  const child = (nextTag, options = {}) => {
    const next = makeEl(nextTag)
    next.cls = options.cls ?? ''
    next.text = options.text ?? ''
    el.children.push(next)
    return next
  }
  el.createEl = (nextTag, options) => child(nextTag, options)
  el.createDiv = (options) => child('div', options)
  el.createSpan = (options) => child('span', options)
  el.setText = (text) => { el.text = text }
  return el
}

function all(el, result = []) {
  for (const child of el.children) {
    result.push(child)
    all(child, result)
  }
  return result
}

const byText = (root, text) => all(root).find((item) => item.text === text)
const texts = (root) => all(root).map((item) => item.text).filter(Boolean)

const bundled = await build({
  entryPoints: ['src/skill-update-card.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const { renderSkillUpdateOffer } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)

console.log('[test-skill-update-card]')

const proposal = {
  name: 'weekly-review',
  expectedBaseVersion: '1.0.0',
  reason: '增加固定输出结构。',
  writeFiles: [],
  deleteFiles: ['assets/old.png'],
}
const prepared = {
  skillRoot: '05_System/Skills/weekly-review',
  entryPath: '05_System/Skills/weekly-review/SKILL.md',
  currentVersion: '1.0.0',
  nextVersion: '1.1.0',
  reason: proposal.reason,
  preparedAt: 1,
  proposalSha256: 'proposal',
  baseline: { sha256: 'tree', files: [] },
  changes: [
    { path: 'SKILL.md', kind: 'update', oldContent: '# 旧', newContent: '# 新' },
    { path: 'references/new.md', kind: 'create', newContent: '# 新参考' },
    { path: 'assets/old.png', kind: 'delete', oldSize: 128, oldSha256: 'abcdef1234567890' },
  ],
}
const oldVersion = {
  snapshotId: '20260822T010203000Z__1.0.0',
  metadata: {
    schemaVersion: 1,
    skillName: 'weekly-review',
    skillVersion: '1.0.0',
    archivedAt: '2026-08-22T01:02:03.000Z',
    archivedAtMs: Date.parse('2026-08-22T01:02:03.000Z'),
    sourceSnapshotHash: 'tree',
    reason: '旧版',
    files: [],
  },
}

function setup(overrides = {}) {
  const calls = { apply: 0, list: 0, prepareRestore: 0, restore: 0, persist: 0, rerender: 0, notices: [] }
  const host = {
    skillsRoot: () => overrides.root ?? '05_System/Skills',
    applyUpdate: overrides.applyUpdate ?? (async () => {
      calls.apply += 1
      return { snapshotId: oldVersion.snapshotId, previousVersion: '1.0.0', nextVersion: '1.1.0' }
    }),
    listVersions: async () => {
      calls.list += 1
      return overrides.listVersions ?? [oldVersion]
    },
    prepareRestore: overrides.prepareRestore ?? (async () => {
      calls.prepareRestore += 1
      return {
        skillRoot: prepared.skillRoot,
        skillName: proposal.name,
        snapshotId: oldVersion.snapshotId,
        targetVersion: '1.0.0',
        preparedAt: 1,
        baseline: prepared.baseline,
        targetFingerprint: prepared.baseline,
      }
    }),
    restore: overrides.restore ?? (async () => {
      calls.restore += 1
      return { safetySnapshotId: 'safe', restoredSnapshotId: oldVersion.snapshotId, restoredVersion: '1.0.0' }
    }),
    persist: async () => { calls.persist += 1 },
    rerender: () => { calls.rerender += 1 },
    notify: (message) => calls.notices.push(message),
  }
  const message = {
    skillUpdateOffer: {
      proposal: structuredClone(proposal),
      prepared: structuredClone(prepared),
      versions: structuredClone(overrides.versions ?? []),
    },
  }
  return { host, calls, message, row: makeEl() }
}

{
  const { host, message, row } = setup()
  renderSkillUpdateOffer(host, row, message)
  assert.ok(byText(row, '🧩 待更新 AI 工作流：weekly-review'))
  assert.ok(byText(row, '版本 1.0.0 → 1.1.0 · 3 处实际变化'))
  assert.ok(byText(row, '修改前全文'))
  assert.ok(byText(row, '修改后全文'))
  assert.ok(byText(row, '新增全文'))
  assert.ok(texts(row).some((text) => text.includes('二进制文件 · 128 bytes · SHA-256 abcdef123456')))
  assert.ok(texts(row).some((text) => text.includes('不会上传到 AI霖子服务器')))
  assert.equal(byText(row, '应用更新到 1.1.0').disabled, true)
  console.log('  ✓ 全文前后预览、二进制指纹与本机历史边界')
}

{
  const { host, calls, message, row } = setup()
  renderSkillUpdateOffer(host, row, message)
  const confirm = byText(row, '单独确认删除 1 个文件')
  const apply = byText(row, '应用更新到 1.1.0')
  confirm.onclick()
  assert.equal(confirm.text, '✅ 已确认删除清单')
  assert.equal(apply.disabled, false)
  apply.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.apply, 1)
  assert.equal(calls.list, 1)
  assert.equal(calls.persist, 1)
  assert.equal(calls.rerender, 1)
  assert.equal(message.skillUpdateOffer.applied.nextVersion, '1.1.0')
  console.log('  ✓ 删除必须单独确认，更新成功后刷新历史并落盘')
}

{
  const { host, calls, message, row } = setup({ root: '99_New/Skills' })
  renderSkillUpdateOffer(host, row, message)
  byText(row, '单独确认删除 1 个文件').onclick()
  const apply = byText(row, '应用更新到 1.1.0')
  apply.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.apply, 0)
  assert.equal(apply.disabled, false)
  assert.ok(calls.notices.some((notice) => notice.includes('目录已经变化')))
  console.log('  ✓ Skills 设置中途变化时零写入')
}

{
  const { host, calls, message, row } = setup({
    applyUpdate: async () => { throw new Error('版本冲突') },
  })
  renderSkillUpdateOffer(host, row, message)
  byText(row, '单独确认删除 1 个文件').onclick()
  const apply = byText(row, '应用更新到 1.1.0')
  apply.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(apply.disabled, false)
  assert.equal(calls.persist, 0)
  assert.ok(calls.notices.some((notice) => notice === 'Skill 更新失败：版本冲突'))
  console.log('  ✓ 更新失败后按钮恢复且不落盘')
}

{
  const { host, calls, message, row } = setup({ versions: [oldVersion] })
  renderSkillUpdateOffer(host, row, message)
  const restore = byText(row, '恢复 1.0.0')
  restore.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.prepareRestore, 1)
  assert.equal(calls.restore, 0, '第一次点击只能预检，不能恢复')
  assert.equal(restore.text, '确认恢复到 1.0.0')
  assert.equal(restore.disabled, false)
  restore.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.restore, 1)
  assert.equal(calls.persist, 1)
  assert.equal(calls.rerender, 1)
  assert.equal(message.skillUpdateOffer.restored.restoredVersion, '1.0.0')
  console.log('  ✓ 历史恢复使用两次确认并在成功后落盘')
}

{
  const { host, calls, message, row } = setup({
    versions: [oldVersion],
    prepareRestore: async () => { throw new Error('快照损坏') },
  })
  renderSkillUpdateOffer(host, row, message)
  const restore = byText(row, '恢复 1.0.0')
  restore.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(restore.disabled, false)
  assert.equal(restore.text, '恢复 1.0.0')
  assert.equal(calls.persist, 0)
  assert.ok(calls.notices.some((notice) => notice === '恢复失败：快照损坏'))
  console.log('  ✓ 恢复预检失败后恢复可点且不改状态')
}

{
  const { host, message, row } = setup()
  message.skillUpdateOffer.applied = {
    snapshotId: oldVersion.snapshotId,
    previousVersion: '1.0.0',
    nextVersion: '1.1.0',
  }
  renderSkillUpdateOffer(host, row, message)
  assert.ok(byText(row, '✅ 已更新到 1.1.0'))
  assert.ok(!byText(row, '应用更新到 1.1.0'))
  console.log('  ✓ 已更新卡不再重复提供应用按钮')
}

console.log('[test-skill-update-card] 全部通过')

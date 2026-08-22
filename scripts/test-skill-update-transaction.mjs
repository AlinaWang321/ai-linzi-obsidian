import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

globalThis.crypto ??= webcrypto

const bundled = await build({
  entryPoints: ['src/skill-update-transaction.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const tx = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

console.log('[test-skill-update-transaction]')

assert.match(
  tx.skillTreeResourceLimitError(
    Array.from({ length: 113 }, (_, index) => ({ path: `assets/${index}.bin`, size: 1 })),
  ),
  /超过安全上限 112 个/,
)
assert.match(
  tx.skillTreeResourceLimitError([{ path: 'assets/huge.bin', size: 50 * 1024 * 1024 + 1 }]),
  /单文件 50 MB/,
)
assert.match(
  tx.skillTreeResourceLimitError([
    { path: 'assets/a.bin', size: 50 * 1024 * 1024 },
    { path: 'assets/b.bin', size: 50 * 1024 * 1024 },
    { path: 'assets/c.bin', size: 1 },
  ]),
  /整包更新安全上限/,
)
console.log('  ✓ 更新在读取二进制前限制文件数、单文件与整包体积')
const vaultHostSource = await readFile(new URL('../src/skill-update-vault.ts', import.meta.url), 'utf8')
assert.ok(
  vaultHostSource.indexOf('skillTreeResourceLimitError(') < vaultHostSource.indexOf('vault.readBinary(file)'),
  '真实 Vault Host 必须在读取任何二进制前完成资源限额检查',
)
assert.doesNotMatch(
  vaultHostSource,
  /createSnapshot|listSnapshots|readSnapshot|removeSnapshot|metadata\.json/,
  '新版 Vault Host 不得再创建或管理 Skill 历史副本',
)

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const manifest = (version) => JSON.stringify({ schemaVersion: 1, skillVersion: version }, null, 2)
const skillMd = (suffix = '') => `---
name: weekly-review
description: 把每周资料整理成复盘${suffix}
---
# 周复盘${suffix}`

function proposal() {
  return {
    name: 'weekly-review',
    expectedBaseVersion: '1.0.0',
    reason: '增加复盘模板并移除旧参考。',
    writeFiles: [
      { path: 'SKILL.md', content: skillMd(' V2') },
      { path: 'references/ai-linzi-skill-manifest.json', content: manifest('1.1.0') },
      { path: 'references/new.md', content: '# 新参考' },
    ],
    deleteFiles: ['references/legacy.md'],
  }
}

function copyBuffer(buffer) {
  return buffer.slice(0)
}

function copyFile(file) {
  return { ...file, bytes: copyBuffer(file.bytes) }
}

class FakeHost {
  constructor() {
    this.clock = 100
    this.files = new Map()
    this.writeAttempts = 0
    this.failWriteAt = 0
    this.failWriteHook = undefined
    this.captureAttempts = 0
    this.failCaptureAt = 0
    this.putText('SKILL.md', skillMd())
    this.putText('references/ai-linzi-skill-manifest.json', manifest('1.0.0'))
    this.putText('references/legacy.md', '# 旧参考')
    this.putBinary('assets/avatar.png', Uint8Array.from([0, 255, 7, 8]).buffer)
  }

  putText(path, content) {
    this.putBinary(path, encoder.encode(content).buffer)
  }

  putBinary(path, bytes) {
    this.files.set(path.toLowerCase(), { path, mtime: this.clock++, size: bytes.byteLength, bytes: copyBuffer(bytes) })
  }

  text(path) {
    const file = this.files.get(path.toLowerCase())
    return file ? decoder.decode(file.bytes) : undefined
  }

  async captureFormalFiles() {
    this.captureAttempts += 1
    if (this.failCaptureAt === this.captureAttempts) {
      this.failCaptureAt = 0
      throw new Error('模拟写后校验读取失败')
    }
    return [...this.files.values()].map(copyFile)
  }

  maybeFailWrite() {
    this.writeAttempts += 1
    if (this.failWriteAt === this.writeAttempts) {
      this.failWriteAt = 0
      const hook = this.failWriteHook
      this.failWriteHook = undefined
      hook?.(this)
      throw new Error('模拟磁盘写入失败')
    }
  }

  async writeFormalText(_root, path, content) {
    this.maybeFailWrite()
    this.putText(path, content)
  }

  async writeFormalBinary(_root, path, bytes) {
    this.maybeFailWrite()
    this.putBinary(path, bytes)
  }

  async deleteFormalFile(_root, path) {
    this.maybeFailWrite()
    this.files.delete(path.toLowerCase())
  }

}

function createTransaction(host) {
  let now = Date.parse('2026-08-22T01:02:03.000Z')
  return new tx.SkillUpdateTransaction(host, () => new Date(now++))
}

{
  const host = new FakeHost()
  host.putText('scripts/helper.js', 'console.log("secret implementation")')
  const source = await tx.buildSkillUpdateSource(host, 'Skills/weekly-review', 'weekly-review')
  assert.equal(source.currentVersion, '1.0.0')
  assert.ok(source.files.some((file) => file.path === 'SKILL.md'))
  assert.ok(!source.files.some((file) => file.path.startsWith('scripts/')))
  assert.ok(source.preservedBinaryFiles.some((file) => file.path === 'scripts/helper.js'))
  assert.ok(source.preservedBinaryFiles.some((file) => file.path === 'assets/avatar.png'))
  console.log('  ✓ 更新模型只接收可更新文本，脚本和二进制只传指纹')
}

{
  const host = new FakeHost()
  host.files.delete('references/legacy.md')
  host.files.delete('assets/avatar.png')
  for (let index = 0; index < 101; index++) {
    host.putBinary(`scripts/preserved-${index}.bin`, Uint8Array.from([index % 256]).buffer)
  }
  await assert.rejects(
    tx.buildSkillUpdateSource(host, 'Skills/weekly-review', 'weekly-review'),
    /只读保留文件超过 100 个/u,
  )
  console.log('  ✓ 101 个只读保留文件在本机失败关闭，不把必失败请求送到服务端')
}

async function snapshotState(host) {
  return (await host.captureFormalFiles())
    .map((file) => [file.path, file.mtime, [...new Uint8Array(file.bytes)]])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  assert.equal(prepared.currentVersion, '1.0.0')
  assert.equal(prepared.nextVersion, '1.1.0')
  assert.deepEqual(prepared.changes.map((change) => change.kind), ['update', 'update', 'create', 'delete'])
  const result = await transaction.apply(prepared, proposal())
  assert.equal(result.previousVersion, '1.0.0')
  assert.equal(result.nextVersion, '1.1.0')
  assert.equal(host.text('SKILL.md'), skillMd(' V2'))
  assert.equal(host.text('references/legacy.md'), undefined)
  assert.equal(host.text('references/new.md'), '# 新参考')
  assert.deepEqual([...new Uint8Array(host.files.get('assets/avatar.png').bytes)], [0, 255, 7, 8])
  console.log('  ✓ 一次确认后精确写删、保留未触碰文件且不生成历史副本')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const before = await snapshotState(host)
  host.files.get('skill.md').mtime += 1
  await assert.rejects(
    transaction.apply(prepared, proposal()),
    /预览后被改动/u,
  )
  assert.notDeepEqual(await snapshotState(host), before, '哨兵修改应真实存在')
  console.log('  ✓ 仅 mtime 变化也在确认前中止，且零写入')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const wrongCase = proposal()
  wrongCase.deleteFiles = ['references/LEGACY.md']
  await assert.rejects(
    transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', wrongCase),
    /大小写与现有文件不一致/u,
  )
  assert.equal(host.writeAttempts, 0)
  console.log('  ✓ 仅改变现有路径大小写的提案在预检阶段拒绝')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const beforeContent = new Map((await host.captureFormalFiles()).map((file) => [file.path, [...new Uint8Array(file.bytes)]]))
  host.failWriteAt = 2
  await assert.rejects(transaction.apply(prepared, proposal()), /已恢复原版本.*模拟磁盘写入失败/u)
  const afterContent = new Map((await host.captureFormalFiles()).map((file) => [file.path, [...new Uint8Array(file.bytes)]]))
  assert.deepEqual(afterContent, beforeContent)
  console.log('  ✓ 中途写入失败用内存原内容自动回滚')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const beforeContent = new Map((await host.captureFormalFiles()).map((file) => [file.path, [...new Uint8Array(file.bytes)]]))
  host.failWriteAt = 4
  await assert.rejects(transaction.apply(prepared, proposal()), /已恢复原版本.*模拟磁盘写入失败/u)
  const afterContent = new Map((await host.captureFormalFiles()).map((file) => [file.path, [...new Uint8Array(file.bytes)]]))
  assert.deepEqual(afterContent, beforeContent)
  console.log('  ✓ 删除步骤失败也会完整回滚，不留下前三个已写入文件')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const beforeContent = new Map((await host.captureFormalFiles()).map((file) => [file.path, [...new Uint8Array(file.bytes)]]))
  host.failCaptureAt = host.captureAttempts + 2
  await assert.rejects(transaction.apply(prepared, proposal()), /已恢复原版本.*模拟写后校验读取失败/u)
  const afterContent = new Map((await host.captureFormalFiles()).map((file) => [file.path, [...new Uint8Array(file.bytes)]]))
  assert.deepEqual(afterContent, beforeContent)
  assert.equal(host.text('references/legacy.md'), '# 旧参考')
  assert.equal(host.text('references/new.md'), undefined)
  console.log('  ✓ 删除完成后的校验失败仍按内存原内容恢复正式树')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  host.failWriteAt = 2
  host.failWriteHook = (liveHost) => liveHost.putText('SKILL.md', skillMd(' 用户现场'))
  await assert.rejects(
    transaction.apply(prepared, proposal()),
    /回滚时发现 SKILL\.md 被同时编辑，已保留现场/u,
  )
  assert.equal(host.text('SKILL.md'), skillMd(' 用户现场'))
  console.log('  ✓ 回滚时遇到用户并发编辑会保留现场，绝不覆盖用户新内容')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  host.failWriteAt = 2
  host.failWriteHook = (liveHost) => {
    const entry = liveHost.files.get('skill.md')
    entry.path = 'skill.md'
    entry.mtime = liveHost.clock++
  }
  await assert.rejects(
    transaction.apply(prepared, proposal()),
    /回滚时发现 SKILL\.md 被同时编辑，已保留现场/u,
  )
  assert.equal(host.files.get('skill.md').path, 'skill.md')
  console.log('  ✓ 回滚把仅修改路径大小写也视为用户并发改动，不自动改回旧名称')
}

console.log('[test-skill-update-transaction] 全部通过')

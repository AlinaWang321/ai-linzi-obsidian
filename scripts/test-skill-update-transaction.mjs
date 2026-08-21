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
  /整包快照安全上限/,
)
console.log('  ✓ 快照在读取二进制前限制文件数、单文件与整包体积')
const vaultHostSource = await readFile(new URL('../src/skill-update-vault.ts', import.meta.url), 'utf8')
assert.ok(
  vaultHostSource.indexOf('skillTreeResourceLimitError(') < vaultHostSource.indexOf('vault.readBinary(file)'),
  '真实 Vault Host 必须在读取任何二进制前完成资源限额检查',
)
const readSnapshotSource = vaultHostSource.slice(
  vaultHostSource.indexOf('async readSnapshot('),
  vaultHostSource.indexOf('async removeSnapshot('),
)
assert.ok(readSnapshotSource, '真实 Vault Host 必须实现历史快照读取')
assert.ok(
  readSnapshotSource.indexOf('skillTreeResourceLimitError(') < readSnapshotSource.indexOf('vault.readBinary(file)'),
  '被手工改坏的历史快照也必须在读取二进制前完成资源限额检查',
)
assert.match(readSnapshotSource, /metadataFile\.stat\.size > SNAPSHOT_METADATA_MAX_BYTES/)
assert.match(readSnapshotSource, /file\.stat\.size !== fingerprint\.size/)

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
    this.snapshots = new Map()
    this.removedSnapshots = []
    this.writeAttempts = 0
    this.failWriteAt = 0
    this.failSnapshot = false
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
    return [...this.files.values()].map(copyFile)
  }

  maybeFailWrite() {
    this.writeAttempts += 1
    if (this.failWriteAt === this.writeAttempts) {
      this.failWriteAt = 0
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

  async createSnapshot(_root, snapshotId, metadata, files) {
    if (this.failSnapshot) throw new Error('模拟快照失败')
    if (this.snapshots.has(snapshotId)) throw new Error('快照冲突')
    this.snapshots.set(snapshotId, {
      snapshotId,
      metadata: structuredClone(metadata),
      files: files.map(copyFile),
    })
  }

  async listSnapshots() {
    return [...this.snapshots.values()].map(({ snapshotId, metadata }) => ({ snapshotId, metadata }))
  }

  async readSnapshot(_root, snapshotId) {
    const snapshot = this.snapshots.get(snapshotId)
    if (!snapshot) throw new Error('快照不存在')
    return {
      snapshotId,
      metadata: structuredClone(snapshot.metadata),
      files: snapshot.files.map(copyFile),
    }
  }

  async removeSnapshot(_root, snapshotId) {
    this.removedSnapshots.push(snapshotId)
    this.snapshots.delete(snapshotId)
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
  const archived = await host.readSnapshot('', result.snapshotId)
  assert.equal(decoder.decode(archived.files.find((file) => file.path === 'SKILL.md').bytes), skillMd())
  assert.deepEqual([...new Uint8Array(archived.files.find((file) => file.path === 'assets/avatar.png').bytes)], [0, 255, 7, 8])
  console.log('  ✓ 更新前二进制快照，成功后精确写删且保留未触碰文件')
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
  assert.equal(host.snapshots.size, 0, '冲突必须发生在建快照和写入之前')
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
  assert.equal(host.snapshots.size, 0)
  assert.equal(host.writeAttempts, 0)
  console.log('  ✓ 仅改变现有路径大小写的提案在预检阶段拒绝')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const before = await snapshotState(host)
  host.failSnapshot = true
  await assert.rejects(transaction.apply(prepared, proposal()), /模拟快照失败/u)
  assert.deepEqual(await snapshotState(host), before)
  assert.equal(host.writeAttempts, 0)
  console.log('  ✓ 快照失败时绝不开始正式写入')
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
  assert.equal(host.snapshots.size, 1, '失败现场仍要保留安全快照')
  assert.equal(host.removedSnapshots.length, 0, '失败时不得清理任何历史')
  console.log('  ✓ 中途写入失败自动回滚并保留快照')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  for (let index = 0; index < 5; index++) {
    const id = `old-${index}`
    host.snapshots.set(id, {
      snapshotId: id,
      metadata: {
        schemaVersion: 1,
        skillName: 'weekly-review',
        skillVersion: '0.9.0',
        archivedAt: new Date(index).toISOString(),
        archivedAtMs: index,
        sourceSnapshotHash: 'unused',
        reason: '旧快照',
        files: [],
      },
      files: [],
    })
  }
  await transaction.apply(prepared, proposal())
  assert.equal(host.snapshots.size, 5)
  assert.equal(host.removedSnapshots.length, 1)
  console.log('  ✓ 仅成功后保留最近五份历史')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const applied = await transaction.apply(prepared, proposal())
  const restorePrepared = await transaction.prepareRestore(
    'Skills/weekly-review',
    'weekly-review',
    applied.snapshotId,
  )
  const restored = await transaction.restore(restorePrepared)
  assert.equal(restored.restoredVersion, '1.0.0')
  assert.equal(host.text('SKILL.md'), skillMd())
  assert.equal(host.text('references/legacy.md'), '# 旧参考')
  assert.equal(host.text('references/new.md'), undefined)
  assert.ok(host.snapshots.has(restored.safetySnapshotId), '恢复前的新状态必须另存安全快照')
  console.log('  ✓ 历史恢复前再次快照，并完整恢复增删与二进制')
}

{
  const host = new FakeHost()
  const transaction = createTransaction(host)
  const prepared = await transaction.prepare('Skills/weekly-review', 'Skills/weekly-review/SKILL.md', proposal())
  const applied = await transaction.apply(prepared, proposal())
  host.snapshots.get(applied.snapshotId).files[0].bytes = encoder.encode('被篡改').buffer
  await assert.rejects(
    transaction.prepareRestore('Skills/weekly-review', 'weekly-review', applied.snapshotId),
    /校验失败/u,
  )
  console.log('  ✓ 历史快照内容被改动时拒绝恢复')
}

console.log('[test-skill-update-transaction] 全部通过')

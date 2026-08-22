import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

async function load(entry) {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

const core = await load('src/vault-index-core.ts')
const storeModule = await load('src/vault-index-store.ts')

console.log('[test-vault-index]')

const files = [
  {
    path: '01_Raw/课程逐字稿/20260818-Obsidian X AI霖子课程逐字稿.txt',
    filename: '20260818-Obsidian X AI霖子课程逐字稿.txt',
    extension: 'txt',
    mtime: 100,
    size: 200,
  },
  {
    path: '02_Wiki/方法论/高客单产品.md',
    filename: '高客单产品.md',
    extension: 'md',
    mtime: 90,
    size: 180,
  },
]

const metadata = core.rankVaultMetadataCandidates('20260818日期的obsidian课程逐字稿', files, {})
assert.equal(metadata[0]?.path, files[0].path)
assert.equal(
  core.rankVaultMetadataCandidates('高客单产品', files, { includedFolders: ['01_Raw'] })
    .some((item) => item.path === files[1].path),
  false,
  '指定文件夹范围必须落实到本地候选过滤',
)

const bloom = core.buildVaultIndexBloom('这次讨论了定位、产品阶梯和高客单咨询的成交路径。')
assert.equal(bloom.byteLength, core.VAULT_INDEX_BLOOM_BYTES)
const record = {
  ...files[1],
  schemaVersion: core.VAULT_INDEX_SCHEMA_VERSION,
  indexedAt: 200,
  state: 'ready',
  bloom,
}
assert.ok(core.vaultIndexContentScore(record, '高客单咨询成交路径') > 0)
assert.equal(core.vaultIndexContentScore(record, '海边旅行天气'), 0)
assert.equal(core.isVaultIndexRecordFresh(record, files[1]), true)
assert.equal(core.isVaultIndexRecordFresh({ ...record, mtime: 89 }, files[1]), false)

const records = new Map([[record.path, record]])
assert.equal(
  core.rankVaultContentIndexCandidates('高客单咨询成交路径', files, records)[0]?.path,
  files[1].path,
)
assert.deepEqual(core.summarizeVaultIndex(files, records, true), {
  active: true,
  total: 2,
  ready: 1,
  empty: 0,
  skipped: 0,
  failed: 0,
  pending: 1,
  running: true,
})
assert.equal(core.summarizeVaultIndex(files, new Map(), false, false).active, false)

const memory = new storeModule.MemoryVaultIndexStore()
await memory.put(record)
const listed = await memory.list()
assert.equal(listed.length, 1)
assert.notEqual(listed[0].bloom, record.bloom, '读取结果必须复制二进制，不能共享可变引用')
await memory.delete(record.path)
assert.equal((await memory.list()).length, 0)
const fallback = await storeModule.openVaultIndexStore('test-vault', undefined)
assert.equal(fallback.kind, 'memory')

const searchSource = await readFile(new URL('../src/vault-search.ts', import.meta.url), 'utf8')
assert.match(searchSource, /this\.indexActivated = records\.length > 0/)
assert.match(searchSource, /await this\.reconcileIndex\(this\.indexActivated\)/)
assert.match(searchSource, /await this\.activateIndex\(\)/)
assert.match(searchSource, /if \(this\.indexActivated\) this\.enqueue\(file\.path, true\)/)
assert.doesNotMatch(
  searchSource,
  /this\.indexActivated = true[\s\S]{0,120}initialize\(\)/,
  '启动 initialize 不得无条件激活新 Vault 的正文索引',
)

const storeSource = await readFile(new URL('../src/vault-index-store.ts', import.meta.url), 'utf8')
assert.match(
  storeSource,
  /const done = transactionDone\(transaction\)[\s\S]{0,240}await requestResult/,
  'IndexedDB 必须在 await request 前监听事务完成，避免快事务永久挂起',
)

console.log('[test-vault-index] 全部通过')

import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/vault-inventory-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const core = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const files = [
  { path: '01_Raw/逐字稿/A.md', extension: 'md', size: 100, mtime: 300 },
  { path: '02_Wiki/方法论/B.md', extension: 'md', size: 200, mtime: 200 },
  { path: '04_Output/看板.html', extension: 'html', size: 300, mtime: 100 },
]
const folders = [
  { path: '01_Raw' },
  { path: '01_Raw/逐字稿' },
  { path: '02_Wiki' },
  { path: '02_Wiki/方法论' },
  { path: '04_Output' },
]
const full = core.buildVaultInventory(files, folders, { depth: 2, recentLimit: 2 })
assert.equal(full.metadataOnly, true)
assert.equal(full.totalFiles, 3)
assert.equal(full.totalFolders, 5)
assert.deepEqual(full.extensions, [
  { extension: 'md', count: 2 },
  { extension: 'html', count: 1 },
])
assert.deepEqual(full.recentFiles.map((file) => file.path), ['01_Raw/逐字稿/A.md', '02_Wiki/方法论/B.md'])
assert.equal(full.folders.find((folder) => folder.path === '01_Raw').totalFiles, 1)
assert.equal(JSON.stringify(full).includes('任何正文'), false)

const scoped = core.buildVaultInventory(files, folders, { root: '02_Wiki', depth: 1 })
assert.equal(scoped.totalFiles, 1)
assert.equal(scoped.totalFolders, 2)
assert.deepEqual(scoped.folders.map((folder) => folder.path), ['02_Wiki', '02_Wiki/方法论'])

console.log('[test-vault-inventory] 全库元数据快照与目录范围通过')

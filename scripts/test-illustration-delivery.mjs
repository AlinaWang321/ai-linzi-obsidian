import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

class TFile {
  constructor(path) { this.path = path; this.extension = path.split('.').at(-1) }
}
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/illustration-recovery.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] })
const module = { exports: {} }
vm.runInNewContext(bundled.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    assert.equal(name, 'obsidian')
    return { TFile, Modal: class {}, Notice: class {}, Setting: class {}, normalizePath: (p) => p }
  },
})
const { saveIllustrationAsset, insertIllustrationAssets } = module.exports
const files = new Map([['原文.md', new TFile('原文.md')]])
let text = '# 合成测试\n\n这是一段原文锚点。\n'
let downloads = 0
let failDownload = true
let failWrite = false
const plugin = {
  downloadIllustration: async () => { downloads++; if (failDownload) throw new Error('download disconnected'); return new ArrayBuffer(8) },
  app: { vault: {
    getAbstractFileByPath: (path) => files.get(path),
    createFolder: async (path) => files.set(path, { path }),
    createBinary: async (path) => { assert.ok(!files.has(path)); files.set(path, new TFile(path)) },
    process: async (_file, fn) => { if (failWrite) throw new Error('write failed'); text = fn(text) },
  } },
}
const asset = { imageId: 'ai-synthetic-test-b12345678', title: '合成测试', anchor: '这是一段原文锚点', kind: 'body', imageUrl: 'https://invalid.example/image' }
const folder = 'AI霖子输出/公众号文章/配图/验收'
await assert.rejects(saveIllustrationAsset(plugin, asset, folder), /download disconnected/)
assert.equal(asset.savedPath, undefined)
failDownload = false
const paths = await Promise.all([saveIllustrationAsset(plugin, asset, folder), saveIllustrationAsset(plugin, asset, folder)])
assert.equal(paths[0], paths[1]); assert.equal(downloads, 2, '失败一次 + 合并的成功下载一次')
failWrite = true
await assert.rejects(insertIllustrationAssets(plugin, '原文.md', [asset]), /write failed/)
assert.ok(files.has(asset.savedPath), '笔记写入失败不能丢图')
failWrite = false
await saveIllustrationAsset(plugin, asset, folder)
await insertIllustrationAssets(plugin, '原文.md', [asset])
await insertIllustrationAssets(plugin, '原文.md', [asset])
assert.equal(downloads, 2, '已落盘图片不重新下载')
assert.equal(text.split(`![[${asset.savedPath}]]`).length - 1, 1, '重复插入不会重复正文引用')
files.delete(asset.savedPath)
await saveIllustrationAsset(plugin, asset, folder)
assert.equal(downloads, 3, '本地图片删除后可找回')
await assert.rejects(insertIllustrationAssets(plugin, '不存在.md', [asset]), /原笔记/)
await assert.rejects(saveIllustrationAsset(plugin, { ...asset, savedPath: undefined, imageId: 'ai-another-image' }, '../escape'), /目录无效/)
console.log('illustration delivery: disconnect, concurrent download, disk retry, insertion retry, duplicate prevention passed')

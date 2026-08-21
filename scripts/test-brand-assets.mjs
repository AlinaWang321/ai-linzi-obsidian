// 品牌形象资产检查（0.7.71）：真的把 data URI 解码回二进制来验，不是找字符串。
//
// 为什么需要这个文件：头像是内联在源码里的 base64，换图时最容易出的三种事故——
//   1. 贴错格式（比如贴了 SVG 或 WebP 的 base64，却仍写 image/png）
//   2. 忘了压缩，把 2480×3508 的原图整张塞进 main.js（1.3 MB → base64 1.8 MB）
//   3. 复制粘贴时截断，data URI 解不出完整 PNG
// 这些都不会让 tsc 或 eslint 报错，只会让插件在用户那里显示裂图或让包体暴涨。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/brand-assets.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const {
  AI_LINZI_AVATAR_DATA_URI,
  AI_LINZI_RIBBON_ICON_ID,
  AI_LINZI_RIBBON_ICON_SVG,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

console.log('第1组 data URI 格式')
const PREFIX = 'data:image/png;base64,'
assert.ok(AI_LINZI_AVATAR_DATA_URI.startsWith(PREFIX), '头像必须是 image/png 的 data URI')
const b64 = AI_LINZI_AVATAR_DATA_URI.slice(PREFIX.length)
assert.match(b64, /^[A-Za-z0-9+/]+=*$/, 'base64 载荷不得含换行或非法字符（复制粘贴常见截断）')

console.log('第2组 解码回二进制并验真实格式')
const bytes = Buffer.from(b64, 'base64')
// PNG magic number：89 50 4E 47 0D 0A 1A 0A
assert.deepEqual(
  [...bytes.subarray(0, 8)],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  '解码后必须真的是 PNG（声明 image/png 却贴了别的格式会显示裂图）',
)
// IEND 块结尾，确认没有被截断
assert.equal(
  bytes.subarray(-8).toString('latin1').includes('IEND'),
  true,
  'PNG 必须以 IEND 结尾，否则是被截断的半张图',
)

console.log('第3组 尺寸与体积上限')
// IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后：宽高各 4 字节大端
const width = bytes.readUInt32BE(16)
const height = bytes.readUInt32BE(20)
assert.equal(width, 96, `头像宽度应为 96px，实际 ${width}px`)
assert.equal(height, 96, `头像高度应为 96px，实际 ${height}px`)
const KB = bytes.length / 1024
assert.ok(
  KB <= 40,
  `头像原始体积 ${KB.toFixed(1)} KB 超过 40 KB 上限——` +
    '这是 26px 的界面头像，不要塞原图（换图后请先 sips -Z 96 压缩）',
)
console.log(`  头像 ${width}×${height}，${KB.toFixed(1)} KB，base64 ${(b64.length / 1024).toFixed(1)} KB`)

console.log('第4组 ribbon 图标')
assert.equal(AI_LINZI_RIBBON_ICON_ID, 'ai-linzi-avatar')
assert.match(AI_LINZI_RIBBON_ICON_SVG, /<image [^>]*href="data:image\/png;base64,/, 'ribbon 图标必须内嵌同一张头像')
assert.match(AI_LINZI_RIBBON_ICON_SVG, /clip-path="url\(#ai-linzi-avatar-clip\)"/, '必须裁成圆形与其他 ribbon 图标同形')
assert.ok(
  AI_LINZI_RIBBON_ICON_SVG.includes(AI_LINZI_AVATAR_DATA_URI),
  'ribbon 图标与面板头像必须是同一份资产，不能各贴一张',
)
assert.doesNotMatch(AI_LINZI_RIBBON_ICON_SVG, /<svg/i, 'addIcon 接收的是 svg 的内容，不能再套一层 <svg>')
assert.doesNotMatch(AI_LINZI_RIBBON_ICON_SVG, /https?:\/\//, '插件不得加载任何远程资源')

console.log('brand assets tests: ok')

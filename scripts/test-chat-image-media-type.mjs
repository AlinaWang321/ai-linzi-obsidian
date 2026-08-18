// 0.7.55 回归：图片类型必须从 dataUrl 自身推断，绝不能硬编码。
// 事故：三处上传点写死 mediaType='image/jpeg'，服务端从 dataUrl 推断为 image/png
// 后因两者不一致拒收，报「图片必须是 PNG、JPG 或 WebP」——微信/系统截图默认就是
// PNG，等于「上传聊天截图」这个核心功能对 PNG 全线失效（打卡营 D3 核心演示）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const actions = readFileSync(join(root, 'src/actions.ts'), 'utf8')

// actions.ts 依赖 obsidian 运行时，无法直接 import；把这一个纯函数抠出来单独求值。
const fnMatch = /export function imageMediaTypeFromDataUrl\(dataUrl: string\)[^{]*\{([\s\S]*?)\n\}/.exec(actions)
assert.ok(fnMatch, 'imageMediaTypeFromDataUrl 必须存在于 src/actions.ts')
const imageMediaTypeFromDataUrl = new Function('dataUrl', fnMatch[1].replace(/: '[^']*'(?: \| '[^']*')*/g, ''))

// ① 逐类型推断正确
assert.equal(imageMediaTypeFromDataUrl('data:image/png;base64,iVBORw0KGgo='), 'image/png')
assert.equal(imageMediaTypeFromDataUrl('data:image/jpeg;base64,/9j/4AAQ'), 'image/jpeg')
assert.equal(imageMediaTypeFromDataUrl('data:image/webp;base64,UklGRg=='), 'image/webp')
// ② 大小写与空白不影响
assert.equal(imageMediaTypeFromDataUrl('  DATA:IMAGE/PNG;base64,iVBORw0KGgo=  '), 'image/png')
// ③ 未知/缺前缀退回 jpeg（服务端白名单内的安全默认值）
assert.equal(imageMediaTypeFromDataUrl('data:image/gif;base64,R0lGOD'), 'image/jpeg')
assert.equal(imageMediaTypeFromDataUrl('iVBORw0KGgo='), 'image/jpeg')
// ④ 返回值必须落在服务端白名单内
for (const url of [
  'data:image/png;base64,x',
  'data:image/jpeg;base64,x',
  'data:image/webp;base64,x',
  'data:application/octet-stream;base64,x',
  '',
]) {
  assert.ok(
    ['image/png', 'image/jpeg', 'image/webp'].includes(imageMediaTypeFromDataUrl(url)),
    `返回值必须在服务端白名单内: ${url}`,
  )
}

// ⑤ 源码契约：三处上传点都不许再出现硬编码 mediaType
for (const file of ['src/main.ts', 'src/content-dashboard.ts']) {
  const source = readFileSync(join(root, file), 'utf8')
  assert.ok(
    !/mediaType:\s*'image\/(jpeg|png|webp)'/.test(source),
    `${file} 不得硬编码 mediaType（必须用 imageMediaTypeFromDataUrl 从 dataUrl 推断）`,
  )
}
const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
assert.equal(
  (main.match(/mediaType: imageMediaTypeFromDataUrl\(image\.dataUrl\)/g) ?? []).length,
  2,
  'main.ts 的两个上传路径（流式与非流式）都必须按 dataUrl 推断',
)

console.log('chat image media type tests: ok')

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/qr-overlay.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const qr = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
  const layout = qr.computeQrOverlayLayout(1200, 1600, position, 18)
  assert.ok(layout.qrSize >= 96)
  assert.ok(layout.qrX >= 0 && layout.qrY >= 0)
  assert.ok(layout.qrX + layout.qrSize <= 1200)
  assert.ok(layout.qrY + layout.qrSize <= 1600)
  assert.equal(layout.framePadding, 0, '默认不得额外添加白色外框')
  const framed = qr.computeQrOverlayLayout(1200, 1600, position, 18, 'white')
  assert.ok(framed.framePadding >= 8, '用户明确要求时允许白色外框')
  assert.ok(framed.frameSize > framed.qrSize)
}
assert.equal(qr.computeQrOverlayLayout(1200, 1600, 'bottom-right', 2).qrSize, 144)
assert.equal(qr.computeQrOverlayLayout(1200, 1600, 'bottom-right', 99).qrSize, 360)
assert.equal(qr.closestQrOverlayRatio(1200, 1600), '3:4')
assert.equal(qr.closestQrOverlayRatio(1600, 900), '16:9')

const source = await readFile(new URL('../src/qr-overlay.ts', import.meta.url), 'utf8')
assert.match(source, /imageSmoothingEnabled = false/, '二维码缩放不得使用模糊插值')
assert.match(source, /if \(layout\.framePadding > 0\)/, '白框必须是显式可选项，不能默认绘制')
assert.doesNotMatch(source, /generateAiImage|fetch\(/, '叠加必须全程本机确定性执行')

console.log('QR overlay tests: ok')

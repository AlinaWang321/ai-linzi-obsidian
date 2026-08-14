import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

assert.match(main, /function installButtonPressFeedback\(container: HTMLElement\)/)
assert.match(main, /container\.addEventListener\('pointerdown'/, '鼠标和触控按下必须立即反馈')
assert.match(main, /event\.key !== 'Enter' && event\.key !== ' '/, '键盘操作必须获得同样反馈')
assert.match(main, /installButtonPressFeedback\(this\.modalEl\)/, '历史弹窗按钮必须启用反馈')
assert.match(main, /installButtonPressFeedback\(root\)/, '对话顶栏和底部动作按钮必须启用反馈')

for (const label of [
  '历史',
  '新对话',
  '打开',
  '删除',
  '清空全部插件对话',
  '调用技能',
  '存入知识库',
  '内容看板',
]) {
  assert.match(main, new RegExp(`text: '${label}'`), `缺少需要反馈的按钮：${label}`)
}

assert.match(styles, /@keyframes ai-linzi-button-press/)
assert.match(styles, /translateY\(1px\) scale\(0\.97\)/)
assert.match(styles, /prefers-reduced-motion: reduce/, '必须尊重系统减少动态效果设置')
assert.doesNotMatch(styles, /!important/, '点击反馈不得破坏官方市场 CSS 约束')

console.log('button press feedback tests: ok')

// `/` 命令面板触发判定的行为测试（0.7.71）：真跑逻辑，不是在源码里找字符串。
//
// 四个真实边界，每个都能让用户当场骂人：
//   1. 输入 `02_Wiki/客户档案.md` 这类路径时弹菜单 → 打断正常输入
//   2. 中文输入法合成期抢按键 → 候选词被打断，打不出字
//   3. 访谈写作模式下弹技能菜单 → 语义完全错位
//   4. 修饰键组合（如 Ctrl+/ 注释快捷键）被吞掉
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/slash-menu-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { shouldOpenSlashMenu } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const key = (over = {}) => ({ key: '/', isComposing: false, ...over })
const input = (over = {}) => ({
  value: '',
  selectionStart: 0,
  selectionEnd: 0,
  interviewMode: false,
  ...over,
})

console.log('第1组 正常触发')
assert.equal(shouldOpenSlashMenu(key(), input()), true, '空输入框敲 / 应当弹面板')
assert.equal(
  shouldOpenSlashMenu(key(), input({ value: '已经写了一半', selectionStart: 0, selectionEnd: 0 })),
  true,
  '光标停在开头且无选区时也应弹',
)

console.log('第2组 真实路径输入不得被打断')
assert.equal(
  shouldOpenSlashMenu(key(), input({ value: '02_Wiki', selectionStart: 7, selectionEnd: 7 })),
  false,
  '在 02_Wiki 后面敲 / 是在打路径，不能弹菜单',
)
assert.equal(
  shouldOpenSlashMenu(key(), input({ value: 'a', selectionStart: 1, selectionEnd: 1 })),
  false,
  '只要光标不在开头就不接管',
)
assert.equal(
  shouldOpenSlashMenu(key(), input({ value: '整段选中', selectionStart: 0, selectionEnd: 4 })),
  false,
  '有选区时 / 是替换选中内容，不能弹菜单',
)

console.log('第3组 中文输入法合成期一律放行')
assert.equal(shouldOpenSlashMenu(key({ isComposing: true }), input()), false, 'isComposing 期间不接管')
assert.equal(
  shouldOpenSlashMenu(key({ keyCode: 229 }), input()),
  false,
  '只给 keyCode 229 不给 isComposing 的环境同样不接管',
)

console.log('第4组 修饰键与访谈模式')
for (const mod of ['metaKey', 'ctrlKey', 'altKey']) {
  assert.equal(
    shouldOpenSlashMenu(key({ [mod]: true }), input()),
    false,
    `${mod} + / 属于快捷键，不得被吞`,
  )
}
assert.equal(
  shouldOpenSlashMenu(key(), input({ interviewMode: true })),
  false,
  '访谈写作模式下输入框语义不同，不接管 /',
)

console.log('第5组 其他按键一律不理')
for (const k of ['a', 'Enter', '?', 'Slash', '、']) {
  assert.equal(shouldOpenSlashMenu(key({ key: k }), input()), false, `${k} 不该触发`)
}

console.log('slash menu core behavior tests: ok')

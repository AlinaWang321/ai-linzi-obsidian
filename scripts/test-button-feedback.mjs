import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

assert.match(main, /function installButtonPressFeedback\(container: HTMLElement\)/)
assert.match(main, /container\.addEventListener\('pointerdown'/, '鼠标和触控按下必须立即反馈')
assert.match(main, /event\.key !== 'Enter' && event\.key !== ' '/, '键盘操作必须获得同样反馈')
assert.match(main, /installButtonPressFeedback\(this\.modalEl\)/, '历史弹窗按钮必须启用反馈')
assert.match(main, /installButtonPressFeedback\(root\)/, '对话顶栏和底部动作按钮必须启用反馈')

// 0.7.71：入口形态从「一律带文字的按钮」变成「图标钮 / 菜单项 / 文字按钮」三种。
// 断言随之改为「这个入口仍然存在且用户能读到它的名字」，判定放宽到三种承载方式，
// 但同时新增下面第 2、3 组把真正的不变量钉死——总体强度只增不减。
// 注意：0.7.71 把底部「调用技能」按钮改名为 composer 上的「技能」菜单，
// 官方技能列在该菜单第一段（其可达性由 test-chat-actions.mjs 的 buildSkillMenu 断言守住）。
// 这里列的是「用户真正看得到的入口名」，改名必须同步改这份清单，不能靠放宽正则蒙混。
const ENTRY_LABELS = [
  '历史',
  '新对话',
  '设置',
  '打开',
  '删除',
  '清空全部插件对话',
  '技能',
  '工作台',
  '内容看板',
  'CEO驾驶舱',
  '我的 Skills',
  '创建 Skill',
]
for (const label of ENTRY_LABELS) {
  const carriers = [
    new RegExp(`text: '${label}'`), // 文字按钮
    new RegExp(`'aria-label': '${label}'`), // 图标钮
    new RegExp(`setTitle\\('${label}'\\)`), // 菜单项
    new RegExp(`addTopBtn\\('[a-z-]+', '${label}'`), // 顶栏图标钮工厂
    new RegExp(`addBarMenuBtn\\(\\s*'[a-z-]+',\\s*'${label}'`), // composer 菜单钮工厂
  ]
  assert.ok(
    carriers.some((pattern) => pattern.test(main)),
    `入口消失了，用户再也点不到：${label}`,
  )
}

// 第 2 组（0.7.71 新增）：所有可点击入口必须是真 <button>。
// 改成「无边框文字 + ⌄」的视觉时最容易顺手写成 div/span —— 那样按压反馈、
// Tab 可达和 Enter/Space 激活会一起静默消失，且不报任何错。
const clickableFactories = [
  ["顶栏图标钮", /const addTopBtn = \([\s\S]{0,200}?btns\.createEl\('button'/],
  ["composer 菜单钮", /const addBarMenuBtn = \([\s\S]{0,320}?bar\.createEl\('button'/],
  ["附件钮", /this\.authorizedContentBtn = tools\.createEl\('button'/],
  ["发送钮", /this\.sendBtn = tools\.createEl\('button'/],
  ["空状态起手式", /const addStarter = \([\s\S]{0,260}?starters\.createEl\('button'/],
  ["活动流展开钮", /const toggle = body\.createEl\('button'/],
]
for (const [name, pattern] of clickableFactories) {
  assert.match(main, pattern, `${name}必须是 <button> 元素，否则按压反馈与键盘操作会静默失效`)
}

// 第 3 组（0.7.71 新增）：图标钮必须留下可读名称，窄面板不能退化成看不懂的图标墙。
assert.match(
  main,
  /attr: \{ 'aria-label': label, title: label, type: 'button' \}/,
  '顶栏图标钮必须同时带 aria-label 与 title',
)
assert.match(
  main,
  /attr: \{ 'aria-label': hint, title: hint, 'aria-haspopup': 'menu', type: 'button' \}/,
  'composer 菜单钮必须带 aria-label、title 与 aria-haspopup',
)
// 窄面板收窄必须按「面板自身宽度」判断。Obsidian 侧边栏是宽窗口里的一根窄栏，
// @media (max-width) 判的是视口，320px 的面板照样会拿到 1400px 视口的样式——
// 这是 0.7.71 开发中实测踩到的坑，必须由测试钉死，不许退回 @media。
assert.match(
  styles,
  /\.ai-linzi-root \{[\s\S]{0,400}?container-type: inline-size;[\s\S]{0,80}?container-name: ai-linzi-panel;/,
  '对话面板必须声明为容器，窄面板样式才能按面板宽度生效',
)
assert.match(
  styles,
  /@container ai-linzi-panel \(max-width: \d+px\) \{[\s\S]{0,220}\.ai-linzi-icon-btn-label \{\s*display: none/,
  '顶栏文字 label 的收窄规则必须走 @container，不得用 @media',
)
{
  // 收窄规则里只允许隐藏可视文字，绝不能把 aria-label / title 一起藏掉。
  const containerBlocks = styles.match(/@container ai-linzi-panel[\s\S]*?\n\}/g) ?? []
  assert.ok(containerBlocks.length >= 2, '至少要有两级窄面板断点')
  for (const block of containerBlocks) {
    assert.doesNotMatch(block, /aria-label/, '收窄规则不得触碰 aria-label')
  }
}

// 第 3.5 组（0.7.71 真机实测得出）：面板内自定义按钮的选择器权重必须够高。
//
// Obsidian 与各家主题普遍带 `button { padding; border-radius; background }`，
// 深色主题常写成 `.theme-dark button`（0,1,1）甚至更高。首轮实测：单类写法下
// padding 被改成 4px 10px、border-radius 被改成 5px，发送键根本不是圆的，
// 深色下三处按钮背景全被刷回灰底。市场检查禁用 !important，权重是唯一杠杆。
{
  const PANEL_BUTTONS = [
    'ai-linzi-icon-btn',
    'ai-linzi-composer-menu-btn',
    'ai-linzi-attachment-btn',
    'ai-linzi-send',
    'ai-linzi-stop',
    'ai-linzi-starter-btn',
    'ai-linzi-activity-toggle',
    'ai-linzi-brand-credits',
  ]
  for (const cls of PANEL_BUTTONS) {
    // 抓出所有以该类结尾的选择器（含伪类/状态类），逐条数权重。
    // JS 的 RegExp 不支持 (?m) 内联标志，多行只能靠 'm' flag（写成内联会直接抛
    // Invalid group —— 这个错误只在真跑时才暴露，源码 grep 型测试永远看不见）。
    // `(?![\w-])` 是必需的类名边界：没有它，`.ai-linzi-icon-btn` 会连
    // `.ai-linzi-icon-btn-label` 一起匹配上（那是给文字 span 的规则，不需要提权）。
    const selectors = [...styles.matchAll(new RegExp(`^([^{}\\n]*\\.${cls}(?![\\w-])[^{}\\n]*?)\\s*\\{`, 'gm'))]
      .map((m) => m[1].trim())
      .filter((sel) => !sel.startsWith('/*'))
      // 只管「按钮自己是主语」的规则。给子元素上样式的（如 `.x .svg-icon`）
      // 不会跟主题的 button 规则打架，不需要提权。
      .filter((sel) => {
        const tail = sel.slice(sel.lastIndexOf(`.${cls}`) + cls.length + 1)
        return !/[\s>+~]/.test(tail)
      })
    assert.ok(selectors.length > 0, `styles.css 里找不到 .${cls} 的规则`)
    for (const sel of selectors) {
      const classCount = (sel.match(/\.[a-z][\w-]*/g) ?? []).length
      const hasElement = /(^|\s)button[.:\s]/.test(sel) || /^button\./.test(sel)
      assert.ok(
        classCount >= 3 && hasElement,
        `选择器权重不足，主题的 button 规则会盖掉它：「${sel}」\n` +
          '    必须写成 `.ai-linzi-root <祖先类> button.ai-linzi-x`（权重 0,3,1），' +
          '不能只写单类或省略 button 元素选择器。',
      )
    }
  }
}

// 第 3.6 组（0.7.71 第二轮真机踩到）：权重只能覆盖「声明过的属性」。
//
// 主题的 `button { height: 30px; white-space: nowrap; line-height: 1 }` 里凡是我们
// 没写的那几条，选择器权重再高也拦不住。实测后果：起手式卡被压成 30px 高，
// 第二行说明文字溢出卡片、被下一张卡盖住（Alina 截图报障）。
// 因此内容撑高的按钮必须有一条共享 reset 显式声明这一组属性。
{
  const CONTENT_SIZED = [
    'ai-linzi-icon-btn',
    'ai-linzi-composer-menu-btn',
    'ai-linzi-starter-btn',
    'ai-linzi-activity-toggle',
    'ai-linzi-brand-credits',
    'ai-linzi-authorized-content-status',
  ]
  // 找到那条同时覆盖全部内容撑高按钮的规则块
  const blocks = [...styles.matchAll(/(?:^|\n)((?:[^{}\n]*\n)*[^{}\n]*)\{([^{}]*)\}/g)]
  const reset = blocks.find(([, sel, body]) =>
    CONTENT_SIZED.every((cls) => sel.includes(cls)) && /height:\s*auto/.test(body),
  )
  assert.ok(
    reset,
    '缺少共享 reset：内容撑高的按钮必须集中声明 height/min-height/white-space/line-height，' +
      '否则主题的 button 固定高度会把两行文字压出卡片外',
  )
  for (const prop of ['height: auto', 'min-height: 0', 'white-space: normal', 'line-height:']) {
    assert.ok(
      reset[2].includes(prop),
      `共享 reset 缺少 ${prop} —— 主题一旦强制这项，卡片内容就会被裁掉`,
    )
  }
}

// 第 4 组：键盘唤起菜单时坐标为 (0,0)，必须改按按钮位置定位，否则菜单飞到屏幕左上角。
assert.match(main, /private showMenuForButton\(menu: Menu, btn: HTMLElement, event: MouseEvent\)/)
assert.match(main, /if \(event\.detail > 0\)/, '鼠标点击仍走 showAtMouseEvent')
assert.match(main, /menu\.showAtPosition\(\{ x: rect\.left, y: rect\.bottom \}\)/, '键盘激活必须锚到按钮')

assert.doesNotMatch(main, /const kbBtn = actionsRow\.createEl/, '知识库动作不应再作为常驻按钮')
// 精确锁定被移除的那个容器与按钮类（`actionsRow` 是确认卡里的通用局部变量名，不能一刀切）。
assert.doesNotMatch(main, /cls: 'ai-linzi-actions'/, '0.7.71 已移除底部五按钮网格容器，不得复活')
assert.doesNotMatch(
  main,
  /cls: 'ai-linzi-action-btn/,
  '底部常驻动作按钮已收进「技能」「工作台」两个菜单，不得复活',
)

assert.match(styles, /@keyframes ai-linzi-button-press/)
assert.match(styles, /translateY\(1px\) scale\(0\.97\)/)
assert.match(styles, /prefers-reduced-motion: reduce/, '必须尊重系统减少动态效果设置')
assert.doesNotMatch(styles, /!important/, '点击反馈不得破坏官方市场 CSS 约束')

console.log('button press feedback tests: ok')

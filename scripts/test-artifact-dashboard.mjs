// 交互看板版式：经营看板走单页滚动驾驶舱；长文继续走文档版式。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/artifact-renderer-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { resolveArtifactLayout, jsonForInlineScript } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const renderer = readFileSync(join(root, 'src/artifact-renderer.ts'), 'utf8')

let failures = 0
function assert(name, condition) {
  if (condition) console.log(`  ok - ${name}`)
  else { failures += 1; console.error(`  FAIL - ${name}`) }
}

const boardContent = [
  '## 优先级一｜今天必须推进',
  '### 1. 完成小B客户交付闭环',
  '- [ ] 核对定位',
  '- [x] 确认收口SOP',
  '## 优先级二｜完成一项即可',
  '### 2. 内容复用检查',
  '- [ ] 选一个主题',
  '## 今日完成记录',
  '- [ ] 小B交付闭环完成',
  '- [ ] 课程素材完成提炼',
].join('\n')

console.log('第1组 版式判定')
assert('显式 dashboard 优先', resolveArtifactLayout({ title: '任意', content: '正文', layout: 'dashboard' }) === 'dashboard')
assert('显式 document 优先（即使内容像看板）', resolveArtifactLayout({ title: '今日任务看板', content: boardContent, layout: 'document' }) === 'document')
assert('看板标题+多勾选自动切换', resolveArtifactLayout({ title: '2026.08.19 今日任务看板', content: boardContent }) === 'dashboard')
assert('日报标题+多分区自动切换', resolveArtifactLayout({ title: '知识库日报', content: '## A\n## B\n## C\n## D\n正文' }) === 'dashboard')
assert('大量勾选任务即使标题普通也切换', resolveArtifactLayout({ title: '本周安排', content: '## A\n- [ ] 1\n- [ ] 2\n## B\n- [ ] 3\n- [ ] 4\n## C\n- [ ] 5' }) === 'dashboard')
assert('只是标题带"日报"的长文仍走文档式', resolveArtifactLayout({ title: '日报方法论', content: '## 一\n正文很长' }) === 'document')
assert('普通文章走文档式', resolveArtifactLayout({ title: '公众号文章：转型清单', content: '## 一\n## 二\n正文' }) === 'document')
assert('非法 layout 值忽略后按内容判定', resolveArtifactLayout({ title: '文章', content: '正文', layout: 'fancy' }) === 'document')

console.log('第2组 交互能力（源码契约）')
assert('存在看板渲染函数', renderer.includes('function artifactDashboardHtml'))
assert('HTML 按版式分流', /resolveArtifactLayout\(operation\) === 'dashboard'\s*\n\s*\? artifactDashboardHtml/.test(renderer))
assert('单页滚动配粘性左侧导航', renderer.includes('class="rail"') && renderer.includes('position:sticky'))
assert('下层小标题成卡片', renderer.includes('<article class="card'))
assert('仅今日任务成为真实复选框', renderer.includes('type="checkbox" class="today-check"'))
assert('已完成任务保留勾选状态', renderer.includes("task.done ? ' checked' : ''"))
assert('勾选状态存本机 localStorage', renderer.includes('localStorage.setItem(KEY'))
assert('今日有进度环与完成计数', renderer.includes('id="ring-fg"') && renderer.includes('id="ring-pct"'))
assert('进度脚本只统计今日任务', renderer.includes('#today input[type=checkbox]'))
assert('经营漏斗可识别最大漏点', renderer.includes('funnel-card') && renderer.includes('最大漏点'))
assert('数据依据可折叠', renderer.includes('<details class="evidence">'))
assert('优先级/状态自动配色', renderer.includes('function toneOf') && renderer.includes("core ? 'core' : 'optional'"))
assert('支持深色模式', renderer.includes('prefers-color-scheme:dark'))
assert('打印时展开数据依据', renderer.includes('@media print') && renderer.includes('beforeprint'))
assert('模型自主 CSS 在本机默认样式之后注入', renderer.includes('${customCss}\n  </style>'))

console.log('第3组 安全与自包含')
assert('看板正文仍走转义', renderer.includes('escapeHtml(task.text)'))
const hostileTitle = '</script><img src=x onerror="globalThis.pwned=1">\u2028下一行'
const safeInlineJson = jsonForInlineScript(hostileTitle)
assert('内联脚本 JSON 不含可闭合 script 的小于号', !safeInlineJson.includes('<'))
assert('内联脚本 JSON 不含原始 JS 行分隔符', !safeInlineJson.includes('\u2028'))
assert('安全 JSON 仍能无损还原标题', JSON.parse(safeInlineJson) === hostileTitle)
assert('看板 storage key 使用专用内联脚本转义', renderer.includes('jsonForInlineScript(storageKey)'))
const dashboardSection = renderer.slice(renderer.indexOf('function artifactDashboardHtml'), renderer.indexOf('function docxTable'))
assert('无外部脚本/样式引用', !/src="https?:|href="https?:|@import/.test(dashboardSection))
assert('无网络请求代码', !/fetch\(|XMLHttpRequest|WebSocket/.test(dashboardSection))
assert('localStorage 读写有异常兜底', (dashboardSection.match(/catch\(e\)\{/g) ?? []).length >= 2)

if (failures > 0) {
  console.error(`artifact dashboard tests: ${failures} failure(s)`)
  process.exit(1)
}
console.log('artifact dashboard tests: ok')

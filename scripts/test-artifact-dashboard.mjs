// 交互看板版式（0.7.54）：看板/日报走交互版式（标签页+可勾选任务+进度统计），
// 长文继续走文档版式；整页必须自包含（无外部请求）。
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
const { resolveArtifactLayout } = await import(
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
assert('顶层小标题成标签页', renderer.includes('class="tab') && renderer.includes('data-tab='))
assert('下层小标题成卡片', renderer.includes('<article class="card'))
assert('- [ ] 成真实复选框', renderer.includes('type="checkbox" class="tick"'))
assert('已完成任务保留勾选状态', renderer.includes("item.done ? ' checked' : ''"))
assert('勾选状态存本机 localStorage', renderer.includes('localStorage.setItem(KEY'))
assert('顶部有进度条与完成计数', renderer.includes('id="bar"') && renderer.includes('id="num"'))
assert('标签上有分区完成数', renderer.includes('data-tab-count'))
assert('卡片可折叠', renderer.includes('class="fold"') && renderer.includes('folded'))
assert('支持搜索过滤', renderer.includes('id="q"'))
assert('优先级/状态自动配色', renderer.includes('function toneOf') && renderer.includes('tone-urgent'))
assert('支持深色模式', renderer.includes('prefers-color-scheme:dark'))
assert('打印时展开全部分区', renderer.includes('@media print') && renderer.includes('.panel{display:grid!important}'))

console.log('第3组 安全与自包含')
assert('看板正文仍走转义', renderer.includes('escapeHtml(item.text)'))
const dashboardSection = renderer.slice(renderer.indexOf('function artifactDashboardHtml'), renderer.indexOf('function docxTable'))
assert('无外部脚本/样式引用', !/src="https?:|href="https?:|@import/.test(dashboardSection))
assert('无网络请求代码', !/fetch\(|XMLHttpRequest|WebSocket/.test(dashboardSection))
assert('localStorage 读写有异常兜底', (dashboardSection.match(/catch\(e\)\{/g) ?? []).length >= 2)

if (failures > 0) {
  console.error(`artifact dashboard tests: ${failures} failure(s)`)
  process.exit(1)
}
console.log('artifact dashboard tests: ok')

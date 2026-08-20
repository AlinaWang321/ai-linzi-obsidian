// 真实渲染回归：昨天的 [x] 只能显示为静态回执，不能污染今日进度。
import { build } from 'esbuild'

async function importBundle(entryPoint) {
  const bundled = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

const { parseArtifactMarkdown } = await importBundle('src/artifact-renderer-core.ts')
const { artifactDashboardHtml } = await importBundle('src/artifact-renderer.ts')

let failures = 0
function assert(name, condition) {
  if (condition) console.log(`  ok - ${name}`)
  else { failures += 1; console.error(`  FAIL - ${name}`) }
}

const markdown = `# 2026.08.20 经营周报

> 本周最重要的判断：内容供给稳定，但咨询到成交的转化正在变差。
> 扫描 18 份文件，完整读取 16 份，跳过 2 份。

## 今日待办
### 今天必须推进
- [ ] 回访 3 位高意向客户
- [x] 确认明日课程大纲
### 完成一项即可
- [ ] 发布一篇学员案例

## 经营链路
| 环节 | 本周 | 上周 |
| --- | ---: | ---: |
| 有效线索 | 20 | 18 |
| 咨询 | 8 | 10 |
| 成交 | 2 | 4 |

## 本周数字
| 指标 | 本周 | 环比 | 七日趋势 |
| --- | ---: | ---: | --- |
| 收入 | 32000 | ▲ 12% | 18,21,20,25,24,28,32 |
| 咨询数 | 8 | ▼ 20% | 5,7,9,10,8,7,8 |

## 七天节奏
| 日期 | 动过文档 | 关键产出 | 咨询 | 收入 |
| --- | ---: | --- | ---: | ---: |
| 08.14 | 8 | 课程大纲 | 1 | 0 |
| 08.15 | 12 | 公众号文章 | 2 | 9800 |
| 08.16 | 6 | 客户方案 | 1 | 0 |
| 08.17 | 15 | 咨询复盘 | 3 | 19800 |
| 08.18 | 5 | 短视频脚本 | 0 | 0 |
| 08.19 | 10 | 课程课件 | 1 | 2400 |
| 08.20 | 9 | 经营周报 | 0 | 0 |

## 昨天发生了什么
### 已完成
- [x] 完成第五天课程
- [x] 跟进两位客户
### 未完成
- [ ] 更新销售页

## 下周决策
1. 做：把咨询后的 48 小时跟进标准化。
2. 做：复用高转化学员案例。
3. 做：每天下午固定清空客户任务。
4. 不做：临时增加新的课程模块。

## 数据依据
- 最近 7 天修改过的 Markdown 文档
- 今天的任务清单
`

const html = artifactDashboardHtml(parseArtifactMarkdown(markdown, '经营周报'), 'brand')
console.log('[test-business-dashboard-render]')
assert('输出完整自包含 HTML', html.startsWith('<!doctype html>') && html.includes('<meta name="viewport"'))
assert('采用单页滚动驾驶舱', html.includes('class="rail"') && html.includes('data-dashboard-section') && !html.includes('data-tab='))
assert('包含今日进度环', html.includes('id="ring-fg"'))
assert('包含经营漏斗', html.includes('funnel-card'))
assert('包含本周指标', html.includes('class="metrics"'))
assert('包含七天节奏', html.includes('class="rhythm"'))
assert('数据依据默认折叠并显示修改时间口径', html.includes('<details class="evidence">') && html.includes('按文件修改时间统计'))
assert('整页只有今天的 3 个任务可勾选', (html.match(/<input type="checkbox"/g) ?? []).length === 3)
const yesterdayStart = html.indexOf('<section id="yesterday"')
const yesterdayEnd = html.indexOf('</section>', yesterdayStart)
const yesterday = html.slice(yesterdayStart, yesterdayEnd)
assert('昨日完成记录没有复选框', yesterdayStart >= 0 && !yesterday.includes('type="checkbox"'))
assert('进度脚本只读取今日任务', html.includes('#today input[type=checkbox]'))
assert('无外部依赖与网络请求', !/src="https?:|href="https?:|@import|fetch\(|XMLHttpRequest|WebSocket/.test(html))
assert('支持深色、减少动效和打印展开', html.includes('prefers-color-scheme:dark') && html.includes('prefers-reduced-motion:reduce') && html.includes('beforeprint'))

if (failures > 0) {
  console.error(`business dashboard render tests: ${failures} failure(s)`)
  process.exit(1)
}
console.log('business dashboard render tests: ok')

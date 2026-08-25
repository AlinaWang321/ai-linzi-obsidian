// 「最近改了什么」时间查询（0.7.60）：真跑纯函数 + 接线契约。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/vault-agent-core.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const { applyRecentListFilter, isRecentListRequest, formatRecentTime } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const now = Date.parse('2026-08-19T12:00:00+08:00')
const day = 86_400_000
const entries = [
  { path: 'A/老文件.md', type: 'file', modifiedAt: now - 30 * day },
  { path: 'B/昨天.md', type: 'file', modifiedAt: now - 1 * day },
  { path: 'B', type: 'folder' },
  { path: 'C/今天.md', type: 'file', modifiedAt: now - 2 * 3600_000 },
  { path: 'C/上周.md', type: 'file', modifiedAt: now - 6 * day },
]

console.log('第1组 模式判定')
assert.equal(isRecentListRequest({ sortBy: 'modified' }), true)
assert.equal(isRecentListRequest({ sinceDays: 7 }), true)
assert.equal(isRecentListRequest({ sortBy: '', sinceDays: 0 }), false)
assert.equal(isRecentListRequest({}), false)

console.log('第2组 排序与过滤')
{
  const r = applyRecentListFilter(entries, { sortBy: 'modified', now })
  assert.equal(r.recentMode, true)
  assert.deepEqual(r.entries.map((e) => e.path), ['C/今天.md', 'B/昨天.md', 'C/上周.md', 'A/老文件.md'], '按修改时间降序')
  assert.ok(r.entries.every((e) => e.type === 'file'), '时间模式只看文件，文件夹剔除')
  assert.ok(r.entries.every((e) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(e.modified)), '每条带可读时间')

  const week = applyRecentListFilter(entries, { sinceDays: 7, now })
  assert.deepEqual(week.entries.map((e) => e.path), ['C/今天.md', 'B/昨天.md', 'C/上周.md'], 'sinceDays=7 过滤 30 天前的')
  const day1 = applyRecentListFilter(entries, { sinceDays: 1, now })
  assert.deepEqual(day1.entries.map((e) => e.path), ['C/今天.md', 'B/昨天.md'], '正好 1 天前的算在内(>=边界)')
}

console.log('第3组 非时间模式原样返回')
{
  const r = applyRecentListFilter(entries, { now })
  assert.equal(r.recentMode, false)
  assert.equal(r.entries, entries, '引用原样返回，不做任何变换')
}

console.log('第4组 边界')
assert.equal(formatRecentTime(0), '', '无效时间不产出乱码')
assert.equal(applyRecentListFilter([], { sortBy: 'modified', now }).entries.length, 0)
{
  const noMtime = applyRecentListFilter([{ path: 'x.md', type: 'file' }], { sortBy: 'modified', now })
  assert.equal(noMtime.entries.length, 1, '缺 mtime 的文件在纯排序模式下保留(排最后)')
  const noMtimeSince = applyRecentListFilter([{ path: 'x.md', type: 'file' }], { sinceDays: 7, now })
  assert.equal(noMtimeSince.entries.length, 0, '缺 mtime 的文件在 sinceDays 过滤下剔除')
}

console.log('第5组 接线契约')
{
  const agent = readFileSync(new URL('../src/vault-agent.ts', import.meta.url), 'utf8')
  assert.match(agent, /const sortBy = toolText\(call\.arguments\.sortBy, 16\)/, 'list_folder 必须解析 sortBy')
  assert.match(agent, /const sinceDays = clampInt\(call\.arguments\.sinceDays, 0, 0, 365\)/, '必须解析 sinceDays')
  assert.match(agent, /recentRequested \? LIST_FOLDER_MAX_DEPTH : 1/, '时间模式默认扫全库')
  assert.match(agent, /applyRecentListFilter\(entries, \{ sortBy, sinceDays, now: Date\.now\(\) \}\)/, '必须应用过滤')
  assert.match(agent, /totalEntries: finalEntries\.length/, '时间过滤后的 totalEntries 必须等于过滤结果')
  assert.match(agent, /scannedEntries: entries\.length/, '原始扫描量必须单独回传，不能冒充过滤结果')
  assert.match(agent, /path: root\.path \|\| '\/'/, '模糊命中的文件夹必须回传真正解析后的路径')
  assert.match(agent, /mode: 'recent'/, '返回体必须回显时间模式')
  assert.match(agent, /call\.name === 'read_recent_documents'/, '必须实现近期文档批读工具')
  assert.match(agent, /nextCharOffset/, '长文必须能从上一页的字符游标继续')
  assert.match(agent, /nextOffset: index < paths\.length \? index : null/, '批读必须返回续页游标')
  assert.match(agent, /snapshotId/, '批读分页必须固定同一份路径快照')
  assert.match(agent, /readPathForRecentBatch\(/, '批读必须真实提取文档正文')
  assert.match(agent, /!file\.path\.startsWith\(`\$\{outputRoot\}\//, '批读必须排除整个输出目录，避免递归污染')
  const coreSource = readFileSync(new URL('../src/vault-agent-core.ts', import.meta.url), 'utf8')
  assert.match(coreSource, /\| 'read_recent_documents'/, '协议白名单必须包含批读工具')
  assert.match(coreSource, /WEEKLY_BUSINESS_DASHBOARD_MAX_RESULT_CHARS = 1_000_000/, '全量预算只给官方周报 Skill')
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(
    main,
    /runWeeklyBusinessDashboard[\s\S]*\/api\/plugin\/v1\/weekly-business/,
    '官方周报必须进入本机摘要断点管道，而不是把分页原文反复加入聊天上下文',
  )
}

console.log('list_folder recent query tests: ok')

// 2026-08-19 三连修复的回归：搜索短代号、文件夹模糊匹配、云端写入不谎报成功。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = readFileSync(join(root, 'src/vault-search-core.ts'), 'utf8')

console.log('第1组 短代号必须能被搜到（小A/小B 这类客户代号）')
{
  const m = /const tokenPattern = (\/.*\/gu)/.exec(core)
  assert.ok(m, '分词正则必须提取为具名常量')
  const re = new RegExp(m[1].slice(1, -3), 'gu')
  const tok = (q) => q.normalize('NFKC').toLowerCase().match(re) ?? []
  // 事故现场：这两个查询词此前分词为空 → 搜索必返回 0 条
  assert.deepEqual(tok('小B'), ['小b'], '「小B」必须成词')
  assert.deepEqual(tok('小A'), ['小a'], '「小A」必须成词')
  assert.deepEqual(tok('顾晓菲'), ['顾晓菲'])
  assert.deepEqual(tok('output'), ['output'])
  assert.deepEqual(tok('VIP-014'.toLowerCase()), ['vip-014'], '客户编号必须整体成词')
  assert.ok(tok('Belinda妈妈').length > 0, '中英混合必须成词')
  assert.ok(tok('木木').includes('木木'))
  // 单字也要能成词（单字人名/代号）
  assert.ok(tok('甲').length > 0, '单个汉字也要成词')
}

console.log('第2组 泛用单字不污染检索')
{
  assert.ok(core.includes('GENERIC_SINGLE_HAN'), '必须有单字泛词表')
  assert.match(core, /GENERIC_SINGLE_HAN\.has\(token\)/, '单字泛词必须被过滤')
}

console.log('第3组 文件夹名模糊匹配')
{
  const agentCore = readFileSync(join(root, 'src/vault-agent-core.ts'), 'utf8')
  const m = /export function normalizeFolderKey\(name: string\): string \{([\s\S]*?)\n\}/.exec(agentCore)
  assert.ok(m, 'normalizeFolderKey 必须存在')
  const fn = new Function('name', m[1].replace(/: string/g, ''))
  // 事故现场：用户说「output」，真实目录叫「03 output」
  assert.equal(fn('03 output'), fn('output'), '序号前缀不应影响匹配')
  assert.equal(fn('01_客户档案'), fn('客户档案'), '下划线序号不应影响匹配')
  assert.equal(fn('02_Wiki'), fn('wiki'), '大小写与序号都不应影响匹配')
  assert.equal(fn('③ 输出'), fn('输出'), '圈号序号不应影响匹配')
  assert.notEqual(fn('客户档案'), fn('客户资料'), '不同名字不能误判为同一个')

  const agent = readFileSync(join(root, 'src/vault-agent.ts'), 'utf8')
  assert.ok(agent.includes('function matchFoldersByName'), '缺少文件夹匹配函数')
  assert.match(agent, /匹配到多个文件夹，请用准确路径重试/, '多个候选时必须列出让 AI 选')
  assert.match(agent, /相近的有/, '找不到时必须给出相近候选，不能空手而归')
}

console.log('第4组 云端写入不得谎报成功')
{
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  assert.match(main, /data\.executedTools/, '必须读取服务端回传的真实执行工具')
  assert.match(main, /executedTools\.length === 0/, '零工具调用必须被识别')
  assert.match(main, /这一步没有真正保存/, '未写入时必须明确告诉用户')
  assert.ok(
    !/const cloudText[\s\S]{0,200}activityStep\('✅ 云端写入轮完成'/.test(main),
    '不得仅凭有文字返回就显示写入完成',
  )
  // 提示里要给出可操作的补救办法，且不得提计费
  const i = main.indexOf('这一步没有真正保存')
  const hint = main.slice(i, i + 400)
  assert.match(hint, /再说一次|手动录入/, '必须给出补救办法')
  assert.ok(!/积分|扣费/.test(hint), '报错文案不得提计费')
}



console.log('第5组 续跑轮也能切云端写入（0.7.61 技能串联接缝）')
{
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  assert.ok(
    /if \(round === 0 && isCloudToolsTurnRequest\(lastText\)\)/.test(main),
    'round 0 必须无条件认云端标记',
  )
  assert.ok(
    !/round === 0 && intent === 'auto' && isCloudToolsTurnRequest/.test(main),
    '不得再按 intent 锁死云端标记——续跑轮(如档案创建后说「继续」进CRM)会被锁死',
  )
}
console.log('search \& write truth tests: ok')

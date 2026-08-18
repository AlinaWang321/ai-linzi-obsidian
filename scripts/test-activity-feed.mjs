// 对话内活动流(0.7.53)源码契约测试：
// 轮数与每步动作必须实时滚动进对话区(替代 2.5 秒 Notice)，工作中有持续动效，
// 纯问答回合不留任何状态条；旧默认技能目录孤儿必须有启动提醒。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
const styles = readFileSync(join(root, 'styles.css'), 'utf8')

let failures = 0
function assert(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL - ${name}`)
  }
}

console.log('第1组 活动流基建')
assert(
  'postSkillStatus 支持 thinking 参数(更新时保留思考指示)',
  /postSkillStatus\(text: string, replaceId\?: string, thinking = false\)/.test(main),
)
assert('activityBegin 只登记不渲染(纯问答零打扰)', /private activityBegin\(current: string\) \{\s*this\.activityFeed = \{/.test(main))
assert('activityStep 与上一行相同的动作只记一次', main.includes('feed.lines[feed.lines.length - 1] !== line'))
assert('activityEnd 从未渲染过则悄悄丢弃', main.includes('if (!feed?.id) return'))
assert('收尾定格为完成摘要(步数+耗时)', /✅ AI霖子工作台（\$\{feed\.lines\.length\} 步 · \$\{seconds\} 秒）/.test(main))
assert('中断时定格失败原因', main.includes('⚠️ AI霖子工作台已停止：'))

console.log('第2组 三条通道全部接入')
assert('Vault 循环开场登记活动流', main.includes('this.activityBegin(') && /activityBegin\(\s*input\.intent === 'auto'/.test(main))
assert('原生文件引擎步数进活动流', main.includes("'文件操作引擎启动，正在核对相关文件…'"))
assert('原生通道逐工具动作(读取)', /activityStep\(`📄 读取 \$\{path\.split\('\/'\)\.at\(-1\) \?\? path\}`\)/.test(main))
assert('搜索动作带关键词与命中数', /🔍 搜索「\$\{query\.slice\(0, 24\)\}」→ \$\{hitPaths\.length\} 个相关文件/.test(main))
assert('查看文件夹动作', main.includes('📁 查看 ${folder}'))
assert('旧循环轮数进活动流(第 N/12 轮)', /第 \$\{round \+ 1\}\/\$\{VAULT_AGENT_MAX_ROUNDS\} 轮 · 继续翻阅 Vault…/.test(main))
assert('纠正原因对用户可见', main.includes('要求 AI 实际调用本机工具，不接受口头承诺'))
assert('云端写入轮进活动流', main.includes('☁️ 判定为云端写入（任务清单 / 客户管理）'))
assert('引擎切换进活动流', main.includes('🔁 AI 判定要动文件，切换文件操作引擎'))
assert('方案定稿进活动流', main.includes('📋 已生成整理方案，等待你确认'))
assert('调用方成功收尾', main.includes("this.activityEnd('ok')"))
assert('调用方失败收尾后再抛出', /activityEnd\('error', error instanceof Error/.test(main))

assert(
  '动作行转义 Markdown 特殊字符(02_Wiki 不被吃成斜体)',
  /const escape = \(value: string\) => value\.replace\(\/\(\[_\*~`\[\\\]\]\)\/g, '\\\\\$1'\)/.test(main),
)

console.log('第3组 渲染与动效')
assert('状态条行有独立样式类', main.includes("row.addClass('ai-linzi-status-row')"))
assert('进行中(⚙️开头)带动效类', main.includes("if (text.startsWith('⚙️')) row.addClass('ai-linzi-status-working')"))
assert('styles 有旋转指示器', styles.includes('ai-linzi-status-spin'))
assert('styles 有呼吸动效', styles.includes('ai-linzi-status-breathe'))
assert('进行中行右侧有旋转圆环', /\.ai-linzi-status-working \.ai-linzi-msg-body::after/.test(styles))

console.log('第4组 旧 Notice 进度提示不得回流')
assert('轮数不再只闪 Notice', !main.includes('AI霖子正在继续翻阅 Vault（第'))
assert('已读取不再只闪 Notice', !main.includes('AI霖子已读取：'))
assert('已找到不再只闪 Notice', !main.includes('AI霖子已找到 '))
assert('引擎切换不再只闪 Notice', !main.includes('AI霖子正在切换文件操作引擎…'))

console.log('第5组 旧默认技能目录孤儿提醒')
assert('warnOrphanLocalSkills 已定义', main.includes('private warnOrphanLocalSkills()'))
assert('启动时调用', /onLayoutReady\(\(\) => \{\s*this\.rememberCurrentMarkdownFile\(\)\s*this\.warnOrphanLocalSkills\(\)/.test(main))
// 0.7.54 起孤儿检测比对的是旧默认常量（LOCAL_SKILL_ROOT 已改为当前默认值）。
assert('配置仍是旧默认则不提醒', main.includes('if (configured === LEGACY_LOCAL_SKILL_ROOT) return'))
assert('只提醒不代动文件', main.includes('旧技能不会被读取。把技能文件夹整体移动过去即可继续使用'))

if (failures > 0) {
  console.error(`activity feed tests: ${failures} failure(s)`)
  process.exit(1)
}
console.log('activity feed tests: ok')

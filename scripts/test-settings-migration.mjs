// 0.7.54 历史孤儿修复的回归测试：默认值改过的设置必须迁移到当前默认，
// 回退值绝不能指向已废弃目录，密钥指针在读不到值时绝不覆盖。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

// 与 test-vault-agent.mjs 同款加载方式：先 esbuild 打包再 import（源码里跨文件
// import 不带 .ts 扩展名，Node 的类型剥离加载器无法直接解析）。
async function load(entry) {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  const source = bundled.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const { LOCAL_SKILL_ROOT, LEGACY_LOCAL_SKILL_ROOT, normalizeLocalSkillRoot } = await load('src/local-skill-core.ts')
const { isVaultSearchPathExcluded } = await load('src/vault-search-core.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const main = readFileSync(join(root, 'src/main.ts'), 'utf8')

let failures = 0
function assert(name, condition) {
  if (condition) console.log(`  ok - ${name}`)
  else { failures += 1; console.error(`  FAIL - ${name}`) }
}

console.log('第1组 我的 Skills 目录：回退值必须是当前默认，不是旧默认')
assert('当前默认为 05_System/Skills', LOCAL_SKILL_ROOT === '05_System/Skills')
assert('旧默认单独留常量供孤儿检测', LEGACY_LOCAL_SKILL_ROOT === 'system/skills')
assert('清空输入框回退到当前默认（不再写回死目录）', normalizeLocalSkillRoot('') === '05_System/Skills')
assert('空白字符同样回退到当前默认', normalizeLocalSkillRoot('   ') === '05_System/Skills')
assert('非法路径（含 #）回退到当前默认', normalizeLocalSkillRoot('a#b') === '05_System/Skills')
assert('隐藏目录回退到当前默认', normalizeLocalSkillRoot('.secret/skills') === '05_System/Skills')
assert('合法自定义值保持不动', normalizeLocalSkillRoot('我的技能库') === '我的技能库')
assert('孤儿检测用旧常量（不是当前默认）', main.includes('if (configured === LEGACY_LOCAL_SKILL_ROOT) return'))

console.log('第2组 驾驶舱四目录：两跳历史默认值都要迁到当前默认')
const migrationBlock = main.slice(main.indexOf('const cockpitFolderKeys'), main.indexOf('if (migrated) await this.saveSettings()'))
assert('迁移覆盖 output（旧实现完全漏掉）', migrationBlock.includes('cockpitOutputFolder'))
assert('迁移覆盖四个 key', ['cockpitInboxFolder', 'cockpitSourcesFolder', 'cockpitKnowledgeFolder', 'cockpitOutputFolder'].every((key) => migrationBlock.includes(key)))
assert('第一跳中文名在迁移表里', ['收件箱', '原始素材', '知识库', '对外输出'].every((value) => migrationBlock.includes(value)))
assert('第二跳英文名也在迁移表里（旧实现只迁到这里就停了）', ["'inbox'", "'raw'", "'wiki'", "'output'"].every((value) => migrationBlock.includes(value)))
assert('迁移目标是当前默认值而非中间值', migrationBlock.includes('this.settings[key] = DEFAULT_SETTINGS[key]'))
assert('用户自定义值不动（只迁历史默认）', migrationBlock.includes('cockpitLegacyDefaults[key].includes(current)'))

console.log('第3组 密钥条目名：读不到值时保留指针')
assert('token 指针在有值时才归一', /if \(tokenToKeep\) \{\s*this\.settings\.tokenSecretId = DEFAULT_TOKEN_SECRET_ID/.test(main))
assert('AppSecret 指针在有值时才归一', /if \(wechatToKeep\) \{\s*this\.settings\.wechatAppSecretId = DEFAULT_WECHAT_SECRET_ID/.test(main))
assert('读不到值时留日志便于诊断', main.includes('当前读不到值，保留指针不覆盖'))
assert('getApiToken 有存储异常兜底', /getApiToken\(\): string \{\s*try \{/.test(main))
assert('getWechatAppSecret 有存储异常兜底', /getWechatAppSecret\(\): string \{\s*try \{/.test(main))

console.log('第4组 技能目录不进普通搜索（新旧默认都排除）')
assert('旧默认目录排除', isVaultSearchPathExcluded('system/skills/x/SKILL.md'))
assert('当前默认目录排除', isVaultSearchPathExcluded('05_System/Skills/x/SKILL.md'))
assert('大小写不敏感', isVaultSearchPathExcluded('05_system/skills/x/SKILL.md'))
assert('普通笔记不受影响', !isVaultSearchPathExcluded('02_Wiki/客户档案/小B.md'))

console.log('第4.5组 技能目录保护：新旧默认都不许 AI 读写')
const { isProtectedVaultPath, protectedVaultPathReason } = await load('src/vault-agent-core.ts')
assert('当前默认技能目录受保护', isProtectedVaultPath('05_System/Skills/x/SKILL.md'))
assert('旧默认技能目录同样受保护（老用户技能仍在那里）', isProtectedVaultPath('system/skills/x/SKILL.md'))
assert('自定义技能目录受保护', isProtectedVaultPath('我的技能/x.md', '我的技能'))
assert('保护原因归类为 skills-root', protectedVaultPathReason('system/skills/x', '05_System/Skills') === 'skills-root')
assert('普通目录不受影响', !isProtectedVaultPath('02_Wiki/客户档案/小B.md'))

console.log('第5组 撤销文案与「上一次」语义')
assert('撤销上一次不再跳过无移动记录', main.includes('return this.vaultActionHistory.find((record) => !record.undoneAt)'))
assert('删除类记录指向废纸篓', main.includes('这次操作是移入回收站，请到系统废纸篓'))
assert('新建类记录说明需手动删除并列出路径', main.includes('这次操作是新建文件，插件不会自动删除'))
assert('改写类记录诚实说明无法还原', main.includes('插件没有保存改写前的版本，无法自动还原'))
assert('不再对所有无移动记录谎称「只有回收站笔记」', !main.includes('这次操作只有回收站笔记'))

console.log('第6组 僵尸设置字段停止写盘')
assert('workflowFolder 进 Legacy 清单（被解构剔除）', main.includes('workflowFolder?: string'))
assert('vaultSearchDefault 移出活动设置', !/^\s{2}vaultSearchDefault: boolean$/m.test(main))
assert('vaultSearchDefault 不再有默认值写盘', !main.includes('vaultSearchDefault: false'))

if (failures > 0) {
  console.error(`settings migration tests: ${failures} failure(s)`)
  process.exit(1)
}
console.log('settings migration tests: ok')

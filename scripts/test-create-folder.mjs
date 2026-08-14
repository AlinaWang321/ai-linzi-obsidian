import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

async function loadTs(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['obsidian'],
  })
  const module = { exports: {} }
  const fn = new Function('module', 'exports', 'require', result.outputFiles[0].text)
  fn(module, module.exports, require)
  return module.exports
}

const {
  extractCreateFolderBlocks,
  sanitizeFolderPath,
  vaultStructureSettingPatch,
} = await loadTs('src/create-folder.ts')

console.log('[test-create-folder]')

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
for (const [key, path] of [
  ['cockpitInboxFolder', '000_Inbox'],
  ['cockpitSourcesFolder', '01_Raw'],
  ['cockpitKnowledgeFolder', '02_Wiki'],
  ['cockpitOutputFolder', '04_Output'],
  ['localSkillsFolder', '05_System/Skills'],
]) {
  assert.match(mainSource, new RegExp(`${key}: '${path.replace('/', '\\/')}'`))
}
assert.match(mainSource, /创建并应用到 AI霖子（推荐）/)
assert.match(mainSource, /仅创建文件夹/)

// 0.7.14 动态知识库方案：目录 + 驾驶舱绑定 + 本地 Skills 绑定
{
  const text = `已按一人公司驾驶舱准备好方案，请在确认卡中选择。
<<<AI_LINZI_VAULT_STRUCTURE>>>
{"title":"一人公司驾驶舱知识库","folders":["000_Inbox","01_Raw","02_Wiki","03_Dashboard","04_Output","05_System","05_System/Skills","06_Archive"],"bindings":{"inbox":"000_Inbox","sources":"01_Raw","knowledge":"02_Wiki","output":"04_Output","localSkills":"05_System/Skills"}}
<<<AI_LINZI_VAULT_STRUCTURE_END>>>`
  const r = extractCreateFolderBlocks(text)
  assert.equal(r.plans.length, 1)
  assert.deepEqual(r.plans[0].folders, [
    '000_Inbox',
    '01_Raw',
    '02_Wiki',
    '03_Dashboard',
    '04_Output',
    '05_System',
    '05_System/Skills',
    '06_Archive',
  ])
  assert.deepEqual(vaultStructureSettingPatch(r.plans[0]), {
    cockpitInboxFolder: '000_Inbox',
    cockpitSourcesFolder: '01_Raw',
    cockpitKnowledgeFolder: '02_Wiki',
    cockpitOutputFolder: '04_Output',
    localSkillsFolder: '05_System/Skills',
  })
  assert.ok(!r.cleanText.includes('AI_LINZI_VAULT_STRUCTURE'))
  console.log('  ✓ 0. 动态目录方案与插件设置绑定')
}

// 1. 基本提取:四件套 + 标记剥离
{
  const text = '好的,帮你搭好知识库框架。\n<<<新建文件夹>>>\ninbox\nraw\nwiki\noutput\n<<<新建文件夹结束>>>\n建好后驾驶舱会自动亮起来。'
  const r = extractCreateFolderBlocks(text)
  assert.deepEqual(r.folders, ['inbox', 'raw', 'wiki', 'output'])
  assert.equal(r.plans.length, 0)
  assert.ok(!r.cleanText.includes('<<<'))
  assert.ok(r.cleanText.includes('驾驶舱会自动亮起来'))
  console.log('  ✓ 1. 基本提取与标记剥离')
}

// 6. 绑定只能指向本次明确展示的文件夹；畸形 JSON 不执行
{
  const unsafe = extractCreateFolderBlocks(`<<<AI_LINZI_VAULT_STRUCTURE>>>
{"title":"自定义","folders":["资料"],"bindings":{"knowledge":"未展示目录","localSkills":"../hidden"}}
<<<AI_LINZI_VAULT_STRUCTURE_END>>>`)
  assert.deepEqual(unsafe.plans[0].bindings, {})
  const malformed = extractCreateFolderBlocks(`<<<AI_LINZI_VAULT_STRUCTURE>>>
{not-json}
<<<AI_LINZI_VAULT_STRUCTURE_END>>>`)
  assert.equal(malformed.plans.length, 0)
  assert.equal(malformed.invalidStructurePlan, true)
  const hanging = extractCreateFolderBlocks(
    '准备中。\n<<<AI_LINZI_VAULT_STRUCTURE>>>\n{"folders":["资料"]}',
  )
  assert.equal(hanging.plans.length, 0)
  assert.equal(hanging.invalidStructurePlan, true)
  assert.equal(hanging.cleanText, '准备中。')
  console.log('  ✓ 6. 设置绑定范围与畸形协议失败关闭')
}

// 2. 路径净化:防穿越/隐藏目录/危险字符,层级与总长受限
{
  const p1 = sanitizeFolderPath('../../etc/passwd')
  assert.ok(!p1.includes('..') && !p1.startsWith('.') && !p1.startsWith('/'))
  const p2 = sanitizeFolderPath('a/.hidden/b:c*d')
  assert.ok(!p2.split('/').some((seg) => seg.startsWith('.')))
  assert.ok(!/[:*?"<>|#^[\]]/.test(p2))
  const deep = sanitizeFolderPath('a/b/c/d/e')
  assert.equal(deep.split('/').length, 3)
  console.log('  ✓ 2. 路径净化(防穿越/隐藏目录/限深)')
}

// 3. 上限 8 个,重复丢弃
{
  const lines = Array.from({ length: 12 }, (_, i) => `folder${i % 6}`).join('\n')
  const r = extractCreateFolderBlocks(`<<<新建文件夹>>>\n${lines}\n<<<新建文件夹结束>>>`)
  assert.equal(r.folders.length, 6) // 12 行去重后 6 个
  const many = Array.from({ length: 12 }, (_, i) => `f${i}`).join('\n')
  const r2 = extractCreateFolderBlocks(`<<<新建文件夹>>>\n${many}\n<<<新建文件夹结束>>>`)
  assert.equal(r2.folders.length, 8)
  console.log('  ✓ 3. 去重与上限 8 个')
}

// 4. 无标记原样返回
{
  const r = extractCreateFolderBlocks('普通回复。')
  assert.equal(r.folders.length, 0)
  assert.equal(r.cleanText, '普通回复。')
  console.log('  ✓ 4. 无标记原样返回')
}

// 5. 全部净化为空时不出确认卡
{
  const r = extractCreateFolderBlocks('<<<新建文件夹>>>\n///\n...\n<<<新建文件夹结束>>>')
  assert.equal(r.folders.length, 0)
  console.log('  ✓ 5. 净化后为空丢弃')
}

console.log('[test-create-folder] 全部通过')

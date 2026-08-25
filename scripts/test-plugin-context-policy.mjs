import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/plugin-context-policy.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const policy = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

assert.equal(policy.inferPluginSkillContextMode('处理当前打开的这篇咨询逐字稿'), 'source-only')
assert.equal(policy.inferPluginSkillContextMode('按我的写作风格写一篇公众号文章'), 'personalized-content')
assert.equal(policy.inferPluginSkillContextMode('统计整个 Vault 并生成经营周报看板'), 'vault-data')
assert.equal(
  policy.inferPluginSkillContextMode('结合我的知识库和长期记忆做商业教练诊断'),
  'business-coach',
)
assert.equal(
  policy.pluginContextModeForTurn({ currentNoteOnly: true, skillManagement: false }),
  'source-only',
)
assert.equal(
  policy.pluginContextModeForTurn({
    currentNoteOnly: true,
    skillManagement: false,
    localSkillText: '按我的写作风格写一篇公众号文章',
  }),
  'personalized-content',
  '内容创作 Skill 即使以当前笔记为素材，也应保留相关个性化上下文',
)
assert.equal(
  policy.pluginContextModeForTurn({
    currentNoteOnly: false,
    skillManagement: false,
    localSkillText: '写一篇公众号文章',
    manifestMode: 'source-only',
  }),
  'source-only',
  'manifest 显式模式优先于启发式分类',
)
assert.equal(
  policy.pluginContextModeForTurn({ currentNoteOnly: false, skillManagement: false }),
  undefined,
  '普通主对话不得被强制切成精简模式',
)

console.log('插件任务上下文分级测试通过')

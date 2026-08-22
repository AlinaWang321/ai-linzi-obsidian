import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/local-skill-turn.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const core = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const screenshotRequest =
  '用经验萃取 Skill 搜索 01_Raw/课程逐字稿 文件夹里关于 Obsidian 的资料，列出真实文件路径，先不要写入。'
assert.deepEqual(core.resolveLocalSkillTurnPolicy('create-note', screenshotRequest), {
  output: 'chat',
  forceOrganize: false,
  readOnly: true,
})
assert.deepEqual(
  core.resolveLocalSkillTurnPolicy('create-note', '用经验萃取 Skill 处理当前笔记并创建方法论卡片'),
  { output: 'create-note', forceOrganize: true, readOnly: false },
)
assert.deepEqual(
  core.resolveLocalSkillTurnPolicy('create-artifact', '先搜索资料并列出真实路径，不要写入。'),
  { output: 'chat', forceOrganize: false, readOnly: true },
)
assert.deepEqual(
  core.resolveLocalSkillTurnPolicy(
    'create-note',
    '追加到客户甲.md，但确认前不要真的写入',
  ),
  { output: 'create-note', forceOrganize: true, readOnly: false },
  '“确认前不要写入”仍表示需要预览确认，不能误降为只读',
)
assert.deepEqual(core.resolveLocalSkillTurnPolicy('chat', '搜索整个 Vault 并回答我'), {
  output: 'chat',
  forceOrganize: false,
  readOnly: false,
})

console.log('[test-local-skill-turn] 5 组本轮输出策略全部通过')

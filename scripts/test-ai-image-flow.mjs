import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(main, /🖼️ 用 AI 生图/)
assert.match(
  main,
  /const illustrationEdit = isArticleIllustrationEditIntent\(text\)[\s\S]*?const singleIllustration = Boolean\([\s\S]*?!illustrationEdit && !singleIllustration && isNoteEditIntent\(text\)/,
  '修改或新增图片的请求不能误送进正文局部补丁协议',
)
assert.match(actions, /\/api\/plugin\/v1\/images\/generate/)
assert.match(actions, /mode: 'single'/, '当前笔记补图必须走插件专用单图接口')
assert.match(main, /noteImageIntent: singleIllustration/)
assert.match(main, /generateArticleIllustrationFromChat/)
assert.match(main, /imageResult/)
assert.match(main, /insertChatIllustrationIntoNote/)
assert.match(main, /插入当前笔记/)
assert.match(main, /重新生成/)
assert.match(actions, /参考图（可选）/)
assert.match(actions, /确认替换原图/)
assert.match(actions, /value\.split\(\/\[\\n\/／\|｜\]\+\//, '完整标题里的中文顿号不能被拆散')
assert.match(actions, /decision !== 'replace'/)
assert.ok(
  actions.indexOf("decision !== 'replace'") < actions.indexOf('modifyBinary(request.image.file'),
  '必须先确认替换，再修改原图文件',
)
assert.doesNotMatch(actions, /生成修改版并覆盖原图/)
assert.doesNotMatch(actions, /预计最多\s*\$\{?.*积分/)
assert.doesNotMatch(`${actions}\n${main}`, /Seedream/i)

console.log('AI image preview and confirmation tests passed')

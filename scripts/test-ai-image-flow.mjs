import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.doesNotMatch(main, /AI 生图模式/)
assert.doesNotMatch(main, /imageMode|sendImageModePrompt|setImageMode|refreshImageModeUi/)
assert.doesNotMatch(main, /智能搜索 Vault|默认智能搜索 Vault/)
assert.match(main, /const modelDecidesVaultUse =/)
assert.match(main, /\? 'organize'\s*: 'auto'/)
assert.match(main, /普通闲聊会在首轮直接回答/)
assert.doesNotMatch(main, /shouldUseVaultAgent/)
assert.match(main, /title: '添加文件或图片（Pro）'/)
assert.match(main, /setTitle\('从 Vault 选择图片'\)/)
assert.match(main, /setTitle\('从电脑上传图片'\)/)
assert.match(main, /requireProAccess\('AI 生图'\)/)
assert.match(main, /继续修改这张/)
assert.match(main, /this\.inputEl\.value = '修改这张图：'/)
assert.match(
  main,
  /const requestedImageIndex = requestedAiImageIndex\(text\)[\s\S]*?isDirectAiImageEditRequest\(text\) && requestedImageIndex[\s\S]*?this\.activeImageMessageId = target\.message\.id/,
  '点名修改第 N 张时必须先锁定对应图片',
)
assert.match(
  main,
  /if \(requestedIndex\)[\s\S]*?if \(latestBatchId\)[\s\S]*?return null\s*}\s*return null\s*}\s*return this\.latestAiImageResult\(\)/,
  '点名图片不存在时必须报错，不能默认改最后一张',
)
assert.match(
  main,
  /const ratio = editTarget && request\.preserveOriginalRatio[\s\S]*?editTarget\.result\.ratio[\s\S]*?: request\.ratio/,
  '改图默认保留原比例，明确改平台画布时使用新比例',
)
assert.match(main, /request\.preserveOriginalRatio,/)
assert.match(actions, /\/api\/plugin\/v1\/images\/generate/)
assert.match(actions, /export type AiImageRatio = '2\.35:1' \| '16:9' \| '3:4' \| '1:1'/)
assert.match(actions, /preserveOriginalRatio = false/)
assert.match(actions, /preserveOriginalRatio,/)
assert.match(actions, /export async function saveAiImageToVault/)
assert.match(actions, /mode: 'single'/, '当前笔记补图必须走插件专用单图接口')
assert.match(
  main,
  /const illustrationEdit = isArticleIllustrationEditIntent\(text\)[\s\S]*?const directNoteEdit = Boolean\([\s\S]*?!illustrationEdit[\s\S]*?!singleIllustration[\s\S]*?isNoteEditIntent\(text\)/,
  '修改或新增文章配图的请求不能误送进正文局部补丁协议',
)
assert.match(main, /noteImageIntent: singleIllustration/)
assert.match(main, /generateArticleIllustrationFromChat/)
assert.match(main, /insertChatIllustrationIntoNote/)
assert.match(main, /插入当前笔记/)
assert.match(actions, /参考图（可选）/)
assert.match(main, /illustrationCharacterReferencePath/)
assert.match(actions, /\.setName\('我的专属人偶'\)/)
assert.match(actions, /requireProAccess\('我的专属人偶'\)/)
assert.match(actions, /确认替换原图/)
assert.ok(
  actions.indexOf("decision !== 'replace'") < actions.indexOf('modifyBinary(request.image.file'),
  '必须先确认替换，再修改原图文件',
)
assert.doesNotMatch(`${actions}\n${main}`, /Seedream/i)
assert.doesNotMatch(main, /GPT Image 2/i, '公开插件 UI 不应暴露私有后端的具体图片模型')

console.log('conversational AI image and Vault activation tests passed')

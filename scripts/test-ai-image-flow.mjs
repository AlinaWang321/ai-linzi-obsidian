import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(main, /AI 生图模式/)
assert.doesNotMatch(main, /🖼️ 用 AI 生图/, '顶部不应再保留与生图模式勾选重复的按钮')
assert.match(main, /text: '调用技能'/)
assert.match(main, /text: '存入知识库'/)
assert.match(main, /title: '精确选择文件或文件夹（Pro）'/)
assert.match(main, /text: '内容看板'/)
assert.match(main, /requireProAccess\('AI 生图模式'\)/)
assert.match(main, /“\$\{featureName\}”是 Pro 及以上会员功能/)
assert.match(main, /CAPABILITIES_CACHE_TTL_MS = 5 \* 60 \* 1000/)
assert.match(main, /\['1:1', '1:1 方图'\]/)
assert.match(main, /sendImageModePrompt/)
assert.doesNotMatch(main, /runAiImageGeneration/)
assert.match(main, /aiImageResult/)
assert.match(main, /saveAiImageToVault/)
assert.match(main, /继续修改这张/)
assert.match(main, /参考上一张图/)
assert.match(main, /preserveRicherLocalCopy/)
assert.match(main, /下一轮会继续修改上一张图/)
assert.match(main, /下一轮会生成一张新图/)
assert.match(
  main,
  /const illustrationEdit = isArticleIllustrationEditIntent\(text\)[\s\S]*?const singleIllustration = Boolean\([\s\S]*?!illustrationEdit && !singleIllustration && isNoteEditIntent\(text\)/,
  '修改或新增图片的请求不能误送进正文局部补丁协议',
)
assert.match(actions, /\/api\/plugin\/v1\/images\/generate/)
assert.match(actions, /export type AiImageRatio = '16:9' \| '3:4' \| '1:1'/)
assert.match(actions, /export async function saveAiImageToVault/)
assert.match(actions, /sessionId/)
assert.match(actions, /mode: 'single'/, '当前笔记补图必须走插件专用单图接口')
assert.match(actions, /ratio: options\?\.ratio \?\? '16:9'/)
assert.match(actions, /referenceImages: options\?\.referenceImageDataUrls\?\.slice\(0, 3\)/)
assert.match(
  main,
  /generateArticleIllustrationFromChat\([\s\S]*?referenceImageDataUrls: references[\s\S]*?ratio: this\.imageRatio[\s\S]*?ratio = articleCandidate\.ratio \?\? this\.imageRatio/,
  '结合当前笔记生图也必须传递用户选择的比例',
)
assert.match(main, /noteImageIntent: singleIllustration/)
assert.match(main, /generateArticleIllustrationFromChat/)
assert.match(main, /imageResult/)
assert.match(main, /insertChatIllustrationIntoNote/)
assert.match(main, /插入当前笔记/)
assert.match(main, /重新生成/)
assert.match(actions, /参考图（可选）/)
assert.match(main, /illustrationCharacterReferencePath/)
assert.match(actions, /IllustrationSetupModal/)
assert.match(actions, /\.setName\('我的专属人偶'\)/)
assert.match(actions, /requireProAccess\('我的专属人偶'\)/)
assert.match(actions, /if \(!\(await plugin\.hasProAccess\(\)\)\) return undefined/)
assert.match(actions, /升级 Pro 后可以设置自己的角色/)
assert.match(actions, /恢复通用人偶/)
assert.match(actions, /characterReferenceImageDataUrl/)
assert.match(actions, /公众号配图专属人偶\.jpg/)
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

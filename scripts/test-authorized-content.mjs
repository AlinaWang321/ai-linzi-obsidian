import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const selector = await readFile(new URL('../src/content-selector.ts', import.meta.url), 'utf8')

assert.match(main, /private authorizedContentPaths: string\[\] = \[\]/)
assert.match(main, /private uploadedSpreadsheetAttachments:/)
assert.match(main, /private chatImageAttachments: LocalImageReference\[\] = \[\]/)
assert.match(main, /requireProAccess\('多笔记与文件夹授权'\)/)
assert.match(main, /requireProAccess\('主对话图片附件'\)/)
assert.match(
  main,
  /authorizedContent = localSkillCurrentOnly \|\| skillUpdaterTurn\s*\?\s*undefined\s*:\s*await this\.authorizedContentContext\(noteContext\?\.path\)/,
  '单文件受限 Skill 和 Skill 更新专用轮都不能顺带发送附件栏里的其他资料',
)
assert.match(main, /vaultAccess:[\s\S]{0,160}this\.authorizedContentPaths\.length === 0[\s\S]{0,100}this\.uploadedSpreadsheetAttachments\.length === 0/)
const modelRouting = main.match(/const modelDecidesVaultUse =[\s\S]*?const useVaultAgent/)?.[0] ?? ''
assert.doesNotMatch(modelRouting, /authorizedContentPaths/, '精确授权资料仍应能让 Luna 输出只新建的成品方案')
assert.match(main, /imageAttachments: imageAttachments\.map/)
assert.match(main, /从 Vault 选择图片/)
assert.match(main, /从电脑上传图片/)
assert.match(main, /从电脑上传 Excel（\.xlsx）/)
assert.match(main, /下一条消息带上/)
assert.match(main, /this\.clearChatImageAttachments\(\)/)
assert.match(main, /private loadConvo[\s\S]*?this\.clearAuthorizedContent\(\)/)
assert.match(main, /enterInterviewMode\(\)[\s\S]*?this\.clearAuthorizedContent\(\)/)
assert.match(main, /exitInterviewMode\(\)[\s\S]*?this\.clearAuthorizedContent\(\)/)
const savedConvo = main.match(/interface SavedConvo \{[\s\S]*?\n\}/)?.[0] ?? ''
assert.doesNotMatch(savedConvo, /authorizedContent/, '授权路径和正文不能写进插件历史')
assert.doesNotMatch(savedConvo, /Spreadsheet|xlsx/i, '电脑 Excel 的正文和文件身份不能写进插件历史')

assert.match(selector, /文件夹浏览、搜索与勾选全部发生在用户自己的 Vault/)
assert.match(selector, /getFiles\(\)/)
assert.match(selector, /isLocalSearchExtension/)
assert.match(selector, /getAllLoadedFiles\(\)/)
assert.match(selector, /搜索全部文件的标题或路径/)
assert.match(selector, /添加当前文件夹/)
assert.match(selector, /isInsideFolder/)
assert.match(selector, /expandedFolders = new Set<string>\(\[''\]\)/)
assert.match(selector, /renderFolderChildren/)
assert.match(selector, /aria-expanded/)
assert.match(selector, /maxFiles/)
assert.match(selector, /maxTotalChars/)
assert.match(selector, /maxPerFileChars/)
assert.match(selector, /作为长文任务处理/)
assert.match(selector, /mode: 'long-document'/)

console.log('authorized content tests: ok')

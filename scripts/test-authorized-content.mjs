import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const selector = await readFile(new URL('../src/content-selector.ts', import.meta.url), 'utf8')

assert.match(main, /private authorizedContentPaths: string\[\] = \[\]/)
assert.match(main, /requireProAccess\('多笔记与文件夹授权'\)/)
assert.match(main, /authorizedContent = await this\.authorizedContentContext\(noteContext\?\.path\)/)
assert.match(main, /authorizedContent,\s*vaultSearch: vaultSearch\.context,\s*noteEdit/)
assert.match(main, /private loadConvo[\s\S]*?this\.clearAuthorizedContent\(\)/)
assert.match(main, /enterInterviewMode\(\)[\s\S]*?this\.clearAuthorizedContent\(\)/)
assert.match(main, /exitInterviewMode\(\)[\s\S]*?this\.clearAuthorizedContent\(\)/)
const savedConvo = main.match(/interface SavedConvo \{[\s\S]*?\n\}/)?.[0] ?? ''
assert.doesNotMatch(savedConvo, /authorizedContent/, '授权路径和正文不能写进插件历史')

assert.match(selector, /文件夹浏览、搜索与勾选全部发生在用户自己的 Vault/)
assert.match(selector, /getMarkdownFiles\(\)/)
assert.match(selector, /getAllLoadedFiles\(\)/)
assert.match(selector, /搜索全部笔记的标题或路径/)
assert.match(selector, /添加当前文件夹/)
assert.match(selector, /isInsideFolder/)
assert.match(selector, /expandedFolders = new Set<string>\(\[''\]\)/)
assert.match(selector, /renderFolderChildren/)
assert.match(selector, /aria-expanded/)
assert.match(selector, /maxFiles/)
assert.match(selector, /maxTotalChars/)
assert.match(selector, /maxPerFileChars/)

console.log('authorized content tests: ok')

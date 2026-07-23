import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const actions = await readFile(new URL('../src/actions.ts', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(actions, /private useCurrentNote = false/)
assert.match(actions, /使用当前笔记作为选题素材/)
assert.match(actions, /sourceMaterial: note \? stripFrontmatter\(note\.text\) : undefined/)
assert.doesNotMatch(actions, /TOPIC_RADAR_CONTEXT_MAX/)
assert.doesNotMatch(actions, /const note = await getActiveNote\(plugin\)[\s\S]{0,200}选题雷达/)
assert.match(main, /主对话带上当前笔记/)
assert.match(main, /技能是否使用当前笔记，以弹窗说明为准/)

console.log('topic radar note opt-in tests passed')

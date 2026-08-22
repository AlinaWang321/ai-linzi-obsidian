import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.match(main, /ev\.key === 'Enter' && \(ev\.metaKey \|\| ev\.ctrlKey\)/)
assert.doesNotMatch(main, /ev\.key === 'Enter' && !ev\.shiftKey/)
assert.doesNotMatch(main, /Enter 发送,Shift\+Enter 换行/)
assert.match(main, /Mac \/ Windows：Control \+ Enter 发送/)
assert.match(main, /cls: 'ai-linzi-send'/)
assert.match(main, /cls: 'ai-linzi-stop'/)
assert.match(main, /this\.activeTurnAbort\.abort\(\)/)
assert.match(main, /signal: init\.signal/)
assert.match(main, /已经发出的这一轮可能已产生少量积分/)
assert.match(main, /aria-label.*发送消息/)

console.log('chat input shortcut tests passed')

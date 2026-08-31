import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

const writer = actions.slice(
  actions.indexOf('export async function runWechatWriter'),
  actions.indexOf('export async function runDistribute'),
)

assert.match(writer, /clientRequestId: requestId/)
assert.match(writer, /setPendingWechatWriterJob/)
assert.match(writer, /recoverPendingWechatWriter/)
assert.match(writer, /operations\/\$\{encodeURIComponent\(job\.requestId\)\}/)
assert.match(writer, /status === 'succeeded'/)
assert.match(writer, /status === 'failed'/)
assert.match(writer, /AI霖子任务ID/)
assert.match(writer, /getMarkdownFiles\(\)\.find/)
assert.match(writer, /上次请求没有到达服务器/)
assert.doesNotMatch(writer, /clientRequestId:[\s\S]{0,500}clientRequestId:/)

assert.match(main, /pendingWechatWriterJob\?: unknown/)
assert.match(main, /storedPendingWechatWriterJob/)
assert.match(main, /pendingWechatWriterJob: this\.pendingWechatWriterJob \?\? undefined/)
assert.match(main, /void recoverPendingWechatWriter\(this\)/)
assert.match(main, /this\.pluginUnloaded = true/)

console.log('wechat writer disconnect recovery tests: ok')

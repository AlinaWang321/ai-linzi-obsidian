import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

function listTypeScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

const sourceFiles = listTypeScriptFiles(fileURLToPath(new URL('../src/', import.meta.url)))
const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')

for (const legacyPath of ['/api/skills/', '/api/me/knowledge', '/api/plugin/chat']) {
  assert.equal(
    source.includes(legacyPath),
    false,
    `插件源码仍在直连旧接口：${legacyPath}`,
  )
}

for (const stablePath of [
  '/api/plugin/v1/chat',
  '/api/plugin/v1/skills/topic-radar',
  '/api/plugin/v1/skills/wechat-writer',
  '/api/plugin/v1/skills/wechat-interview',
  '/api/plugin/v1/skills/wechat-distribute',
  '/api/plugin/v1/skills/sales-review',
  '/api/plugin/v1/knowledge/suggest-section',
  '/api/plugin/v1/knowledge/sections/',
  '/api/plugin/v1/article-illustration',
]) {
  assert.equal(source.includes(stablePath), true, `缺少插件稳定接口：${stablePath}`)
}

console.log('✓ 插件所有远程能力均通过 /api/plugin/v1/* 调用')

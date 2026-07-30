import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

async function loadTs(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['obsidian'],
  })
  const module = { exports: {} }
  const fn = new Function('module', 'exports', 'require', result.outputFiles[0].text)
  fn(module, module.exports, require)
  return module.exports
}

const { extractCreateFolderBlocks, sanitizeFolderPath } = await loadTs('src/create-folder.ts')

console.log('[test-create-folder]')

// 1. 基本提取:四件套 + 标记剥离
{
  const text = '好的,帮你搭好知识库框架。\n<<<新建文件夹>>>\ninbox\nraw\nwiki\noutput\n<<<新建文件夹结束>>>\n建好后驾驶舱会自动亮起来。'
  const r = extractCreateFolderBlocks(text)
  assert.deepEqual(r.folders, ['inbox', 'raw', 'wiki', 'output'])
  assert.ok(!r.cleanText.includes('<<<'))
  assert.ok(r.cleanText.includes('驾驶舱会自动亮起来'))
  console.log('  ✓ 1. 基本提取与标记剥离')
}

// 2. 路径净化:防穿越/隐藏目录/危险字符,层级与总长受限
{
  const p1 = sanitizeFolderPath('../../etc/passwd')
  assert.ok(!p1.includes('..') && !p1.startsWith('.') && !p1.startsWith('/'))
  const p2 = sanitizeFolderPath('a/.hidden/b:c*d')
  assert.ok(!p2.split('/').some((seg) => seg.startsWith('.')))
  assert.ok(!/[:*?"<>|#^[\]]/.test(p2))
  const deep = sanitizeFolderPath('a/b/c/d/e')
  assert.equal(deep.split('/').length, 3)
  console.log('  ✓ 2. 路径净化(防穿越/隐藏目录/限深)')
}

// 3. 上限 8 个,重复丢弃
{
  const lines = Array.from({ length: 12 }, (_, i) => `folder${i % 6}`).join('\n')
  const r = extractCreateFolderBlocks(`<<<新建文件夹>>>\n${lines}\n<<<新建文件夹结束>>>`)
  assert.equal(r.folders.length, 6) // 12 行去重后 6 个
  const many = Array.from({ length: 12 }, (_, i) => `f${i}`).join('\n')
  const r2 = extractCreateFolderBlocks(`<<<新建文件夹>>>\n${many}\n<<<新建文件夹结束>>>`)
  assert.equal(r2.folders.length, 8)
  console.log('  ✓ 3. 去重与上限 8 个')
}

// 4. 无标记原样返回
{
  const r = extractCreateFolderBlocks('普通回复。')
  assert.equal(r.folders.length, 0)
  assert.equal(r.cleanText, '普通回复。')
  console.log('  ✓ 4. 无标记原样返回')
}

// 5. 全部净化为空时不出确认卡
{
  const r = extractCreateFolderBlocks('<<<新建文件夹>>>\n///\n...\n<<<新建文件夹结束>>>')
  assert.equal(r.folders.length, 0)
  console.log('  ✓ 5. 净化后为空丢弃')
}

console.log('[test-create-folder] 全部通过')

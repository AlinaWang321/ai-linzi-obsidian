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

const { extractCreateNoteBlocks, sanitizeNoteTitle } = await loadTs('src/create-note.ts')

console.log('[test-create-note]')

// 1. 基本提取:标记剥离 + 标题/正文正确
{
  const text = '好的,我整理好了。\n<<<新建笔记 标题=我的定位说明>>>\n# 定位\n帮高管做个人品牌。\n<<<新建笔记结束>>>\n还需要别的吗?'
  const r = extractCreateNoteBlocks(text)
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].title, '我的定位说明')
  assert.ok(r.blocks[0].body.includes('# 定位'))
  assert.ok(!r.cleanText.includes('<<<'))
  assert.ok(r.cleanText.includes('还需要别的吗'))
  console.log('  ✓ 1. 基本提取与标记剥离')
}

// 2. 无标记文本原样返回
{
  const r = extractCreateNoteBlocks('普通回复,没有标记。')
  assert.equal(r.blocks.length, 0)
  assert.equal(r.cleanText, '普通回复,没有标记。')
  console.log('  ✓ 2. 无标记原样返回')
}

// 3. 上限 3 个,超出忽略
{
  const one = (n) => `<<<新建笔记 标题=笔记${n}>>>\n正文${n}\n<<<新建笔记结束>>>`
  const r = extractCreateNoteBlocks([1, 2, 3, 4].map(one).join('\n'))
  assert.equal(r.blocks.length, 3)
  console.log('  ✓ 3. 单条回复最多 3 块')
}

// 4. 标题净化:验证安全属性——无路径/危险字符、不以点开头、限长
{
  const t1 = sanitizeNoteTitle('../../etc/passwd')
  assert.ok(t1.length > 0 && !t1.includes('/') && !t1.includes('\\') && !t1.startsWith('.'))
  const t2 = sanitizeNoteTitle('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')
  assert.ok(!/[\\/:*?"<>|#^[\]]/.test(t2))
  assert.ok(sanitizeNoteTitle('x'.repeat(200)).length <= 60)
  console.log('  ✓ 4. 标题净化(防路径注入)')
}

// 5. 空标题/空正文的块被丢弃,不产生确认卡
{
  const r = extractCreateNoteBlocks('<<<新建笔记 标题=////>>>\n正文\n<<<新建笔记结束>>>')
  assert.equal(r.blocks.length, 0)
  console.log('  ✓ 5. 净化后空标题丢弃')
}

console.log('[test-create-note] 全部通过')

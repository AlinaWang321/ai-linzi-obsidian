// 拖拽 / 粘贴附件（0.7.57）：真跑分类与校验逻辑，外加 UI 接线的源码契约。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundled = await build({
  entryPoints: [join(root, 'src/chat-drop-core.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { classifyDropped, planDroppedFiles, dropSummary, extensionOf, DROP_IMAGE_MAX_BYTES } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

console.log('第1组 类型判定')
assert.equal(classifyDropped('截图.png'), 'image')
assert.equal(classifyDropped('照片.JPG'), 'image', '扩展名大小写不敏感')
assert.equal(classifyDropped('图.webp'), 'image')
assert.equal(classifyDropped('逐字稿.md'), 'document')
assert.equal(classifyDropped('合同.pdf'), 'document')
assert.equal(classifyDropped('课件.pptx'), 'document')
assert.equal(classifyDropped('客户数据.xlsx'), 'document')
assert.equal(classifyDropped('客户数据.xls'), 'unsupported')
assert.equal(classifyDropped('存档.zip'), 'unsupported')
assert.equal(classifyDropped('视频.mp4'), 'unsupported')
// 剪贴板截图常常没有文件名，只能靠 MIME 判定
assert.equal(classifyDropped('', 'image/png'), 'image', '无名截图按 MIME 认')
assert.equal(classifyDropped('image', 'image/jpeg'), 'image')
assert.equal(classifyDropped('', 'image/gif'), 'unsupported', 'GIF 不在服务端白名单内')
assert.equal(extensionOf('a.tar.gz'), 'gz')
assert.equal(extensionOf('无扩展名'), '')
assert.equal(extensionOf('.hidden'), '', '以点开头不算扩展名')

console.log('第2组 图片数量上限（含已有附件）')
{
  const four = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) => ({ name }))
  const fresh = planDroppedFiles(four, 0)
  assert.equal(fresh.images.length, 3, '单次最多 3 张')
  assert.equal(fresh.rejections.length, 1)
  assert.match(fresh.rejections[0], /最多 3 张图片/)
  const partial = planDroppedFiles(four, 2)
  assert.equal(partial.images.length, 1, '已有 2 张时只能再加 1 张')
  assert.equal(partial.rejections.length, 3)
  const full = planDroppedFiles([{ name: 'x.png' }], 3)
  assert.equal(full.images.length, 0)
  assert.match(full.rejections[0], /已跳过/)
}

console.log('第3组 单张体积上限')
{
  const plan = planDroppedFiles(
    [
      { name: '大图.png', size: DROP_IMAGE_MAX_BYTES + 1 },
      { name: '正常图.png', size: 1024 },
    ],
    0,
  )
  assert.equal(plan.images.length, 1)
  assert.equal(plan.images[0].name, '正常图.png')
  assert.match(plan.rejections[0], /超过 8MB/)
  // 超大图不占用配额：后面的图仍能进
  assert.equal(plan.rejections.length, 1)
}

console.log('第4组 资料文件必须在知识库内')
{
  const plan = planDroppedFiles(
    [
      { name: '逐字稿.md', vaultPath: '01_Raw/逐字稿.md' },
      { name: '外部合同.pdf' },
    ],
    0,
  )
  assert.equal(plan.documents.length, 1)
  assert.equal(plan.documents[0].vaultPath, '01_Raw/逐字稿.md')
  assert.match(plan.rejections[0], /不在知识库里.*放进 Obsidian 库/)
}

console.log('第4b组 电脑 Excel 例外 + 同名文件身份稳定')
{
  const plan = planDroppedFiles(
    [
      { name: '客户数据.xlsx', sourceIndex: 0 },
      { name: '客户数据.xlsx', sourceIndex: 1 },
      { name: '旧表.xls', sourceIndex: 2 },
    ],
    0,
  )
  assert.equal(plan.documents.length, 2, '电脑 .xlsx 应直接进入本地解析')
  assert.deepEqual(plan.documents.map((item) => item.sourceIndex), [0, 1], '同名文件必须保留各自来源索引')
  assert.match(plan.rejections[0], /旧版 Excel.*另存为.*\.xlsx/)
}

console.log('第5组 混合拖入 + 拒绝理由必须说人话')
{
  const plan = planDroppedFiles(
    [
      { name: '聊天截图.png', size: 200_000 },
      { name: '客户逐字稿.docx', vaultPath: '01_Raw/客户逐字稿.docx' },
      { name: '压缩包.zip' },
    ],
    0,
  )
  assert.equal(plan.images.length, 1)
  assert.equal(plan.documents.length, 1)
  assert.equal(plan.rejections.length, 1)
  assert.match(plan.rejections[0], /暂不支持.*PNG\/JPG\/WebP/)
  assert.ok(
    plan.rejections.every((reason) => !/undefined|null|\[object/.test(reason)),
    '拒绝理由不得出现技术噪声',
  )
  assert.equal(dropSummary(plan), '已添加 1 张图片 和 1 份资料')
}
assert.equal(dropSummary({ images: [], documents: [], rejections: ['x'] }), '', '全被拒时不报成功')
assert.equal(dropSummary({ images: [{ name: 'a.png' }], documents: [], rejections: [] }), '已添加 1 张图片')

console.log('第6组 UI 接线契约')
{
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  assert.ok(main.includes('this.registerAttachmentDropAndPaste(footer)'), '输入区必须注册拖拽/粘贴')
  assert.match(main, /registerDomEvent\(this\.inputEl, 'paste'/, '粘贴事件必须用 registerDomEvent 注册（随视图卸载）')
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    assert.match(main, new RegExp(`registerDomEvent\\(zone, '${type}'`), `缺少 ${type} 处理`)
  }
  assert.ok(
    main.includes("if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'"),
    'dragover 必须声明 copy 效果',
  )
  assert.ok(main.includes('event.preventDefault()'), 'drop 前必须阻止默认行为，否则浏览器直接打开文件')
  assert.ok(main.includes("zone.toggleClass('ai-linzi-drop-active', active)"), '拖拽必须有视觉反馈')
  assert.ok(main.includes('vaultFilesFromDrag'), '必须支持从 Obsidian 文件树拖拽')
  assert.match(main, /files\.map\(\(file, sourceIndex\)/, '候选附件必须记录稳定来源索引')
  assert.match(main, /files\[candidate\.sourceIndex\]/, '读取时必须按来源索引取原文件，不能按同名查第一份')
  assert.ok(main.includes('uploadedSpreadsheetAttachments'), '电脑 Excel 必须只在当前进程保留解析文字')
  assert.ok(main.includes('从电脑上传 Excel（.xlsx）'), '附件菜单必须有可发现的 Excel 入口')
  assert.ok(main.includes("requireProAccess('主对话图片附件')"), '图片附件仍走 Pro 权限闸')
  assert.ok(
    main.includes("new Notice('长文任务不能同时带附件，请先清除长文任务')"),
    '长文任务期间必须拒绝附件（与既有 📎 行为一致）',
  )
  assert.ok(
    !main.includes('planDroppedFiles(candidates, 3)'),
    '已有图片数必须实时读取，不能写死',
  )
  const styles = readFileSync(join(root, 'styles.css'), 'utf8')
  assert.ok(styles.includes('.ai-linzi-drop-active'), '缺少拖拽高亮样式')
  assert.match(styles, /content: '松手即可添加图片或资料'/, '拖拽时要有明确提示语')
}

console.log('第7组 Mac / Windows 双平台')
{
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  // 粘贴必须走浏览器原生 paste 事件——绑平台快捷键就会漏掉另一个平台
  assert.match(main, /registerDomEvent\(this\.inputEl, 'paste'/)
  assert.ok(
    !/metaKey[^\n]*paste|paste[^\n]*metaKey/.test(main),
    '不得用 metaKey/ctrlKey 判断粘贴：Cmd+V 与 Ctrl+V 由系统派发同一个 paste 事件',
  )
  assert.ok(
    !/navigator\.platform|process\.platform|isMacOS|isWin/.test(
      main.slice(main.indexOf('registerAttachmentDropAndPaste'), main.indexOf('dragCarriesAttachment')),
    ),
    '拖拽粘贴实现不得做平台分支：两平台走同一套浏览器事件',
  )
  assert.ok(main.includes('Windows'), '注释需说明两平台行为，便于后续维护')
  // 从网页拖图片（两平台都常见）只带 URL，不能静默失败
  assert.ok(
    main.includes('网页上的图片请先保存到电脑或知识库，再拖进来'),
    '只有 URL 没有文件时必须明确提示',
  )
  // Windows 资源管理器与 Mac Finder 都通过 Files 类型声明
  assert.ok(main.includes("[...transfer.types].includes('Files')"), '必须识别文件拖拽')
  // Obsidian 内部路径两平台统一用 /，解析不得引入反斜杠假设
  const dragParser = main.slice(main.indexOf('vaultFilesFromDrag'), main.indexOf('acceptDroppedFiles(files'))
  assert.ok(!dragParser.includes('\\\\'), 'Vault 路径解析不得处理 Windows 反斜杠（Obsidian 内部统一 /）')

  const styles = readFileSync(join(root, 'styles.css'), 'utf8')
  const dropBlock = styles.slice(styles.indexOf('.ai-linzi-drop-active'))
  assert.ok(
    dropBlock.includes('background: var(--background-modifier-hover)'),
    'color-mix 之前要有可见的兜底底色（旧版本 Obsidian 可能不支持）',
  )
}

console.log('chat drop & paste tests: ok')

import { readFile, readdir } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const versions = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'))
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
// 0.7.55：改为全量扫描 src/*.ts。旧实现只列 8 个文件（共 44 个），未扫的恰好是改动
// 最密集的那批——一个只看 18% 代码的上架体检比没有体检更危险（本仓库已有一次
// 因 docx 内联 polyfill 被判 CODE OBFUSCATION 的下架前科）。
function assert(condition, message) {
  if (!condition) throw new Error(message)
}


const srcDir = new URL('../src/', import.meta.url)
const sourceFiles = (await readdir(srcDir)).filter((name) => name.endsWith('.ts')).sort()
assert(sourceFiles.length >= 40, `src 下应有全部 TS 源文件，实际只找到 ${sourceFiles.length} 个`)
const sourceEntries = await Promise.all(
  sourceFiles.map(async (name) => ({ name, text: await readFile(new URL(name, srcDir), 'utf8') })),
)
const sources = sourceEntries.map((entry) => entry.text).join('\n')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')


assert(manifest.id === 'ai-linzi', '插件 ID 必须保持 ai-linzi')
assert(manifest.name === 'AI Linzi', '官方市场展示名必须使用 Basic Latin 字符')
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), '版本号必须是 x.y.z')
assert(/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), 'minAppVersion 必须是 x.y.z')
assert(manifest.version === pkg.version, 'manifest.json 与 package.json 版本必须一致')
assert(versions[manifest.version] === manifest.minAppVersion, 'versions.json 必须登记当前版本')
assert(
  manifest.isDesktopOnly === true,
  '插件使用电脑文件选择与本机文档解析能力，isDesktopOnly 必须保持 true',
)
assert(
  manifest.description.length <= 250 && manifest.description.endsWith('.'),
  '插件描述需不超过 250 字符并以句号结尾',
)
assert(!/\bObsidian\b/i.test(manifest.description), '插件描述不得包含 Obsidian')
assert(
  !manifest.description.toLocaleLowerCase().startsWith(manifest.name.toLocaleLowerCase()),
  '插件描述不得以插件名称开头',
)
assert(manifest.authorUrl === 'https://alinalinzi.cn', '作者网址必须使用可访问的正式地址')
assert(readme.startsWith('# AI Linzi\n'), 'README 标题必须与 manifest.name 完全一致')
assert(
  readme.includes('## Features') && readme.includes('## Privacy and network access'),
  'README 必须包含英文功能与隐私说明',
)
assert(pkg.license === 'MIT', 'package.json 必须声明 MIT 许可证')
assert(license.startsWith('MIT License\n'), 'LICENSE 必须使用可识别的 MIT 文本')
assert(!sources.includes("from './updater'"), '官方市场版不得包含插件自更新器')
assert(
  !/\b(?:brew|winget|npm|npx)\b[\s\S]{0,120}\b(?:install|update|upgrade)\b/u.test(
    sourceEntries
      .filter((entry) => entry.name !== 'article-video-core.ts' && entry.name !== 'main.ts')
      .map((entry) => entry.text)
      .join('\n'),
  ),
  '官方市场版不得从插件代码执行包管理器安装或更新依赖',
)
assert(!sources.includes("['--yes', `hyperframes@"), '官方市场版不得通过 npx 自动下载 HyperFrames')
assert(
  readme.includes('never installs, downloads, or updates these dependencies'),
  'README 必须公开说明 Article to Video 不会由插件安装或更新本机依赖',
)
assert(!sources.includes('.vault.adapter.'), '插件状态和 Vault 文件操作不得直接使用 Adapter API')
assert(!sources.includes('window.confirm('), '确认操作必须使用 Obsidian Modal')

/**
 * 0.7.55：两条 DOM 规则改为逐文件精确判定（全量扫描后必须能区分真违规与正常做法，
 * 否则要么误报、要么只好缩小扫描面——后者正是旧实现只看 8/44 个文件的由来）。
 *
 * - 静态内联样式：只禁引号字面量赋值；动态计算值（进度条宽度、饼图角度、柱状图高度）
 *   本来就只能用 JS 设置，官方规则也允许。生成 HTML 成品的模块里出现的 `.style.x=""`
 *   属于输出内容而非插件自身 DOM，按内容豁免。
 * - document.createElement：界面 DOM 必须用 Obsidian 的 createEl helper；但离屏导出
 *   （html-to-image 出 PNG、canvas 画卡片/PDF 页）没有 helper 可用，按用途豁免，
 *   并把豁免明细打印出来——豁免必须看得见，不能静默放过。
 */
// deck-builder-core 只拼接课件 HTML 字符串（含成品内的 <script>），不碰插件自身 DOM。
const artifactOutputModules = new Set(['artifact-renderer.ts', 'deck-builder-core.ts'])
const styleOffenders = sourceEntries
  .filter((entry) => !artifactOutputModules.has(entry.name))
  .filter((entry) => /\.style\.[A-Za-z]+\s*=\s*(['"])[^'"]*\1/.test(entry.text))
  .map((entry) => entry.name)
assert(
  styleOffenders.length === 0,
  `静态界面样式必须通过 CSS class 设置（违规文件：${styleOffenders.join(', ')}）`,
)

const createElementExemptions = []
const createElementOffenders = []
for (const entry of sourceEntries) {
  const hits = entry.text.match(/document\.createElement\((['"])([a-z]+)\1\)/g) ?? []
  if (hits.length === 0) continue
  const onlyCanvas = hits.every((hit) => /'canvas'|"canvas"/.test(hit))
  const offscreenExport = entry.text.includes("from 'html-to-image'")
  if (onlyCanvas || offscreenExport) {
    createElementExemptions.push(
      `${entry.name}(${hits.length} 处 · ${onlyCanvas ? 'canvas 绘图' : '离屏导出 PNG'})`,
    )
    continue
  }
  createElementOffenders.push(`${entry.name}(${hits.length} 处)`)
}
assert(
  createElementOffenders.length === 0,
  `界面 DOM 元素必须使用 Obsidian createEl helper（违规文件：${createElementOffenders.join(', ')}）`,
)
console.log(
  `  已扫描 ${sourceFiles.length} 个源文件；createElement 豁免：${
    createElementExemptions.length > 0 ? createElementExemptions.join('、') : '无'
  }`,
)
assert(!styles.includes('!important'), 'CSS 不得使用 !important')
assert(!styles.includes(':has('), 'CSS 不得使用高开销的 :has 选择器')

/*
 * 构建产物扫描（0.7.71 新增）——补上 2026-08 下架事故真正的漏洞。
 *
 * 2026-08-16 官方目录对 0.7.33 判 Failed，唯一 Error 是 CODE OBFUSCATION：
 * `Found 4 dynamic <script> element creations`。那 4 处字符在 src/ 里一个都没有，
 * 它们来自 docx@9.7.1 dist 内联的 IE 时代 polyfill，打包后才进入 main.js。
 *
 * 上面的 createElement 检查只遍历 src/*.ts（0.7.55 从 8 个文件扩到全量，
 * 扩的是「源码覆盖面」而不是「扫描对象」），因此对同类问题始终是绿的。
 * 这里直接按官方扫描器的口径数发布产物里的字面量。
 */
const bundleUrl = new URL('../main.js', import.meta.url)
let bundle = null
try {
  bundle = await readFile(bundleUrl, 'utf8')
} catch {
  bundle = null
}
if (bundle === null) {
  console.log('  ⚠️ 未找到 main.js，跳过构建产物扫描（发布前必须先 npm run build 再跑本检查）')
} else {
  const dynamicScriptHits =
    bundle.match(/createElement\(\s*(['"`])script\1\s*\)/g) ?? []
  assert(
    dynamicScriptHits.length === 0,
    `构建产物 main.js 含 ${dynamicScriptHits.length} 处动态 <script> 创建，` +
      '官方审核会判 CODE OBFUSCATION。检查最近新增的第三方依赖 dist 是否内联了 polyfill，' +
      '按 esbuild.config.mjs 里 stripDynamicScriptPolyfills 的做法处理。',
  )
  console.log(`  已扫描构建产物 main.js（${Math.round(bundle.length / 1024)} KB）：动态 <script> 字面量 0 处`)

  /*
   * 动态代码生成必须为零（0.7.74 收紧）。
   *
   * 旧门禁允许 4 处第三方基线：PDF.js 的运行时 PostScript 编译与 CSP 探测，
   * 以及 docx 内联 setImmediate 的字符串回调。它们与曾导致插件下架的动态
   * <script> 同属 CODE OBFUSCATION 风险面，不能赌官方扫描规则永远不扩展。
   * esbuild.config.mjs 现在让 PDF.js 稳定走解释器，并拒绝 setImmediate 字符串
   * 回调；因此发布包里的 eval/new Function 也必须锁死为 0。
   */
  const evalHits = bundle.match(/\beval\(|new Function\(/g) ?? []
  assert(
    evalHits.length === 0,
    `构建产物仍有 ${evalHits.length} 处 eval/new Function，与官方 CODE OBFUSCATION 审核同一风险面。`,
  )
  const srcEval = sourceEntries.filter((entry) => /\beval\(|new Function\(/.test(entry.text))
  assert(
    srcEval.length === 0,
    `本仓库源码不得使用 eval / new Function（违规文件：${srcEval.map((e) => e.name).join(', ')}）`,
  )
  console.log(
    `  动态代码生成：产物 ${evalHits.length} 处，本仓库源码 0 处`,
  )
}

console.log('Obsidian 官方市场兼容检查通过')

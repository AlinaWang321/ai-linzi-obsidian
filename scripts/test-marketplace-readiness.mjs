import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const versions = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'))
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
const sourcePaths = [
  '../src/main.ts',
  '../src/actions.ts',
  '../src/cockpit-view.ts',
  '../src/content-selector.ts',
  '../src/local-document-text.ts',
  '../src/publish.ts',
  '../src/skill-suggest.ts',
  '../src/vault-image-browser.ts',
]
const sources = (
  await Promise.all(sourcePaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
).join('\n')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(manifest.id === 'ai-linzi', '插件 ID 必须保持 ai-linzi')
assert(manifest.name === 'AI Linzi', '官方市场展示名必须使用 Basic Latin 字符')
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), '版本号必须是 x.y.z')
assert(manifest.version === pkg.version, 'manifest.json 与 package.json 版本必须一致')
assert(versions[manifest.version] === manifest.minAppVersion, 'versions.json 必须登记当前版本')
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
assert(!sources.includes('.vault.adapter.'), '插件状态和 Vault 文件操作不得直接使用 Adapter API')
assert(
  !/\.style\.[A-Za-z]+\s*=\s*(['"])[^'"]*\1/.test(sources),
  '静态界面样式必须通过 CSS class 设置',
)
assert(!sources.includes('window.confirm('), '确认操作必须使用 Obsidian Modal')
assert(!sources.includes('document.createElement('), 'DOM 元素必须使用 Obsidian createEl helper')
assert(!styles.includes('!important'), 'CSS 不得使用 !important')
assert(!styles.includes(':has('), 'CSS 不得使用高开销的 :has 选择器')

console.log('Obsidian 官方市场兼容检查通过')

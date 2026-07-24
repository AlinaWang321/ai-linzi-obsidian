import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const pluginDir = join(dist, 'ai-linzi')
const archive = join(dist, 'ai-linzi-obsidian.zip')
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))

await rm(dist, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

for (const name of ['manifest.json', 'main.js', 'styles.css']) {
  await copyFile(join(root, name), join(pluginDir, name))
}
// 安装包内使用 ASCII 文件名，避免 Windows 的解压工具把中文文件名显示为乱码。
// 文件内容仍是完整的中文安装说明。
await copyFile(join(root, 'docs/安装说明.md'), join(pluginDir, 'INSTALL.md'))
await mkdir(join(pluginDir, 'img'), { recursive: true })
for (const imageName of ['install-location.png', 'connection-key-location.png']) {
  await copyFile(join(root, 'docs/img', imageName), join(pluginDir, 'img', imageName))
}

execFileSync('zip', ['-q', '-r', archive, 'ai-linzi'], { cwd: dist })
console.log(`AI霖子 Obsidian 插件 v${manifest.version} 安装包：${archive}`)

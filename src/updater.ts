/**
 * 插件自动更新 · v0.2
 *
 * 解决「插件发给学员后更新难」:启动后静默检查 GitHub Releases 最新版,
 * 有新版在设置页一键更新(下载 manifest/main.js/styles.css 覆盖后自动重载)。
 * 官方插件市场上架(营后)之前,这是学员的唯一升级通道。
 */
import { Notice, requestUrl } from 'obsidian'
import type AiLinziPlugin from './main'

const REPO = 'AlinaWang321/ai-linzi-obsidian'
const ASSETS = ['manifest.json', 'main.js', 'styles.css'] as const

function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export interface UpdateInfo {
  version: string
  assets: Record<string, string>
}

/** 查最新 release;没有更新返回 null(网络失败也返回 null,不打扰用户) */
export async function checkLatest(plugin: AiLinziPlugin): Promise<UpdateInfo | null> {
  const res = await requestUrl({
    url: `https://api.github.com/repos/${REPO}/releases/latest`,
    headers: { Accept: 'application/vnd.github+json' },
    throw: false,
  })
  if (res.status !== 200) return null
  const rel = res.json as {
    tag_name?: string
    assets?: { name: string; browser_download_url: string }[]
  }
  const version = (rel.tag_name ?? '').replace(/^v/, '')
  if (!version || cmpVer(version, plugin.manifest.version) <= 0) return null
  const assets: Record<string, string> = {}
  for (const a of rel.assets ?? []) {
    if ((ASSETS as readonly string[]).includes(a.name)) assets[a.name] = a.browser_download_url
  }
  // main.js/manifest 缺一不可(styles 可选),防半套资源的坏 release
  if (!assets['main.js'] || !assets['manifest.json']) return null
  return { version, assets }
}

/** 下载覆盖插件文件并重载(先全部下载成功再落盘,避免写一半) */
export async function applyUpdate(plugin: AiLinziPlugin, info: UpdateInfo): Promise<void> {
  const dir = plugin.manifest.dir
  if (!dir) throw new Error('无法定位插件目录')

  const downloaded: { name: string; text: string }[] = []
  for (const name of ASSETS) {
    const url = info.assets[name]
    if (!url) continue
    const res = await requestUrl({ url, throw: false })
    if (res.status !== 200 || !res.text) throw new Error(`下载 ${name} 失败(HTTP ${res.status})`)
    downloaded.push({ name, text: res.text })
  }
  for (const f of downloaded) {
    await plugin.app.vault.adapter.write(`${dir}/${f.name}`, f.text)
  }

  new Notice(`✅ AI霖子插件已更新到 v${info.version},正在重载…`, 6000)
  // 2026-07-21 修:①重载前刷新清单缓存(否则版本号仍显示旧值)
  // ②旧设置页随旧实例销毁会白屏 → 重载后自动重开本插件设置页
  const id = plugin.manifest.id
  const appAny = plugin.app as unknown as {
    plugins: {
      disablePlugin(id: string): Promise<void>
      enablePlugin(id: string): Promise<void>
      loadManifests?: () => Promise<void>
    }
    setting?: { openTabById?: (id: string) => void }
  }
  await appAny.plugins.disablePlugin(id)
  await appAny.plugins.loadManifests?.()
  await appAny.plugins.enablePlugin(id)
  try {
    appAny.setting?.openTabById?.(id)
  } catch {
    /* 设置窗未开着就算了 */
  }
}

/** 启动静默检查(约每 20 小时一次);发现新版只提示,不自动装 */
export async function autoCheck(plugin: AiLinziPlugin): Promise<void> {
  const now = Date.now()
  if (now - (plugin.settings.lastUpdateCheckAt ?? 0) < 20 * 60 * 60 * 1000) return
  plugin.settings.lastUpdateCheckAt = now
  await plugin.saveSettings()
  try {
    const info = await checkLatest(plugin)
    if (info) {
      plugin.pendingUpdate = info
      new Notice(`🔔 AI霖子插件有新版本 v${info.version}——打开 设置→AI霖子 一键更新`, 10000)
    }
  } catch {
    /* 静默:检查失败下次再说 */
  }
}

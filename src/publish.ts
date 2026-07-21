/**
 * 公众号发布 · v0.3
 *
 * ① 一键排版复制:笔记 md → 内联样式富文本(公众号编辑器可直接粘贴)。
 *    版式参考 alinalinzi.cn 文章风格(藏蓝层级+暖底引用块),颜色集中在 THEME 便于调整;
 *    刻意不用 Alina 个人标志性黄色高亮(学员通用版)。
 * ② 直发草稿箱:用学员自己的 AppID/AppSecret 从本机直连微信接口
 *    (凭证只存本地;需在公众号后台把本机 IP 加入白名单)。
 *    图片自动走微信素材接口上传替换;第一张图作封面(草稿必须有封面)。
 */
import { Notice, TFile, requestUrl } from 'obsidian'
import { marked } from 'marked'
import type AiLinziPlugin from './main'

// ── 版式主题(参数化,Alina 定稿时改这里) ──────────────
const THEME = {
  ink: '#1A1612',
  inkSoft: '#4A4036',
  inkMute: '#8A7E74',
  navy: '#293857',
  line: '#E7DFD2',
  bgSoft: '#F7F3EC',
  fontSize: '16px',
  lineHeight: '1.8',
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

// ── md → 公众号 HTML ────────────────────────────────

interface ImgRef {
  placeholder: string
  alt: string
  src: string
}

/** wiki 嵌入转标准 md 图片,并把所有图片抽成占位符(后续按场景解析) */
function extractImages(md: string): { md: string; imgs: ImgRef[] } {
  const imgs: ImgRef[] = []
  let out = md.replace(/!\[\[([^\]]+?)\]\]/g, (_m, p: string) => `![](${p.split('|')[0].trim()})`)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    const ph = `%%AILINZI_IMG_${imgs.length}%%`
    imgs.push({ placeholder: ph, alt: alt.trim(), src: src.trim() })
    return `\n\n${ph}\n\n`
  })
  return { md: out, imgs }
}

/** 标签替换式加内联样式(不依赖 marked renderer API,版本稳) */
function styleHtml(html: string): string {
  const T = THEME
  const navySoft = '#5C7BB0'
  const dot = `<span style="display:inline-block;width:6px;height:6px;background:#C9D4E8;border-radius:50%;margin:0 5px;"></span>`
  return (
    html
      .replaceAll('<p>', `<p style="margin:0 0 1.25em;font-size:${T.fontSize};line-height:${T.lineHeight};color:${T.ink};letter-spacing:.4px;">`)
      // H1/H2 = 藏蓝标签块 + 浅蓝装饰短线(纯内联样式,公众号编辑器稳定支持)
      .replaceAll('<h1>', `<section style="margin:2.1em 0 1.2em;"><section style="display:inline-block;padding:7px 16px;background:${T.navy};color:#ffffff;font-size:17px;font-weight:700;border-radius:8px;letter-spacing:1px;line-height:1.4;">`)
      .replaceAll('</h1>', `</section><section style="width:42px;height:3px;background:${'$'}{navySoft};border-radius:2px;margin-top:8px;"></section></section>`.replace('${navySoft}', navySoft))
      .replaceAll('<h2>', `<section style="margin:2.1em 0 1.2em;"><section style="display:inline-block;padding:7px 16px;background:${T.navy};color:#ffffff;font-size:17px;font-weight:700;border-radius:8px;letter-spacing:1px;line-height:1.4;">`)
      .replaceAll('</h2>', `</section><section style="width:42px;height:3px;background:${'$'}{navySoft};border-radius:2px;margin-top:8px;"></section></section>`.replace('${navySoft}', navySoft))
      // H3 = 圆点 + 藏蓝粗体
      .replaceAll('<h3>', `<h3 style="margin:1.7em 0 .8em;font-size:16px;font-weight:700;color:${T.navy};"><span style="display:inline-block;width:8px;height:8px;background:${'$'}{navySoft};border-radius:50%;margin-right:8px;"></span>`.replace('${navySoft}', navySoft))
      // 引用块 = 暖底卡片 + 引号缀饰
      .replaceAll('<blockquote>', `<blockquote style="margin:1.5em 0;padding:14px 18px;background:${T.bgSoft};border-left:3px solid ${'$'}{navySoft};border-radius:6px;color:${T.inkSoft};font-size:15px;line-height:1.8;"><span style="display:block;font-size:20px;color:${'$'}{navySoft};line-height:1;margin-bottom:4px;">❝</span>`.replaceAll('${navySoft}', navySoft))
      .replaceAll('<ul>', `<ul style="margin:0 0 1.25em;padding-left:1.4em;color:${T.ink};font-size:${T.fontSize};line-height:${T.lineHeight};">`)
      .replaceAll('<ol>', `<ol style="margin:0 0 1.25em;padding-left:1.4em;color:${T.ink};font-size:${T.fontSize};line-height:${T.lineHeight};">`)
      .replaceAll('<li>', `<li style="margin:.35em 0;">`)
      .replaceAll('<strong>', `<strong style="color:${T.navy};">`)
      // 分隔线 = 居中三圆点
      .replaceAll('<hr>', `<section style="margin:2.2em 0;text-align:center;">${dot}${dot}${dot}</section>`)
      .replaceAll('<code>', `<code style="background:${T.bgSoft};padding:2px 6px;border-radius:4px;font-size:14px;color:${T.navy};">`)
      .replace(/<a href="([^"]*)">/g, `<a href="$1" style="color:${T.navy};border-bottom:1px solid ${T.line};text-decoration:none;">`)
  )
}

function wrapSection(inner: string): string {
  return `<section style="font-family:${FONT};max-width:100%;word-break:break-word;">${inner}</section>`
}

/** 文末品牌小卡(设置可关):读者问「怎么排的」,答案在文末 */
function brandFooterHtml(): string {
  return (
    `<section style="margin:2.8em 0 0;text-align:center;">` +
    `<section style="display:inline-block;padding:6px 16px;border:1px solid ${THEME.line};border-radius:999px;font-size:12px;color:${THEME.inkMute};letter-spacing:1px;">✨ 排版与配图 · AI霖子</section>` +
    `</section>`
  )
}

/** 通用转换:imgResolver 决定每张图输出什么(复制场景=占位提示;草稿场景=微信图床 img) */
function mdToWechatHtml(mdRaw: string, imgHtml: (img: ImgRef) => string, withFooter = false): string {
  const { md, imgs } = extractImages(mdRaw)
  let html = marked.parse(md, { async: false }) as string
  html = styleHtml(html)
  for (const img of imgs) {
    // 占位符被包进了 <p> 里,连壳一起换
    const wrapped = new RegExp(`<p[^>]*>\\s*${img.placeholder}\\s*</p>|${img.placeholder}`)
    html = html.replace(wrapped, imgHtml(img))
  }
  return wrapSection(html + (withFooter ? brandFooterHtml() : ''))
}

function stripFm(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
}

async function currentNote(plugin: AiLinziPlugin): Promise<{ file: TFile; body: string } | null> {
  const file = plugin.app.workspace.getActiveFile() ?? plugin.lastActiveFile
  if (!file) {
    new Notice('请先打开要发布的文章笔记')
    return null
  }
  const body = stripFm(await plugin.app.vault.cachedRead(file))
  if (body.length < 50) {
    new Notice('当前笔记内容太短,不像一篇可发布的文章')
    return null
  }
  return { file, body }
}

// ── ① 一键排版复制 ──────────────────────────────────

export async function copyWechatFormatted(plugin: AiLinziPlugin) {
  const note = await currentNote(plugin)
  if (!note) return
  let localImgCount = 0
  const html = mdToWechatHtml(note.body, (img) => {
    if (/^https?:\/\//.test(img.src)) {
      return `<img src="${img.src}" alt="${img.alt}" style="max-width:100%;border-radius:6px;margin:1.2em 0;">`
    }
    localImgCount++
    return `<p style="margin:1.2em 0;padding:10px;background:${THEME.bgSoft};border-radius:6px;color:${THEME.inkMute};font-size:13px;text-align:center;">📷 此处有本地图片「${img.alt || img.src}」——粘贴后请在公众号编辑器手动插入</p>`
  }, plugin.settings.brandFooter)
  const plain = note.body
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    }),
  ])
  new Notice(
    `✅ 排版已复制!去公众号后台正文区 ⌘V 粘贴${localImgCount ? `\n(有 ${localImgCount} 张本地图片需粘贴后手动插入,或改用「发到草稿箱」自动传图)` : ''}`,
    8000,
  )
}

// ── ② 直发草稿箱 ────────────────────────────────────

const tokenCache = new Map<string, { token: string; exp: number }>()

async function getAccessToken(appId: string, secret: string): Promise<string> {
  const cached = tokenCache.get(appId)
  if (cached && cached.exp > Date.now()) return cached.token
  const res = await requestUrl({
    url: `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`,
    throw: false,
  })
  const d = res.json as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
  if (!d.access_token) throw new Error(friendlyWxError(d.errcode, d.errmsg))
  tokenCache.set(appId, { token: d.access_token, exp: Date.now() + ((d.expires_in ?? 7200) - 300) * 1000 })
  return d.access_token
}

function friendlyWxError(code?: number, msg?: string): string {
  if (code === 40164) {
    const ip = /invalid ip ([\d.]+)/.exec(msg ?? '')?.[1]
    return `你的电脑 IP${ip ? ` (${ip})` : ''} 不在公众号白名单里。去 公众号后台 → 设置与开发 → 基本配置 → IP 白名单,把这个 IP 加进去(家里网络 IP 会变,变了就再加一次)`
  }
  if (code === 40125 || code === 40001) return 'AppSecret 不对或已重置,去公众号后台「基本配置」重新生成后填入插件设置'
  if (code === 40013) return 'AppID 不对,检查插件设置里是否抄错'
  return `微信接口返回错误:${msg ?? code ?? '未知'}`
}

function buildMultipart(filename: string, data: ArrayBuffer, mime: string): { body: ArrayBuffer; contentType: string } {
  const boundary = '----ailinzi' + Math.random().toString(36).slice(2)
  const enc = new TextEncoder()
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${boundary}--\r\n`)
  const d = new Uint8Array(data)
  const out = new Uint8Array(head.length + d.length + tail.length)
  out.set(head, 0)
  out.set(d, head.length)
  out.set(tail, head.length + d.length)
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` }
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/png' }[ext] ?? 'image/png'
}

/** 正文图:uploadimg(不占素材库额度,返回 URL) */
async function uploadContentImage(token: string, file: TFile, plugin: AiLinziPlugin): Promise<string> {
  const data = await plugin.app.vault.readBinary(file)
  const { body, contentType } = buildMultipart(file.name, data, mimeOf(file.name))
  const res = await requestUrl({
    url: `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`,
    method: 'POST',
    body,
    contentType,
    throw: false,
  })
  const d = res.json as { url?: string; errcode?: number; errmsg?: string }
  if (!d.url) throw new Error(`图片「${file.name}」上传失败:${friendlyWxError(d.errcode, d.errmsg)}`)
  return d.url
}

/** 封面图:永久素材(草稿必须 thumb_media_id) */
async function uploadThumb(token: string, file: TFile, plugin: AiLinziPlugin): Promise<string> {
  const data = await plugin.app.vault.readBinary(file)
  const { body, contentType } = buildMultipart(file.name, data, mimeOf(file.name))
  const res = await requestUrl({
    url: `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
    method: 'POST',
    body,
    contentType,
    throw: false,
  })
  const d = res.json as { media_id?: string; errcode?: number; errmsg?: string }
  if (!d.media_id) throw new Error(`封面上传失败:${friendlyWxError(d.errcode, d.errmsg)}`)
  return d.media_id
}

function resolveImgFile(plugin: AiLinziPlugin, src: string, from: TFile): TFile | null {
  const f = plugin.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(src), from.path)
  return f instanceof TFile ? f : null
}

export async function sendToWechatDraft(plugin: AiLinziPlugin) {
  const { wechatAppId, wechatAppSecret } = plugin.settings
  if (!wechatAppId || !wechatAppSecret) {
    new Notice('先在 设置 → AI霖子 → 公众号发布 里填入你的 AppID 和 AppSecret(公众号后台「基本配置」里抄)', 8000)
    return
  }
  const note = await currentNote(plugin)
  if (!note) return

  const n = new Notice('📮 正在发送到公众号草稿箱…', 0)
  try {
    const token = await getAccessToken(wechatAppId, wechatAppSecret)

    // 收集本地图片并上传
    const { imgs } = extractImages(note.body)
    const urlMap = new Map<string, string>()
    let coverFile: TFile | null = null
    for (const img of imgs) {
      if (/^https?:\/\//.test(img.src)) continue
      const f = resolveImgFile(plugin, img.src, note.file)
      if (!f) continue
      if (!coverFile) coverFile = f
      if (!urlMap.has(img.src)) urlMap.set(img.src, await uploadContentImage(token, f, plugin))
    }
    if (!coverFile) {
      n.hide()
      new Notice('公众号草稿必须有一张封面图——请在文章里至少插入一张本地图片(第一张会自动作为封面)', 9000)
      return
    }
    const thumbMediaId = await uploadThumb(token, coverFile, plugin)

    const html = mdToWechatHtml(note.body, (img) => {
      const url = /^https?:\/\//.test(img.src) ? img.src : urlMap.get(img.src)
      return url
        ? `<img src="${url}" alt="${img.alt}" style="max-width:100%;border-radius:6px;margin:1.2em 0;">`
        : ''
    }, plugin.settings.brandFooter)

    // 标题:frontmatter title > 去日期前缀的文件名
    const fmTitle = plugin.app.metadataCache.getFileCache(note.file)?.frontmatter?.title as string | undefined
    const title = (fmTitle ?? note.file.basename.replace(/^\d{4}\.\d{2}\.\d{2}_/, '')).slice(0, 60)
    const digest = note.body.replace(/[#*>\-\n]/g, '').slice(0, 100)

    const res = await requestUrl({
      url: `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
      method: 'POST',
      // 微信接口对中文要原样 UTF-8,JSON.stringify 默认不转义中文 ✓
      body: JSON.stringify({ articles: [{ title, content: html, thumb_media_id: thumbMediaId, digest }] }),
      contentType: 'application/json',
      throw: false,
    })
    const d = res.json as { media_id?: string; errcode?: number; errmsg?: string }
    if (!d.media_id) throw new Error(friendlyWxError(d.errcode, d.errmsg))

    // 回写状态到源笔记 frontmatter
    await plugin.app.fileManager.processFrontMatter(note.file, (fm) => {
      fm['状态'] = '已进草稿箱'
      fm['草稿箱时间'] = new Date().toISOString().slice(0, 10)
    })
    n.hide()
    new Notice(`✅ 已进入公众号草稿箱!\n去 公众号后台 → 草稿箱 预览和群发\n(标题:${title})`, 10000)
  } catch (e) {
    n.hide()
    new Notice(`❌ 发草稿箱失败:${e instanceof Error ? e.message : String(e)}`, 12000)
  }
}

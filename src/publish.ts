/**
 * 公众号发布 · v0.3
 *
 * ① 一键排版复制:笔记 md → 内联样式富文本(公众号编辑器可直接粘贴)。
 *    版式以 Alina 发布工作台为基准(亮蓝标题+黄色结构强调+暖底引用块),
 *    但不包含 Alina 的个人眉题与页尾 slogan,保持学员通用。
 * ② 直发草稿箱:用学员自己的 AppID/AppSecret 从本机直连微信接口。
 *    AppSecret 只从 Obsidian SecretStorage 读取，不写入插件 data.json；
 *    仍需在公众号后台把本机 IP 加入白名单。
 *    图片自动走微信素材接口上传替换;第一张图作封面(草稿必须有封面)。
 */
import { Notice, TFile, requestUrl } from 'obsidian'
import { marked } from 'marked'
import type AiLinziPlugin from './main'
import { prepareWechatArticle, stripFrontmatter } from './article-format'

// ── 版式主题(移植自 Alina 发布工作台排版 2026-07-21;两处调整:Part胶囊14px/大标题#0057FF) ──
const THEME = {
  ink: '#2b2b2b',
  inkMute: '#7d7d7d',
  navy: '#1f3f7c',
  blueBright: '#0057FF',
  linkBlue: '#1f63c5',
  yellow: '#f5c518',
  yellowSoft: '#fce38a',
  quoteBg: '#fff9dc',
  quoteInk: '#4f4a3f',
  imgBorder: '#e3e8f0',
  line: '#e8ebf1',
  bgSoft: '#f4f6f9',
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

// ── md → 公众号 HTML ────────────────────────────────

interface ImgRef {
  placeholder: string
  alt: string
  src: string
}

const DIGEST_FRONTMATTER_KEYS = ['一句话摘要', '摘要', 'digest', 'summary', 'description'] as const

/** wiki 嵌入转标准 md 图片,并把所有图片抽成占位符(后续按场景解析) */
export function extractImages(md: string): { md: string; imgs: ImgRef[] } {
  const imgs: ImgRef[] = []
  let out = md.replace(/!\[\[([^\]]+?)\]\]/g, (_m, p: string) => `![](${p.split('|')[0].trim()})`)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    const ph = `%%AILINZI_IMG_${imgs.length}%%`
    imgs.push({ placeholder: ph, alt: alt.trim(), src: src.trim() })
    return `\n\n${ph}\n\n`
  })
  return { md: out, imgs }
}

function partPill(label: string): string {
  return `<p style="display:inline-block;margin:34px 0 10px;padding:6px 14px;border-radius:999px;background:${THEME.yellowSoft};color:${THEME.navy};font-size:14px;line-height:1.4;font-weight:700;letter-spacing:2px;">${label}</p>`
}

/**
 * 给 marked 产出的 HTML 写入公众号可保留的内联样式。
 * 这里先识别 Part、图注、引用块等结构,再处理普通标签,避免把图注误排成 Part 标签。
 */
export function styleHtml(html: string): string {
  const T = THEME
  let out = html

  // 文章来自 AI 或用户笔记；预览/粘贴前移除可执行标签与事件属性。
  out = out
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/href\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, 'href="#"')

  // 公众号标题有独立输入框;正文不重复显示 Markdown 的首个 H1。
  out = out.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/i, '')

  // 只有独行强调语法(*Part 1* / **PART 01**)做黄色胶囊。
  // 标题语法(## PART 01)必须继续走下方 H2 大标题规则,不能在这里吞掉。
  out = out.replace(
    /<p>\s*<(em|strong)>\s*(PART\s*(?:\d+|[一二三四五六七八九十]+))\s*<\/\1>\s*<\/p>/gi,
    (_all, _emphasis, label: string) => partPill(label.toUpperCase()),
  )
  // 独立斜体行是图片说明/注释,沿用原版的居中灰字,不再误做黄色胶囊。
  out = out.replace(
    /<p>\s*<em>([\s\S]*?)<\/em>\s*<\/p>/g,
    `<p style="margin:0 12px 26px;color:${T.inkMute};font-size:13px;line-height:1.7;text-align:center;">$1</p>`,
  )

  // marked 会在 blockquote 内再包 p;先处理内层,避免继承普通正文的 18px 下边距。
  out = out.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (_all, inner: string) => {
    const quoteBody = inner
      .replaceAll('<p>', `<p style="margin:0 0 8px;color:${T.quoteInk};font-size:16px;line-height:1.85;text-align:left;">`)
      .replaceAll('<ul>', `<ul style="margin:0;padding-left:1.35em;color:${T.quoteInk};font-size:16px;line-height:1.85;">`)
      .replaceAll('<ol>', `<ol style="margin:0;padding-left:1.35em;color:${T.quoteInk};font-size:16px;line-height:1.85;">`)
    return `<blockquote style="margin:22px 0;padding:14px 18px;border-left:4px solid ${T.yellow};background:${T.quoteBg};color:${T.quoteInk};font-size:16px;line-height:1.85;">${quoteBody}</blockquote>`
  })

  // 代码块必须先于行内 code 处理,否则会出现双层小胶囊。
  out = out.replace(
    /<pre><code(?: class="[^"]*")?>([\s\S]*?)<\/code><\/pre>/g,
    `<pre style="margin:22px 0;padding:14px 16px;overflow-x:auto;border:1px solid ${T.line};border-radius:6px;background:${T.bgSoft};color:${T.ink};font-size:13px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><code style="padding:0;background:transparent;color:inherit;font-size:inherit;">$1</code></pre>`,
  )

  return out
    .replaceAll('<p>', `<p style="margin:0 0 18px;color:${T.ink};font-size:16px;line-height:1.95;text-align:justify;letter-spacing:0;">`)
    // 大标题:原版黄色左边条;按 Alina 确认改为亮蓝 #0057FF。
    .replaceAll('<h1>', `<h2 style="margin:4px 0 22px;padding-left:13px;border-left:4px solid ${T.yellow};color:${T.blueBright};font-size:23px;line-height:1.45;font-weight:800;letter-spacing:0;">`)
    .replaceAll('</h1>', '</h2>')
    .replaceAll('<h2>', `<h2 style="margin:4px 0 22px;padding-left:13px;border-left:4px solid ${T.yellow};color:${T.blueBright};font-size:23px;line-height:1.45;font-weight:800;letter-spacing:0;">`)
    .replaceAll('<h3>', `<h3 style="margin:28px 0 14px;color:${T.navy};font-size:18px;line-height:1.55;font-weight:700;letter-spacing:0;">`)
    .replaceAll('<h4>', `<h4 style="margin:24px 0 12px;color:${T.navy};font-size:16px;line-height:1.6;font-weight:700;letter-spacing:0;">`)
    .replaceAll('<ul>', `<ul style="margin:0 0 20px;padding-left:1.4em;color:${T.ink};font-size:16px;line-height:1.85;">`)
    .replaceAll('<ol>', `<ol style="margin:0 0 20px;padding-left:1.4em;color:${T.ink};font-size:16px;line-height:1.85;">`)
    .replaceAll('<li>', `<li style="margin:0 0 8px;">`)
    .replaceAll('<strong>', `<strong style="color:${T.navy};font-weight:700;">`)
    .replaceAll('<hr>', `<hr style="margin:32px auto;border:none;border-top:1px solid ${T.line};width:100%;">`)
    .replaceAll('<code>', `<code style="padding:2px 5px;border-radius:4px;background:#eef4ff;color:${T.navy};font-size:14px;">`)
    .replace(/<a href="([^"]*)"([^>]*)>/g, `<a href="$1"$2 style="color:${T.linkBlue};font-weight:700;text-decoration:underline;text-decoration-color:${T.yellow};text-underline-offset:3px;word-break:break-all;">`)
}

function wrapSection(inner: string): string {
  return `<section style="font-family:${FONT};max-width:100%;word-break:break-word;">${inner}</section>`
}

/** 文末品牌小卡(设置可关):读者问「怎么排的」,答案在文末 */
function brandFooterHtml(): string {
  return (
    `<section style="margin:40px 0 0;padding:17px 16px;border:1px solid ${THEME.line};border-radius:8px;background:#fbfcfe;text-align:center;">` +
    `<span style="display:inline-block;width:7px;height:7px;margin:0 8px 1px 0;border-radius:50%;background:${THEME.yellow};"></span>` +
    `<span style="color:${THEME.navy};font-size:13px;line-height:1.7;font-weight:700;letter-spacing:.5px;">AI霖子</span>` +
    `<span style="color:${THEME.inkMute};font-size:12px;line-height:1.7;letter-spacing:.5px;"> · 公众号排版与配图</span>` +
    `</section>`
  )
}

/** 通用转换:imgResolver 决定每张图输出什么(复制场景=占位提示;草稿场景=微信图床 img) */
export function mdToWechatHtml(mdRaw: string, imgHtml: (img: ImgRef) => string, withFooter = false): string {
  const prepared = prepareWechatArticle(mdRaw)
  const { md, imgs } = extractImages(prepared.body)
  let html = marked.parse(md, { async: false }) as string
  html = styleHtml(html)
  for (const img of imgs) {
    // 占位符被包进了 <p> 里,连壳一起换
    const wrapped = new RegExp(`<p[^>]*>\\s*${img.placeholder}\\s*</p>|${img.placeholder}`)
    html = html.replace(wrapped, imgHtml(img))
  }
  return wrapSection(html + (withFooter ? brandFooterHtml() : ''))
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function limitUnicode(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

function cleanDigestText(text: string): string {
  return text
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, path: string, alias?: string) => alias || path)
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.、)])\s*/, '')
    .replace(/[\\*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 公众号摘要优先级：frontmatter 明确摘要 → 写作技能的摘要段 → 第一段有效正文。
 * 历史文章即使以封面图片开头，也不会再把图片路径误当摘要。
 */
export function resolveWechatDigest(
  frontmatter: Record<string, unknown> | undefined,
  preparedDigest: string,
  body: string,
): string {
  for (const key of DIGEST_FRONTMATTER_KEYS) {
    const value = frontmatter?.[key]
    if (typeof value === 'string' && cleanDigestText(value)) {
      return limitUnicode(cleanDigestText(value), 120)
    }
  }

  const prepared = cleanDigestText(preparedDigest)
  if (prepared) return limitUnicode(prepared, 120)

  const paragraphs = body.replace(/\r\n/g, '\n').split(/\n{2,}|\n/)
  for (const paragraph of paragraphs) {
    const raw = paragraph.trim()
    if (
      !raw ||
      /^!\[\[/.test(raw) ||
      /^!\[[^\]]*\]\(/.test(raw) ||
      /^#{1,6}\s/.test(raw) ||
      /^\*{0,2}\s*PART\s*\d+/i.test(raw) ||
      /^(?:---|___|\*\*\*)$/.test(raw)
    ) continue
    const candidate = cleanDigestText(raw)
    if (candidate.length >= 8) return limitUnicode(candidate, 120)
  }
  return ''
}

/** 由文章配图生成器产出的独立封面只用于公众号封面，不进入正文。 */
export function isDedicatedWechatCover(img: Pick<ImgRef, 'src' | 'alt'>): boolean {
  return /(?:封面|cover)/i.test(`${img.src} ${img.alt}`)
}

/** 用独立 section 固定图片块边界，避免公众号编辑器把图片吸附进标题或相邻段落。 */
export function wechatImageHtml(url: string, alt = ''): string {
  return `<section style="display:block;margin:26px 0 10px;padding:0;text-align:center;"><img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" style="display:block;width:100%;max-width:100%;height:auto;margin:0 auto;border:1px solid ${THEME.imgBorder};border-radius:5px;"></section>`
}

async function currentNote(plugin: AiLinziPlugin): Promise<{ file: TFile; body: string; digest: string } | null> {
  const file = plugin.app.workspace.getActiveFile() ?? plugin.lastActiveFile
  if (!file) {
    new Notice('请先打开要发布的文章笔记')
    return null
  }
  const prepared = prepareWechatArticle(stripFrontmatter(await plugin.app.vault.cachedRead(file)))
  const body = prepared.body
  if (body.length < 50) {
    new Notice('当前笔记内容太短,不像一篇可发布的文章')
    return null
  }
  return { file, body, digest: prepared.digest }
}

// ── ① 一键排版复制 ──────────────────────────────────

export async function copyWechatFormatted(plugin: AiLinziPlugin) {
  const note = await currentNote(plugin)
  if (!note) return
  let localImgCount = 0
  const html = mdToWechatHtml(note.body, (img) => {
    if (isDedicatedWechatCover(img)) return ''
    if (/^https?:\/\//.test(img.src)) {
      return wechatImageHtml(img.src, img.alt)
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
  const { wechatAppId } = plugin.settings
  const wechatAppSecret = plugin.getWechatAppSecret()
  if (!wechatAppId || !wechatAppSecret) {
    new Notice('先在 设置 → AI霖子 → 公众号发布 里填入你的 AppID 和 AppSecret(公众号后台「基本配置」里抄)', 8000)
    return
  }
  const note = await currentNote(plugin)
  if (!note) return

  const n = new Notice('📮 正在发送到公众号草稿箱…', 0)
  try {
    const token = await getAccessToken(wechatAppId, wechatAppSecret)

    // 收集本地图片并上传。独立封面只上传为 thumb_media_id，不重复塞进正文。
    const { imgs } = extractImages(note.body)
    const urlMap = new Map<string, string>()
    const missingImages: string[] = []
    const localFiles = new Map<string, TFile>()
    for (const img of imgs) {
      if (/^https?:\/\//.test(img.src)) continue
      const f = resolveImgFile(plugin, img.src, note.file)
      if (!f) {
        missingImages.push(img.src)
        continue
      }
      localFiles.set(img.src, f)
    }
    if (missingImages.length > 0) {
      throw new Error(`有 ${missingImages.length} 张本地图片找不到，已停止发布：${missingImages.slice(0, 3).join('、')}`)
    }
    const dedicatedCover = imgs.find((img) => localFiles.has(img.src) && isDedicatedWechatCover(img)) ?? null
    const fallbackCover = imgs.find((img) => localFiles.has(img.src)) ?? null
    const coverRef = dedicatedCover ?? fallbackCover
    const coverFile = coverRef ? localFiles.get(coverRef.src) ?? null : null
    if (!coverFile) {
      n.hide()
      new Notice('公众号草稿必须有一张封面图——请在文章里至少插入一张本地图片(第一张会自动作为封面)', 9000)
      return
    }

    for (const img of imgs) {
      const f = localFiles.get(img.src)
      if (!f || (dedicatedCover && img.placeholder === dedicatedCover.placeholder)) continue
      if (!urlMap.has(img.src)) urlMap.set(img.src, await uploadContentImage(token, f, plugin))
    }
    const thumbMediaId = await uploadThumb(token, coverFile, plugin)

    const html = mdToWechatHtml(note.body, (img) => {
      if (dedicatedCover && img.placeholder === dedicatedCover.placeholder) return ''
      const url = /^https?:\/\//.test(img.src) ? img.src : urlMap.get(img.src)
      return url ? wechatImageHtml(url, img.alt) : ''
    }, plugin.settings.brandFooter)

    // 标题:frontmatter title > 去日期前缀的文件名
    const frontmatter = plugin.app.metadataCache.getFileCache(note.file)?.frontmatter as Record<string, unknown> | undefined
    const fmTitle = frontmatter?.title as string | undefined
    const title = (fmTitle ?? note.file.basename.replace(/^\d{4}\.\d{2}\.\d{2}_/, '')).slice(0, 60)
    // 极端历史稿若没有摘要且正文只有图片/标题，也至少用文章标题兜底，
    // 避免草稿箱出现完全空白摘要。
    const digest = resolveWechatDigest(frontmatter, note.digest, note.body) || title

    const res = await requestUrl({
      url: `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
      method: 'POST',
      // 微信接口对中文要原样 UTF-8,JSON.stringify 默认不转义中文 ✓
      body: JSON.stringify({
        articles: [{
          title,
          content: html,
          thumb_media_id: thumbMediaId,
          digest,
          auto_digest: 0,
          show_cover_pic: 0,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        }],
      }),
      contentType: 'application/json',
      throw: false,
    })
    const d = res.json as { media_id?: string; errcode?: number; errmsg?: string }
    if (!d.media_id) throw new Error(friendlyWxError(d.errcode, d.errmsg))

    // 回写状态到源笔记 frontmatter
    await plugin.app.fileManager.processFrontMatter(note.file, (fm) => {
      const now = new Date()
      const sentAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      fm['状态'] = '已发送公众号草稿箱'
      fm['内容类型'] = '公众号文章'
      fm['内容阶段'] = '已生成草稿'
      fm['公众号状态'] = '已发送公众号草稿箱'
      fm['公众号草稿ID'] = d.media_id
      fm['公众号草稿箱时间'] = sentAt
      fm['草稿箱时间'] = sentAt
      fm['视频状态'] = fm['视频状态'] || '未开始'
      fm['小红书状态'] = fm['小红书状态'] || '未开始'
    })
    n.hide()
    new Notice(`✅ 已进入公众号草稿箱!\n去 公众号后台 → 草稿箱 预览和群发\n(标题:${title})`, 10000)
  } catch (e) {
    n.hide()
    new Notice(`❌ 发草稿箱失败:${e instanceof Error ? e.message : String(e)}`, 12000)
  }
}

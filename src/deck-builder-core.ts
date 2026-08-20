/**
 * 课件PPT（deck-builder）纯逻辑：大纲 JSON 校验 + 固定模板装配（0.7.63）。
 *
 * 设计铁律（与私有后端约定）：模型只产出结构化大纲（每页字数有硬上限），
 * 版面 100% 由本文件的固定模板保证；本模块不碰 DOM、不认识 Obsidian，
 * 图片以 dataUrl 形式由 UI 层解析后传入，因此全部规则可被
 * scripts/test-deck-builder.mjs 真跑验证。
 */

export const DECK_SOURCE_MIN = 200
export const DECK_SOURCE_MAX = 60_000
export const DECK_BUILDER_OUTPUT_FOLDER = '课件PPT'

export const DECK_THEMES = ['深蓝', '青竹', '黛紫'] as const
export type DeckTheme = (typeof DECK_THEMES)[number]

interface ThemeTokens {
  bgd: string; bgm: string; bgh: string
  accent: string; accentSoft: string
  pos: string; posSoft: string
  cream: string; mist: string; second: string
  posR: string; accR: string; cR: string
}

const THEME_TOKENS: Record<DeckTheme, ThemeTokens> = {
  深蓝: {
    bgd: '#0B1730', bgm: '#101f3d', bgh: '#16264a',
    accent: '#F5C518', accentSoft: '#FCE38A',
    pos: '#3DB389', posSoft: '#6FD9B0',
    cream: '#FAF6F0', mist: '#A6B6D4', second: '#2E5A8F',
    posR: '61,179,137', accR: '245,197,24', cR: '250,246,240',
  },
  青竹: {
    bgd: '#0A1F17', bgm: '#0E2A20', bgh: '#143528',
    accent: '#E6B23C', accentSoft: '#F3D289',
    pos: '#4FBE85', posSoft: '#7FD9AC',
    cream: '#FAF7EE', mist: '#9FBFAF', second: '#2E7D5B',
    posR: '79,190,133', accR: '230,178,60', cR: '250,247,238',
  },
  黛紫: {
    bgd: '#1A0F2E', bgm: '#221338', bgh: '#2C1A46',
    accent: '#E9B84C', accentSoft: '#F5D48E',
    pos: '#57C08F', posSoft: '#84D9B2',
    cream: '#FAF5EF', mist: '#B5A8CC', second: '#5A3E8E',
    posR: '87,192,143', accR: '233,184,76', cR: '250,245,239',
  },
}

/** 服务端大纲协议（与 /api/plugin/v1/skills/deck-builder 对齐）。 */
export interface DeckOutlineMeta {
  deck_title: string
  session?: string
  presenter?: string
  brand?: string
  schedule?: string
  format_line?: string
}

export interface DeckSlide {
  type: string
  [key: string]: unknown
}

export interface DeckOutline {
  meta: DeckOutlineMeta
  slides: DeckSlide[]
}

export const DECK_MIN_SLIDES = 4
export const DECK_MAX_SLIDES = 20
export const DECK_KNOWN_TYPES = new Set([
  'cover', 'statement', 'list', 'cards', 'quote', 'flow', 'image', 'imagetext', 'homework', 'end',
])

/** 单字段字数硬上限：超限不整单失败，装配时按此截断（保版面，不保长句）。 */
const CLIP_LIMITS: Record<string, number> = {
  title: 22, kicker: 26, big: 18, text: 48, promise: 22, subtitle: 26,
  badge: 26, quote: 30, cap: 36, head: 14, body: 52, name: 14, desc: 26,
  item: 44, point: 32, task: 44, pre: 18, note: 26,
}

function esc(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 仅放行 <b>…</b> 强调；其余一律转义，防止模型夹带任意 HTML。 */
function inline(value: unknown, limit: number): string {
  const raw = (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '').trim()
  const clipped = clipVisible(raw, limit)
  return esc(clipped).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
}

/** 按可见字数截断（<b> 标签不计入），超限补省略号。 */
export function clipVisible(raw: string, limit: number): string {
  const stripped = raw.replace(/<\/?b>/g, '')
  if (stripped.length <= limit) return raw
  // 超限时先去掉标签再截断，避免截出半个标签。
  return `${stripped.slice(0, Math.max(1, limit - 1))}…`
}

export interface DeckValidationIssue {
  slideIndex: number
  problem: string
}

/** 结构校验：只拦«装不出来»的硬伤，文字超长交给装配期截断。 */
export function validateDeckOutline(outline: unknown): {
  ok: boolean
  outline?: DeckOutline
  issues: DeckValidationIssue[]
} {
  const issues: DeckValidationIssue[] = []
  if (!outline || typeof outline !== 'object') {
    return { ok: false, issues: [{ slideIndex: -1, problem: '大纲不是 JSON 对象' }] }
  }
  const data = outline as DeckOutline
  if (!data.meta || typeof data.meta.deck_title !== 'string' || !data.meta.deck_title.trim()) {
    issues.push({ slideIndex: -1, problem: 'meta.deck_title 缺失' })
  }
  const slides = Array.isArray(data.slides) ? data.slides : []
  if (slides.length < DECK_MIN_SLIDES) {
    issues.push({ slideIndex: -1, problem: `页数不足 ${DECK_MIN_SLIDES} 页` })
  }
  if (slides.length > DECK_MAX_SLIDES) {
    issues.push({ slideIndex: -1, problem: `页数超过 ${DECK_MAX_SLIDES} 页` })
  }
  slides.forEach((slide, index) => {
    if (!slide || typeof slide !== 'object' || typeof slide.type !== 'string') {
      issues.push({ slideIndex: index, problem: '缺少 type' })
      return
    }
    if (!DECK_KNOWN_TYPES.has(slide.type)) {
      issues.push({ slideIndex: index, problem: `未知页型 ${slide.type}` })
      return
    }
    const need = (field: string): void => {
      const value = (slide as Record<string, unknown>)[field]
      if (typeof value !== 'string' || !value.trim()) {
        issues.push({ slideIndex: index, problem: `${slide.type} 缺少 ${field}` })
      }
    }
    if (slide.type === 'cover') { need('title_prefix') }
    if (slide.type === 'statement') { need('title'); need('big') }
    if (slide.type === 'list' || slide.type === 'imagetext') {
      const items = (slide as Record<string, unknown>)[slide.type === 'list' ? 'items' : 'points']
      if (!Array.isArray(items) || items.length === 0) {
        issues.push({ slideIndex: index, problem: `${slide.type} 缺少条目` })
      }
    }
    if (slide.type === 'cards') {
      const cards = (slide as Record<string, unknown>).cards
      if (!Array.isArray(cards) || cards.length < 2) {
        issues.push({ slideIndex: index, problem: 'cards 少于 2 张' })
      }
    }
    if (slide.type === 'quote') { need('quote') }
    if (slide.type === 'flow') {
      const nodes = (slide as Record<string, unknown>).nodes
      if (!Array.isArray(nodes) || nodes.length < 2) {
        issues.push({ slideIndex: index, problem: 'flow 节点少于 2 个' })
      }
    }
    if (slide.type === 'image' || slide.type === 'imagetext') { need('image') }
    if (slide.type === 'end') { need('title') }
  })
  return { ok: issues.length === 0, outline: data, issues }
}

/** 大纲里引用的全部图片令牌（按出现顺序去重）。 */
export function deckImageTokens(outline: DeckOutline): string[] {
  const tokens: string[] = []
  for (const slide of outline.slides) {
    const image = (slide as Record<string, unknown>).image
    if (typeof image === 'string' && image.trim() && !tokens.includes(image.trim())) {
      tokens.push(image.trim())
    }
  }
  return tokens
}

// ── 组件渲染 ──────────────────────────────────────────────────────────

type ImageResolver = (token: string) => string | undefined

function str(slide: DeckSlide, field: string): string {
  const value = (slide as Record<string, unknown>)[field]
  return typeof value === 'string' ? value.trim() : ''
}

function listOf(slide: DeckSlide, field: string): Array<Record<string, unknown>> {
  const value = (slide as Record<string, unknown>)[field]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

function kicker(slide: DeckSlide, fallback: string, jade = false): string {
  const text = inline(str(slide, 'kicker') || fallback, CLIP_LIMITS.kicker)
  const style = jade ? ' style="color:var(--jade-soft);"' : ''
  return `<div class="kicker"${style}>${text}</div>`
}

function title(slide: DeckSlide): string {
  return `<h2 class="t">${inline(str(slide, 'title'), CLIP_LIMITS.title)}</h2>`
}

function renderCover(slide: DeckSlide, meta: DeckOutlineMeta): string {
  const badge = inline(str(slide, 'badge') || `${meta.deck_title}${meta.session ? ` · ${meta.session}` : ''}`, CLIP_LIMITS.badge)
  const subtitle = inline(str(slide, 'subtitle') || meta.deck_title, CLIP_LIMITS.subtitle)
  const prefix = inline(str(slide, 'title_prefix'), CLIP_LIMITS.title)
  const accent = inline(str(slide, 'title_accent'), 8)
  const promise = inline(str(slide, 'promise'), CLIP_LIMITS.promise)
  const chips: string[] = []
  if (meta.presenter) {
    chips.push(`主讲：<b style="color:var(--cream);">${esc(meta.presenter)}</b>${meta.brand ? `｜${esc(meta.brand)}` : ''}`)
  }
  if (meta.schedule) chips.push(esc(meta.schedule))
  if (meta.format_line) chips.push(esc(meta.format_line))
  const chipHtml = chips
    .map((chip) => `<span style="border:1px solid rgba(200,200,200,.18);border-radius:12px;padding:9px 18px;">${chip}</span>`)
    .join('\n        ')
  return `<section class="slide" data-title="封面">
    <div class="body" style="align-items:flex-start;">
      <div style="font-size:18px;font-weight:700;letter-spacing:.24em;color:var(--jade-soft);margin-bottom:26px;border:1px solid rgba(120,200,160,.45);border-radius:99px;padding:8px 22px;background:rgba(120,200,160,.1);">${badge}</div>
      <div style="font-size:32px;color:var(--mist);font-weight:600;margin-bottom:10px;">${subtitle}</div>
      <h1 style="font-size:72px;font-weight:800;color:var(--cream);line-height:1.2;margin-bottom:8px;">${prefix}<span class="accent">${accent}</span></h1>
      <div style="font-size:36px;font-weight:700;color:var(--gold-soft);margin-bottom:44px;">${promise}</div>
      <div style="display:flex;gap:14px;font-size:19px;color:var(--mist);">
        ${chipHtml}
      </div>
    </div>
  </section>`
}

function renderStatement(slide: DeckSlide): string {
  return `<section class="slide" data-title="${esc(clipVisible(str(slide, 'title'), 10))}">
    ${kicker(slide, 'POINT · 核心观点')}
    ${title(slide)}
    <div class="body" style="align-items:center;text-align:center;">
      <div style="font-size:46px;font-weight:800;color:var(--cream);margin-bottom:26px;">${inline(str(slide, 'big'), CLIP_LIMITS.big)}</div>
      <div style="font-size:27px;color:var(--gold-soft);line-height:1.7;">${inline(str(slide, 'text'), CLIP_LIMITS.text)}</div>
    </div>
  </section>`
}

function renderList(slide: DeckSlide): string {
  const items = listOf(slide, 'items').slice(0, 6)
  const rows = items
    .map((item, index) =>
      `<li><span class="chip">${index + 1}</span><div>${inline(item.text, CLIP_LIMITS.item)}</div></li>`)
    .join('\n      ')
  return `<section class="slide" data-title="${esc(clipVisible(str(slide, 'title'), 10))}">
    ${kicker(slide, 'PART · 要点')}
    ${title(slide)}
    <div class="body">
      <ul class="list">
      ${rows}
      </ul>
    </div>
  </section>`
}

function renderCards(slide: DeckSlide): string {
  const cards = listOf(slide, 'cards').slice(0, 4)
  const cells = cards
    .map((card) => {
      const highlight = card.highlight === true
      const border = highlight ? 'border-color:rgba(240,190,80,.5);' : ''
      const headColor = highlight ? 'var(--gold)' : 'var(--cream)'
      return `<div class="card" style="padding:28px 30px;${border}">
        <div style="font-size:26px;font-weight:800;color:${headColor};margin-bottom:12px;">${inline(card.head, CLIP_LIMITS.head)}</div>
        <div style="font-size:21px;color:var(--mist);line-height:1.65;">${inline(card.body, CLIP_LIMITS.body)}</div>
      </div>`
    })
    .join('\n      ')
  const note = str(slide, 'note')
  const noteHtml = note
    ? `<div style="margin-top:30px;text-align:center;font-size:24px;color:var(--jade-soft);font-weight:700;">${inline(note, CLIP_LIMITS.note)}</div>`
    : ''
  return `<section class="slide" data-title="${esc(clipVisible(str(slide, 'title'), 10))}">
    ${kicker(slide, 'METHOD · 方法')}
    ${title(slide)}
    <div class="body">
      <div style="display:grid;grid-template-columns:repeat(${cards.length},1fr);gap:20px;">
      ${cells}
      </div>${noteHtml}
    </div>
  </section>`
}

function renderQuote(slide: DeckSlide): string {
  const quote = inline(str(slide, 'quote').replace(/^「|」$/g, ''), CLIP_LIMITS.quote)
  return `<section class="slide" data-title="金句">
    ${kicker(slide, 'KEY · 记住这句')}
    <div class="body" style="align-items:center;">
      <div class="quote" style="font-size:48px;text-align:center;line-height:1.8;">「${quote}」</div>
    </div>
  </section>`
}

const FLOW_STYLES = [
  'background:rgba(90,130,180,.22);border:2px solid var(--sea);',
  'background:rgba(90,190,140,.16);border:2px solid var(--jade);',
  'background:rgba(240,190,80,.13);border:2px solid var(--gold);',
]
const FLOW_NAME_COLORS = ['var(--cream)', 'var(--jade-soft)', 'var(--gold)']

function renderFlow(slide: DeckSlide): string {
  const nodes = listOf(slide, 'nodes').slice(0, 4)
  const cells = nodes
    .map((node, index) => {
      const arrow = index > 0 ? '<div class="arrow">→</div>' : ''
      const style = FLOW_STYLES[Math.min(index, FLOW_STYLES.length - 1)]
      const color = FLOW_NAME_COLORS[Math.min(index, FLOW_NAME_COLORS.length - 1)]
      return `${arrow}<div style="flex:1;text-align:center;"><div style="border-radius:24px;${style}padding:28px 18px;display:flex;flex-direction:column;gap:10px;"><div style="font-size:27px;font-weight:800;color:${color};">${inline(node.name, CLIP_LIMITS.name)}</div><div style="font-size:19px;color:var(--mist);line-height:1.6;">${inline(node.desc, CLIP_LIMITS.desc)}</div></div></div>`
    })
    .join('\n      ')
  return `<section class="slide" data-title="${esc(clipVisible(str(slide, 'title'), 10))}">
    ${kicker(slide, 'PATH · 路径')}
    ${title(slide)}
    <div class="body">
      <div style="display:flex;align-items:center;gap:16px;">
      ${cells}
      </div>
    </div>
  </section>`
}

function renderImage(slide: DeckSlide, resolve: ImageResolver): string {
  const src = resolve(str(slide, 'image'))
  if (!src) return ''
  return `<section class="slide" data-title="${esc(clipVisible(str(slide, 'title'), 10))}">
    ${kicker(slide, 'DEMO · 界面演示')}
    ${title(slide)}
    <div class="body">
      <div class="shot" style="height:460px;margin:0 auto;width:860px;"><img src="${src}" alt="${esc(str(slide, 'cap'))}"></div>
      <div class="cap">${inline(str(slide, 'cap'), CLIP_LIMITS.cap)}</div>
    </div>
  </section>`
}

function renderImageText(slide: DeckSlide, resolve: ImageResolver): string {
  const src = resolve(str(slide, 'image'))
  if (!src) return renderList({ ...slide, type: 'list', items: listOf(slide, 'points').map((point) => ({ text: point.text })) })
  const points = listOf(slide, 'points').slice(0, 4)
  const rows = points
    .map((point, index) =>
      `<li style="font-size:23px;"><span class="chip" style="width:34px;height:34px;font-size:17px;">${index + 1}</span><div>${inline(point.text, CLIP_LIMITS.point)}</div></li>`)
    .join('\n          ')
  return `<section class="slide" data-title="${esc(clipVisible(str(slide, 'title'), 10))}">
    ${kicker(slide, 'CASE · 讲解')}
    ${title(slide)}
    <div class="body">
      <div style="display:flex;gap:32px;align-items:center;">
        <div style="flex:1;">
          <ul class="list" style="gap:18px;">
          ${rows}
          </ul>
        </div>
        <div class="shot" style="flex:0 0 560px;height:420px;"><img src="${src}" alt="${esc(str(slide, 'title'))}"></div>
      </div>
    </div>
  </section>`
}

function renderHomework(slide: DeckSlide): string {
  const checkin = ((slide as Record<string, unknown>).checkin as unknown[] | undefined ?? [])
    .filter((line): line is string => typeof line === 'string')
    .slice(0, 6)
    .map((line) => esc(clipVisible(line, 30)))
    .join('<br>')
  const tasks = listOf(slide, 'tasks').slice(0, 4)
  const rows = tasks
    .map((task, index) =>
      `<li style="font-size:21px;"><span class="chip" style="width:32px;height:32px;font-size:16px;">${index + 1}</span><div>${inline(task.text, CLIP_LIMITS.task)}</div></li>`)
    .join('\n          ')
  return `<section class="slide" data-title="打卡与作业">
    ${kicker(slide, 'HOMEWORK · 打卡与作业', true)}
    ${title(slide)}
    <div class="body">
      <div style="display:flex;gap:28px;">
        <div class="card" style="flex:0.85;padding:28px 32px;">
          <div style="font-size:17px;letter-spacing:.18em;color:var(--mist);font-weight:800;margin-bottom:14px;">📝 群内打卡模板</div>
          <div style="font-size:21px;color:var(--cream);line-height:2;font-family:ui-monospace,Menlo,monospace;">${checkin}</div>
        </div>
        <div class="card" style="flex:1.15;padding:28px 32px;border-color:rgba(240,190,80,.35);">
          <div style="font-size:17px;letter-spacing:.18em;color:var(--gold);font-weight:800;margin-bottom:14px;">✅ 行动作业</div>
          <ul class="list" style="gap:18px;">
          ${rows}
          </ul>
        </div>
      </div>
    </div>
  </section>`
}

function renderEnd(slide: DeckSlide): string {
  const links = ((slide as Record<string, unknown>).links as unknown[] | undefined ?? [])
    .filter((link): link is string => typeof link === 'string')
    .slice(0, 3)
    .map((link) => `<span style="border:1px solid rgba(250,246,240,.18);border-radius:99px;padding:8px 20px;">${esc(clipVisible(link, 30))}</span>`)
    .join('\n        ')
  const tip = str(slide, 'tip')
  const quote = str(slide, 'quote')
  return `<section class="slide" data-title="结尾">
    <div class="body" style="align-items:center;text-align:center;">
      <div style="font-size:18px;letter-spacing:.3em;color:var(--jade-soft);font-weight:700;margin-bottom:26px;">${inline(str(slide, 'pre'), CLIP_LIMITS.pre)}</div>
      <div style="font-size:48px;font-weight:800;color:var(--cream);margin-bottom:14px;">${inline(str(slide, 'title'), 14)}</div>
      <div style="font-size:28px;color:var(--mist);margin-bottom:44px;">${inline(str(slide, 'subtitle'), CLIP_LIMITS.subtitle)}</div>
      ${tip ? `<div class="tipbar" style="margin-bottom:44px;">${inline(tip, 40)}</div>` : ''}
      ${quote ? `<div class="quote" style="font-size:32px;line-height:1.8;">「${inline(quote.replace(/^「|」$/g, ''), CLIP_LIMITS.quote)}」</div>` : ''}
      ${links ? `<div style="margin-top:40px;display:flex;gap:16px;font-size:17px;color:var(--mist);justify-content:center;">${links}</div>` : ''}
    </div>
  </section>`
}

function renderSlide(slide: DeckSlide, meta: DeckOutlineMeta, resolve: ImageResolver): string {
  switch (slide.type) {
    case 'cover': return renderCover(slide, meta)
    case 'statement': return renderStatement(slide)
    case 'list': return renderList(slide)
    case 'cards': return renderCards(slide)
    case 'quote': return renderQuote(slide)
    case 'flow': return renderFlow(slide)
    case 'image': return renderImage(slide, resolve)
    case 'imagetext': return renderImageText(slide, resolve)
    case 'homework': return renderHomework(slide)
    case 'end': return renderEnd(slide)
    default: return ''
  }
}

// ── 整份文档 ──────────────────────────────────────────────────────────

export interface AssembleDeckOptions {
  outline: DeckOutline
  theme: DeckTheme
  /** 图片令牌 → dataUrl（UI 层已解析并压缩）；缺失的令牌对应页会被跳过或降级。 */
  imageDataUrls: Map<string, string>
}

export function assembleDeckHtml(options: AssembleDeckOptions): string {
  const { outline, theme, imageDataUrls } = options
  const tokens = THEME_TOKENS[theme] ?? THEME_TOKENS['深蓝']
  const resolve: ImageResolver = (token) => imageDataUrls.get(token.trim())
  const meta = outline.meta
  const brandText = [meta.presenter, meta.brand, meta.deck_title].filter(Boolean).join(' · ')
  const slides = outline.slides
    .map((slide) => renderSlide(slide, meta, resolve))
    .filter(Boolean)
    .join('\n\n')
  const titleText = `${meta.deck_title}${meta.session ? `｜${meta.session}` : ''}`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titleText)}</title>
<style>
  :root{
    --bgd:${tokens.bgd};--bgm:${tokens.bgm};--bgh:${tokens.bgh};--gold:${tokens.accent};--gold-soft:${tokens.accentSoft};
    --jade:${tokens.pos};--jade-soft:${tokens.posSoft};--cream:${tokens.cream};--mist:${tokens.mist};--sea:${tokens.second};
    --brand-text:"${esc(brandText)}";
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{height:100%;background:var(--bgd);overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;}
  #viewport{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;}
  #stage{position:relative;width:1280px;height:720px;flex:0 0 auto;overflow:hidden;
    background:radial-gradient(1100px 700px at 78% -10%, var(--bgh) 0%, var(--bgd) 55%),
               linear-gradient(160deg, var(--bgm) 0%, var(--bgd) 60%, var(--bgd) 100%);}
  .deco{position:absolute;pointer-events:none;z-index:0;}
  .ripple{border-radius:50%;border:1.5px solid rgba(${tokens.cR},.05);}
  .dot{width:6px;height:6px;border-radius:50%;background:var(--gold);opacity:.5;
    box-shadow:0 0 12px 2px rgba(${tokens.accR},.35);}
  .slide{position:absolute;inset:0;padding:56px 72px 64px;display:flex;flex-direction:column;
    opacity:0;pointer-events:none;transform:translateY(14px);
    transition:opacity .45s ease,transform .45s ease;z-index:1;}
  .slide.active{opacity:1;pointer-events:auto;transform:none;z-index:2;}
  .kicker{font-size:16px;font-weight:700;letter-spacing:.28em;color:var(--gold);margin-bottom:14px;}
  h2.t{font-size:46px;font-weight:800;color:var(--cream);line-height:1.25;margin-bottom:10px;}
  .sub{font-size:22px;color:var(--mist);line-height:1.6;}
  .accent{color:var(--gold);} .jadec{color:var(--jade-soft);}
  .body{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;}
  .card{background:rgba(${tokens.cR},.055);border:1px solid rgba(${tokens.cR},.12);border-radius:20px;}
  .quote{font-family:Georgia,"Songti SC","STSong","Source Han Serif SC",serif;
    font-style:italic;color:var(--gold-soft);}
  .chip{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;font-weight:800;
    width:40px;height:40px;border-radius:12px;background:rgba(${tokens.posR},.16);color:var(--jade-soft);
    border:1px solid rgba(${tokens.posR},.4);font-size:20px;margin-top:2px;}
  ul.list{list-style:none;display:flex;flex-direction:column;gap:22px;}
  ul.list li{display:flex;gap:20px;align-items:flex-start;font-size:26px;color:var(--cream);line-height:1.6;}
  .arrow{color:var(--jade);font-size:28px;font-weight:800;}
  .tipbar{background:rgba(${tokens.accR},.1);border:1px solid rgba(${tokens.accR},.35);border-radius:14px;
    padding:14px 24px;font-size:21px;color:var(--gold-soft);}
  .shot{background:var(--cream);border-radius:14px;padding:8px;box-shadow:0 14px 36px rgba(0,0,0,.45);}
  .shot img{display:block;width:100%;height:100%;object-fit:contain;border-radius:8px;}
  .cap{font-size:18px;color:var(--mist);text-align:center;margin-top:12px;}
  #footer{position:absolute;left:0;right:0;bottom:0;height:44px;display:flex;align-items:center;
    justify-content:space-between;padding:0 26px;z-index:5;pointer-events:none;}
  #brand{font-size:13px;letter-spacing:.12em;color:rgba(${tokens.cR},.4);}
  #count{font-size:14px;color:rgba(${tokens.cR},.55);}
  #dots{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;display:flex;gap:7px;z-index:6;}
  #dots span{width:7px;height:7px;border-radius:50%;background:rgba(${tokens.cR},.18);cursor:pointer;}
  #dots span.on{background:var(--gold);}
  #bar{position:absolute;left:0;bottom:0;height:5px;width:100%;z-index:7;
    background:linear-gradient(90deg,var(--sea),var(--jade),var(--gold));
    transform-origin:0 50%;transform:scaleX(0);transition:transform .4s;}
  #hint{position:absolute;right:26px;bottom:54px;font-size:13px;color:rgba(${tokens.cR},.35);z-index:5;}
  @media print{
    @page{size:1280px 720px;margin:0;}
    html,body{height:auto;overflow:visible;}
    #viewport{position:static;display:block;}
    #stage{width:1280px;height:auto;overflow:visible;background:none;transform:none!important;}
    .deco,#footer,#dots,#hint,#bar{display:none!important;}
    .slide{position:relative;inset:auto;opacity:1!important;transform:none!important;transition:none;
      width:1280px;height:720px;overflow:hidden;page-break-after:always;break-after:page;
      background:radial-gradient(1100px 700px at 78% -10%, var(--bgh) 0%, var(--bgd) 55%),
                 linear-gradient(160deg, var(--bgm) 0%, var(--bgd) 60%, var(--bgd) 100%);}
    .slide::after{content:var(--brand-text);position:absolute;left:26px;bottom:15px;
      font-size:13px;letter-spacing:.12em;color:rgba(${tokens.cR},.4);}
  }
</style>
</head>
<body>
<div id="viewport"><div id="stage">

  <div class="deco ripple" style="width:620px;height:620px;left:-230px;bottom:-260px;"></div>
  <div class="deco ripple" style="width:460px;height:460px;left:-150px;bottom:-180px;"></div>
  <div class="deco ripple" style="width:300px;height:300px;left:-70px;bottom:-100px;"></div>
  <div class="deco ripple" style="width:520px;height:520px;right:-220px;top:-240px;"></div>
  <div class="deco dot" style="right:120px;top:110px;"></div>
  <div class="deco dot" style="left:90px;bottom:150px;width:5px;height:5px;opacity:.3;"></div>

${slides}

  <div id="footer">
    <span id="brand">${esc(brandText)}</span>
    <span id="count">1 / ${outline.slides.length}</span>
  </div>
  <div id="dots">${outline.slides.map(() => '<span></span>').join('')}</div>
  <div id="hint">← → 翻页 · F 全屏 · ⌘P 存PDF</div>
  <div id="bar"></div>
</div></div>

<script>
(function(){
  const slides=[...document.querySelectorAll('.slide')];
  const stage=document.getElementById('stage');
  const dots=document.getElementById('dots');
  const bar=document.getElementById('bar');
  const count=document.getElementById('count');
  let cur=0;
  const dotEls=[...dots.children];
  dotEls.forEach((d,i)=>{d.title=(slides[i]&&slides[i].dataset.title)||'';
    d.addEventListener('click',e=>{e.stopPropagation();go(i);});});
  function go(n){cur=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach((s,i)=>s.classList.toggle('active',i===cur));
    dotEls.forEach((d,i)=>d.classList.toggle('on',i===cur));
    count.textContent=(cur+1)+' / '+slides.length;
    bar.style.transform='scaleX('+((cur+1)/slides.length)+')';}
  function fit(){const s=Math.min(innerWidth/1280,innerHeight/720);stage.style.transform='scale('+s+')';}
  stage.style.transformOrigin='center center';addEventListener('resize',fit);fit();
  addEventListener('keydown',e=>{
    if(['ArrowRight','ArrowDown','PageDown',' '].includes(e.key)){e.preventDefault();go(cur+1);}
    else if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){e.preventDefault();go(cur-1);}
    else if(e.key==='Home'){go(0);}else if(e.key==='End'){go(slides.length-1);}
    else if(e.key==='f'||e.key==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();}});
  stage.addEventListener('click',e=>{const r=stage.getBoundingClientRect();
    const x=(e.clientX-r.left)/r.width;x<0.22?go(cur-1):go(cur+1);});
  addEventListener('beforeprint',()=>{stage.style.transform='none';});
  addEventListener('afterprint',()=>{fit();});
  go(0);
})();
</script>
</body>
</html>`
}

// ── 源文档图片令牌提取（发送前在本机解析）───────────────────────────────

export interface SourceImageToken {
  /** 原文里的写法（发给服务端并回填到大纲）。 */
  token: string
  /** wikilink 内目标（`![[a.png|说明]]` → `a.png`）；markdown 链接为解码后的路径。 */
  target: string
}

/** 从 Markdown 源文提取图片令牌：`![](path)` 与 `![[wikilink]]`，按目标文件去重。 */
export function extractSourceImageTokens(markdown: string): SourceImageToken[] {
  const tokens: SourceImageToken[] = []
  const seen = new Set<string>()
  const push = (token: string, target: string): void => {
    const key = target.trim()
    if (!key || !token.trim() || seen.has(key)) return
    seen.add(key)
    tokens.push({ token: token.trim(), target: key })
  }
  const wikilink = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
  for (const match of markdown.matchAll(wikilink)) push(match[0], match[1])
  const mdlink = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of markdown.matchAll(mdlink)) {
    const target = match[1]
    if (/^https?:/i.test(target)) continue // 外链图片不解析、不下载
    let decoded = target
    try { decoded = decodeURIComponent(target) } catch { /* 保留原样 */ }
    push(match[0], decoded)
  }
  return tokens
}

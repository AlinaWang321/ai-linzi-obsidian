import { PDFDocument } from 'pdf-lib'
import { strToU8, zipSync } from 'fflate'
import {
  type CreatePresentationOperation,
  type PresentationCard,
  type PresentationColumn,
  type PresentationFormat,
  type PresentationMetric,
  type PresentationSlide,
  type PresentationStep,
  type PresentationTheme,
} from './presentation-renderer-core'

export interface RenderedPresentationFile {
  format: PresentationFormat
  binary: boolean
  data: string | ArrayBuffer
  mimeType: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function cssColor(value: string): string {
  return `#${value}`
}

function safeFont(value: string): string {
  return value.replace(/["'<>;]/g, '').trim() || 'Microsoft YaHei'
}

function htmlList(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${escapeXml(item)}</li>`).join('')}</ul>`
}

function htmlCards(cards: PresentationCard[]): string {
  return `<div class="cards count-${cards.length}">${cards.map((card, index) => `
    <article class="card">
      <span class="card-index">${escapeXml(card.label || String(index + 1).padStart(2, '0'))}</span>
      <h3>${escapeXml(card.title)}</h3>
      ${card.body ? `<p>${escapeXml(card.body)}</p>` : ''}
    </article>`).join('')}</div>`
}

function htmlColumns(columns: PresentationColumn[]): string {
  return `<div class="columns">${columns.map((column, index) => `
    <article class="column column-${index + 1}">
      <h3>${escapeXml(column.title)}</h3>
      ${htmlList(column.items)}
    </article>`).join('')}</div>`
}

function htmlSteps(steps: PresentationStep[], timeline: boolean): string {
  return `<div class="steps ${timeline ? 'timeline' : ''}">${steps.map((step, index) => `
    <article class="step">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <h3>${escapeXml(step.title)}</h3>
      ${step.body ? `<p>${escapeXml(step.body)}</p>` : ''}
    </article>`).join('')}</div>`
}

function htmlMetrics(metrics: PresentationMetric[]): string {
  return `<div class="metrics">${metrics.map((metric) => `
    <article class="metric">
      <strong>${escapeXml(metric.value)}</strong>
      <h3>${escapeXml(metric.label)}</h3>
      ${metric.note ? `<p>${escapeXml(metric.note)}</p>` : ''}
    </article>`).join('')}</div>`
}

function htmlTable(slide: PresentationSlide): string {
  if (!slide.table) return ''
  return `<div class="table-wrap"><table><thead><tr>${slide.table.headers.map((cell) => `<th>${escapeXml(cell)}</th>`).join('')}</tr></thead><tbody>${slide.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeXml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

function htmlSlide(slide: PresentationSlide, index: number, total: number): string {
  const header = `
    <header class="slide-header">
      ${slide.kicker ? `<div class="kicker">${escapeXml(slide.kicker)}</div>` : ''}
      <h2>${escapeXml(slide.title)}</h2>
      ${slide.subtitle ? `<p class="subtitle">${escapeXml(slide.subtitle)}</p>` : ''}
    </header>`
  let content = ''
  if (slide.type === 'cover' || slide.type === 'section' || slide.type === 'closing') {
    content = `<div class="hero">${header}${slide.body ? `<p class="hero-body">${escapeXml(slide.body)}</p>` : ''}</div>`
  } else if (slide.type === 'statement') {
    content = `${header}<div class="statement">${escapeXml(slide.body || slide.subtitle || slide.title)}</div>`
  } else if (slide.type === 'bullets') {
    content = `${header}<div class="bullet-layout">${htmlList(slide.bullets ?? [])}${slide.body ? `<aside>${escapeXml(slide.body)}</aside>` : ''}</div>`
  } else if (slide.type === 'cards') {
    content = `${header}${htmlCards(slide.cards ?? [])}`
  } else if (slide.type === 'comparison') {
    content = `${header}${htmlColumns(slide.columns ?? [])}`
  } else if (slide.type === 'process' || slide.type === 'timeline') {
    content = `${header}${htmlSteps(slide.steps ?? [], slide.type === 'timeline')}`
  } else if (slide.type === 'metrics') {
    content = `${header}${htmlMetrics(slide.metrics ?? [])}`
  } else if (slide.type === 'table') {
    content = `${header}${htmlTable(slide)}`
  } else {
    content = `${header}<blockquote><span>“</span>${escapeXml(slide.quote ?? '')}</blockquote>${slide.attribution ? `<div class="attribution">— ${escapeXml(slide.attribution)}</div>` : ''}`
  }
  return `<section class="slide slide-${slide.type}" data-index="${index}" aria-label="第 ${index + 1} 页">${content}<footer><span>${escapeXml(slide.footer ?? '')}</span><span>${index + 1} / ${total}</span></footer></section>`
}

function presentationHtml(operation: CreatePresentationOperation): string {
  const theme = operation.theme
  const slides = operation.slides.map((slide, index) => htmlSlide(slide, index, operation.slides.length)).join('\n')
  const radius = theme.shape === 'rounded' ? '24px' : '2px'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeXml(operation.title)}</title>
  <style>
    :root{--primary:${cssColor(theme.primary)};--accent:${cssColor(theme.accent)};--bg:${cssColor(theme.background)};--surface:${cssColor(theme.surface)};--text:${cssColor(theme.text)};--muted:${cssColor(theme.muted)};--radius:${radius};--heading:"${escapeXml(safeFont(theme.headingFont))}","Microsoft YaHei",sans-serif;--body:"${escapeXml(safeFont(theme.bodyFont))}","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}html,body{margin:0;background:#0b1220;color:var(--text);font-family:var(--body);overflow:hidden}button{font:inherit}
    .deck{height:100vh;display:grid;place-items:center}.slide{display:none;position:relative;width:min(100vw,177.777vh);height:min(100vh,56.25vw);aspect-ratio:16/9;background:var(--bg);overflow:hidden;padding:5.8% 6.4%;isolation:isolate}.slide.active{display:block}
    .slide:before{content:"";position:absolute;right:-12%;top:-38%;width:46%;aspect-ratio:1;border-radius:50%;border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);box-shadow:0 0 0 44px color-mix(in srgb,var(--accent) 5%,transparent),0 0 0 88px color-mix(in srgb,var(--primary) 4%,transparent);z-index:-1}
    .slide-header{max-width:86%}.kicker{font-size:clamp(10px,1.05vw,18px);font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin-bottom:.8em}.slide h2{font-family:var(--heading);font-size:clamp(25px,3.2vw,56px);line-height:1.08;margin:0;color:var(--primary);letter-spacing:-.025em}.subtitle{font-size:clamp(13px,1.45vw,25px);line-height:1.5;color:var(--muted);margin:.7em 0 0;max-width:85%}
    .hero{height:82%;display:flex;flex-direction:column;justify-content:center;max-width:82%}.slide-cover h2,.slide-section h2,.slide-closing h2{font-size:clamp(36px,5.5vw,92px);color:var(--primary)}.hero-body{font-size:clamp(16px,1.8vw,30px);line-height:1.55;color:var(--muted);max-width:75%;margin:1.2em 0 0}.slide-cover:after,.slide-section:after,.slide-closing:after{content:"";position:absolute;left:6.4%;bottom:14%;width:14%;height:6px;background:var(--accent)}
    .statement{font-family:var(--heading);font-size:clamp(29px,4.3vw,74px);font-weight:800;line-height:1.2;max-width:88%;margin-top:8%;color:var(--primary)}
    .bullet-layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,.65fr);gap:5%;margin-top:4%}.bullet-layout>ul{list-style:none;padding:0;margin:0}.bullet-layout>ul li{position:relative;padding:.48em 0 .48em 1.35em;font-size:clamp(15px,1.75vw,29px);line-height:1.35}.bullet-layout>ul li:before{content:"";position:absolute;left:0;top:.98em;width:.42em;height:.42em;background:var(--accent);border-radius:50%}.bullet-layout aside{background:var(--primary);color:var(--surface);padding:8%;border-radius:var(--radius);font-size:clamp(13px,1.4vw,23px);line-height:1.55;align-self:start}
    .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2.2%;margin-top:4%}.cards.count-2,.cards.count-4{grid-template-columns:repeat(2,minmax(0,1fr))}.card{min-height:150px;background:var(--surface);border:1px solid color-mix(in srgb,var(--primary) 12%,transparent);border-radius:var(--radius);padding:7%;box-shadow:0 18px 40px color-mix(in srgb,var(--primary) 8%,transparent)}.card-index{display:inline-block;color:var(--accent);font-weight:900;font-size:clamp(11px,1vw,17px);letter-spacing:.12em}.card h3,.column h3,.step h3,.metric h3{font-family:var(--heading);font-size:clamp(16px,1.65vw,28px);margin:.55em 0;color:var(--primary)}.card p,.step p,.metric p{font-size:clamp(12px,1.1vw,19px);line-height:1.5;color:var(--muted);margin:0}
    .columns{display:grid;grid-template-columns:1fr 1fr;gap:3%;margin-top:4%}.column{padding:5%;border-radius:var(--radius);background:var(--surface);border-top:8px solid var(--primary)}.column-2{border-top-color:var(--accent)}.column ul{padding-left:1.2em;margin:.7em 0 0}.column li{font-size:clamp(13px,1.32vw,22px);line-height:1.45;margin:.45em 0}
    .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:1.5%;margin-top:6%;position:relative}.steps:before{content:"";position:absolute;left:4%;right:4%;top:1.25em;height:3px;background:color-mix(in srgb,var(--primary) 18%,transparent);z-index:-1}.step{padding-right:5%}.step>span{display:grid;place-items:center;width:2.5em;height:2.5em;border-radius:50%;background:var(--accent);color:var(--primary);font-weight:900}.step h3{font-size:clamp(14px,1.4vw,23px)}.timeline .step:nth-child(even)>span{background:var(--primary);color:var(--surface)}
    .metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2%;margin-top:5%}.metric{padding:7%;background:var(--surface);border-radius:var(--radius);border-bottom:7px solid var(--accent)}.metric strong{font-family:var(--heading);font-size:clamp(30px,4.2vw,70px);line-height:1;color:var(--primary)}
    .table-wrap{margin-top:3%;background:var(--surface);border-radius:var(--radius);overflow:hidden}table{width:100%;border-collapse:collapse;font-size:clamp(10px,1.05vw,18px)}th{background:var(--primary);color:var(--surface);font-family:var(--heading)}th,td{padding:.7em .9em;text-align:left;border-bottom:1px solid color-mix(in srgb,var(--primary) 12%,transparent)}tbody tr:nth-child(even){background:color-mix(in srgb,var(--background) 55%,var(--surface))}
    blockquote{position:relative;font-family:var(--heading);font-size:clamp(26px,4vw,68px);font-weight:800;line-height:1.28;margin:7% 0 0;max-width:88%;color:var(--primary)}blockquote span{position:absolute;left:-.65em;top:-.45em;font-size:2.3em;color:color-mix(in srgb,var(--accent) 38%,transparent)}.attribution{font-size:clamp(13px,1.3vw,22px);color:var(--muted);margin-top:2.5%}
    footer{position:absolute;left:6.4%;right:6.4%;bottom:4%;display:flex;justify-content:space-between;color:var(--muted);font-size:clamp(9px,.8vw,14px)}
    .controls{position:fixed;right:22px;bottom:18px;display:flex;gap:8px;z-index:20}.controls button{width:42px;height:42px;border:0;border-radius:50%;background:rgba(255,255,255,.88);color:#172033;box-shadow:0 8px 25px rgba(0,0,0,.25);cursor:pointer}.progress{position:fixed;left:0;bottom:0;height:4px;background:var(--accent);transition:width .25s;z-index:30}
    @media(max-aspect-ratio:1/1){.controls{right:10px;bottom:10px}.controls button{width:36px;height:36px}}
    @media print{html,body{overflow:visible;background:#fff}.deck{display:block;height:auto}.slide{display:block!important;width:13.333in;height:7.5in;break-after:page}.controls,.progress{display:none}}
  </style>
</head>
<body>
  <main class="deck">${slides}</main>
  <div class="controls"><button id="prev" aria-label="上一页">←</button><button id="next" aria-label="下一页">→</button></div>
  <div class="progress" id="progress"></div>
  <script>
    (()=>{const slides=[...document.querySelectorAll('.slide')];let index=Math.max(0,Math.min(slides.length-1,Number(location.hash.slice(1))-1||0));const show=()=>{slides.forEach((slide,i)=>slide.classList.toggle('active',i===index));document.getElementById('progress').style.width=((index+1)/slides.length*100)+'%';history.replaceState(null,'','#'+(index+1));};const move=(delta)=>{index=Math.max(0,Math.min(slides.length-1,index+delta));show();};document.getElementById('prev').onclick=()=>move(-1);document.getElementById('next').onclick=()=>move(1);addEventListener('keydown',event=>{if(['ArrowRight',' ','PageDown'].includes(event.key))move(1);if(['ArrowLeft','PageUp'].includes(event.key))move(-1);if(event.key==='Home'){index=0;show()}if(event.key==='End'){index=slides.length-1;show()}});show();})();
  </script>
</body>
</html>`
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const EMU = 914400
const emu = (value: number) => Math.round(value * EMU)

function pptxRect(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  options: { radius?: boolean; line?: string; transparency?: number } = {},
): string {
  const geometry = options.radius ? 'roundRect' : 'rect'
  const alpha = options.transparency ? `<a:alpha val="${Math.max(0, Math.min(100, 100 - options.transparency)) * 1000}"/>` : ''
  const line = options.line
    ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${options.line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rectangle ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}">${alpha}</a:srgbClr></a:solidFill>${line}</p:spPr></p:sp>`
}

function pptxText(
  id: number,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    size: number
    color: string
    font: string
    bold?: boolean
    align?: 'l' | 'r' | 'ctr'
    anchor?: 't' | 'ctr' | 'b'
    margin?: number
  },
): string {
  const margin = emu(options.margin ?? .05)
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="${options.anchor ?? 't'}" lIns="${margin}" rIns="${margin}" tIns="${margin}" bIns="${margin}"/><a:lstStyle/><a:p><a:pPr algn="${options.align ?? 'l'}"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(options.size * 100)}"${options.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${options.color}"/></a:solidFill><a:latin typeface="${escapeXml(options.font)}"/><a:ea typeface="${escapeXml(options.font)}"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${Math.round(options.size * 100)}"/></a:p></p:txBody></p:sp>`
}

function titleSize(title: string, hero = false): number {
  if (hero) return title.length > 34 ? 32 : title.length > 20 ? 38 : 46
  return title.length > 38 ? 23 : title.length > 24 ? 27 : 31
}

function bodySize(text: string, base = 18): number {
  return text.length > 180 ? base - 3 : text.length > 100 ? base - 1 : base
}

function renderPptxSlide(slide: PresentationSlide, index: number, total: number, theme: PresentationTheme): string {
  const shapes: string[] = []
  let id = 2
  const rect = (x: number, y: number, w: number, h: number, fill: string, options?: Parameters<typeof pptxRect>[6]) => shapes.push(pptxRect(id++, x, y, w, h, fill, options))
  const text = (value: string, x: number, y: number, w: number, h: number, size: number, color = theme.text, bold = false, align: 'l' | 'r' | 'ctr' = 'l', font = theme.bodyFont) => shapes.push(pptxText(id++, value, x, y, w, h, { size, color, bold, align, font, margin: .04 }))
  const rounded = theme.shape === 'rounded'

  rect(0, 0, 13.333, 7.5, theme.background)
  rect(12.65, -.5, 1.3, 3.2, theme.accent, { radius: true, transparency: 82 })
  if (slide.type === 'cover' || slide.type === 'section' || slide.type === 'closing') {
    if (slide.kicker) text(slide.kicker.toLocaleUpperCase(), .85, 1.15, 8.5, .3, 12, theme.accent, true, 'l', theme.headingFont)
    text(slide.title, .85, 1.75, 10.9, 1.7, titleSize(slide.title, true), theme.primary, true, 'l', theme.headingFont)
    if (slide.subtitle) text(slide.subtitle, .88, 3.6, 9.5, .8, bodySize(slide.subtitle, 20), theme.muted)
    if (slide.body) text(slide.body, .88, 4.5, 9.8, 1, bodySize(slide.body, 17), theme.muted)
    rect(.88, 6.05, 1.75, .06, theme.accent)
  } else {
    if (slide.kicker) text(slide.kicker.toLocaleUpperCase(), .72, .42, 9, .25, 10, theme.accent, true, 'l', theme.headingFont)
    text(slide.title, .72, slide.kicker ? .75 : .55, 11.4, .7, titleSize(slide.title), theme.primary, true, 'l', theme.headingFont)
    if (slide.subtitle) text(slide.subtitle, .75, 1.32, 10.8, .45, bodySize(slide.subtitle, 14), theme.muted)

    if (slide.type === 'statement') {
      text(slide.body || slide.subtitle || slide.title, .85, 2.1, 10.9, 3.7, titleSize(slide.body || slide.title, true) - 3, theme.primary, true, 'l', theme.headingFont)
      rect(.86, 6.1, 2.1, .06, theme.accent)
    } else if (slide.type === 'bullets') {
      const bullets = slide.bullets ?? []
      const hasAside = Boolean(slide.body)
      const width = hasAside ? 7.5 : 11.2
      bullets.forEach((item, bulletIndex) => {
        rect(.82, 2.02 + bulletIndex * .58, .11, .11, theme.accent, { radius: true })
        text(item, 1.05, 1.86 + bulletIndex * .58, width, .48, bodySize(item, 18), theme.text)
      })
      if (slide.body) {
        rect(9.15, 1.9, 3.25, 3.9, theme.primary, { radius: rounded })
        text(slide.body, 9.48, 2.18, 2.6, 3.3, bodySize(slide.body, 16), theme.surface)
      }
    } else if (slide.type === 'cards') {
      const cards = slide.cards ?? []
      const columns = cards.length === 2 || cards.length === 4 ? 2 : 3
      const rows = Math.ceil(cards.length / columns)
      const gap = .22
      const cardW = (11.9 - gap * (columns - 1)) / columns
      const cardH = Math.min(2.1, (4.9 - gap * (rows - 1)) / rows)
      cards.forEach((card, cardIndex) => {
        const column = cardIndex % columns
        const row = Math.floor(cardIndex / columns)
        const x = .72 + column * (cardW + gap)
        const y = 1.85 + row * (cardH + gap)
        rect(x, y, cardW, cardH, theme.surface, { radius: rounded, line: theme.primary })
        text(card.label || String(cardIndex + 1).padStart(2, '0'), x + .22, y + .18, cardW - .44, .22, 10, theme.accent, true, 'l', theme.headingFont)
        text(card.title, x + .22, y + .52, cardW - .44, .45, bodySize(card.title, 18), theme.primary, true, 'l', theme.headingFont)
        if (card.body) text(card.body, x + .22, y + 1.03, cardW - .44, cardH - 1.18, bodySize(card.body, 13), theme.muted)
      })
    } else if (slide.type === 'comparison') {
      ;(slide.columns ?? []).forEach((column, columnIndex) => {
        const x = .72 + columnIndex * 6.08
        rect(x, 1.86, 5.75, 4.75, theme.surface, { radius: rounded, line: columnIndex ? theme.accent : theme.primary })
        rect(x, 1.86, 5.75, .12, columnIndex ? theme.accent : theme.primary)
        text(column.title, x + .32, 2.18, 5.1, .45, 21, theme.primary, true, 'l', theme.headingFont)
        column.items.forEach((item, itemIndex) => {
          rect(x + .33, 2.99 + itemIndex * .5, .1, .1, columnIndex ? theme.accent : theme.primary, { radius: true })
          text(item, x + .55, 2.82 + itemIndex * .5, 4.7, .42, bodySize(item, 15), theme.text)
        })
      })
    } else if (slide.type === 'process' || slide.type === 'timeline') {
      const steps = slide.steps ?? []
      const stepW = 11.8 / Math.max(1, steps.length)
      rect(1.08, 2.35, 10.9, .03, theme.muted, { transparency: 70 })
      steps.forEach((step, stepIndex) => {
        const x = .75 + stepIndex * stepW
        const fill = slide.type === 'timeline' && stepIndex % 2 ? theme.primary : theme.accent
        rect(x + .2, 2.03, .58, .58, fill, { radius: true })
        text(String(stepIndex + 1), x + .2, 2.03, .58, .58, 14, fill === theme.primary ? theme.surface : theme.primary, true, 'ctr', theme.headingFont)
        text(step.title, x, 2.88, stepW - .18, .7, bodySize(step.title, 16), theme.primary, true, 'l', theme.headingFont)
        if (step.body) text(step.body, x, 3.62, stepW - .18, 1.55, bodySize(step.body, 12), theme.muted)
      })
    } else if (slide.type === 'metrics') {
      const metrics = slide.metrics ?? []
      const columns = Math.min(3, metrics.length)
      const rows = Math.ceil(metrics.length / columns)
      const w = 11.9 / columns - .2
      const h = 4.7 / rows - .2
      metrics.forEach((metric, metricIndex) => {
        const column = metricIndex % columns
        const row = Math.floor(metricIndex / columns)
        const x = .72 + column * (w + .28)
        const y = 1.86 + row * (h + .25)
        rect(x, y, w, h, theme.surface, { radius: rounded })
        rect(x, y + h - .08, w, .08, theme.accent)
        text(metric.value, x + .28, y + .32, w - .56, .8, bodySize(metric.value, 34), theme.primary, true, 'l', theme.headingFont)
        text(metric.label, x + .28, y + 1.2, w - .56, .45, 16, theme.primary, true, 'l', theme.headingFont)
        if (metric.note) text(metric.note, x + .28, y + 1.75, w - .56, h - 2, bodySize(metric.note, 12), theme.muted)
      })
    } else if (slide.type === 'table' && slide.table) {
      const headers = slide.table.headers
      const rows = slide.table.rows
      const x = .72
      const y = 1.85
      const tableW = 11.9
      const cellW = tableW / headers.length
      const rowH = Math.min(.58, 4.8 / (rows.length + 1))
      headers.forEach((cell, cellIndex) => {
        rect(x + cellIndex * cellW, y, cellW, rowH, theme.primary)
        text(cell, x + cellIndex * cellW + .08, y + .05, cellW - .16, rowH - .1, 13, theme.surface, true, 'l', theme.headingFont)
      })
      rows.forEach((row, rowIndex) => row.forEach((cell, cellIndex) => {
        const fill = rowIndex % 2 ? theme.background : theme.surface
        rect(x + cellIndex * cellW, y + (rowIndex + 1) * rowH, cellW, rowH, fill, { line: theme.muted })
        text(cell, x + cellIndex * cellW + .08, y + (rowIndex + 1) * rowH + .05, cellW - .16, rowH - .1, bodySize(cell, 11), theme.text)
      }))
    } else if (slide.type === 'quote') {
      text('“', .65, 1.55, 1.2, 1.2, 72, theme.accent, true, 'l', theme.headingFont)
      text(slide.quote ?? '', 1.55, 2.05, 10.2, 3.1, titleSize(slide.quote ?? '', true) - 7, theme.primary, true, 'l', theme.headingFont)
      if (slide.attribution) text(`— ${slide.attribution}`, 1.6, 5.45, 8, .4, 14, theme.muted)
    }
  }
  text(slide.footer ?? '', .72, 7.08, 8.8, .18, 8, theme.muted)
  text(`${index + 1} / ${total}`, 11.75, 7.08, .85, .18, 8, theme.muted, false, 'r')
  return pptxSlide(shapes)
}

function pptxSlide(shapes: string[]): string {
  return `${XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function pptxContentTypes(slideCount: number): string {
  const slideTypes = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideTypes}</Types>`
}

function pptxPresentation(slideCount: number): string {
  const ids = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  return `${XML}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
}

function pptxPresentationRels(slideCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}</Relationships>`
}

function pptxCore(title: string): string {
  const now = new Date().toISOString()
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>AI霖子</dc:creator><cp:lastModifiedBy>AI霖子</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
}

function pptxTheme(theme: PresentationTheme): string {
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${escapeXml(theme.name || 'AI霖子演示')}" ><a:themeElements><a:clrScheme name="演示主题"><a:dk1><a:srgbClr val="${theme.text}"/></a:dk1><a:lt1><a:srgbClr val="${theme.surface}"/></a:lt1><a:dk2><a:srgbClr val="${theme.primary}"/></a:dk2><a:lt2><a:srgbClr val="${theme.background}"/></a:lt2><a:accent1><a:srgbClr val="${theme.primary}"/></a:accent1><a:accent2><a:srgbClr val="${theme.accent}"/></a:accent2><a:accent3><a:srgbClr val="12B76A"/></a:accent3><a:accent4><a:srgbClr val="7F56D9"/></a:accent4><a:accent5><a:srgbClr val="06AED4"/></a:accent5><a:accent6><a:srgbClr val="F04438"/></a:accent6><a:hlink><a:srgbClr val="${theme.primary}"/></a:hlink><a:folHlink><a:srgbClr val="${theme.accent}"/></a:folHlink></a:clrScheme><a:fontScheme name="演示字体"><a:majorFont><a:latin typeface="${escapeXml(theme.headingFont)}"/><a:ea typeface="${escapeXml(theme.headingFont)}"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="${escapeXml(theme.bodyFont)}"/><a:ea typeface="${escapeXml(theme.bodyFont)}"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="演示版式"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
}

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
const SLIDE_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const LAYOUT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
const MASTER_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const LAYOUT = `${XML}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
const MASTER = `${XML}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`

async function presentationPptx(operation: CreatePresentationOperation): Promise<ArrayBuffer> {
  const slides = operation.slides.map((slide, index) => renderPptxSlide(slide, index, operation.slides.length, operation.theme))
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(pptxContentTypes(slides.length)),
    '_rels/.rels': strToU8(ROOT_RELS),
    'docProps/app.xml': strToU8(`${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>AI霖子</Application><PresentationFormat>宽屏</PresentationFormat><Slides>${slides.length}</Slides><Company>AI霖子</Company><AppVersion>1.0</AppVersion></Properties>`),
    'docProps/core.xml': strToU8(pptxCore(operation.title)),
    'ppt/presentation.xml': strToU8(pptxPresentation(slides.length)),
    'ppt/_rels/presentation.xml.rels': strToU8(pptxPresentationRels(slides.length)),
    'ppt/theme/theme1.xml': strToU8(pptxTheme(operation.theme)),
    'ppt/slideMasters/slideMaster1.xml': strToU8(MASTER),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(MASTER_RELS),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(LAYOUT),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(LAYOUT_RELS),
  }
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide)
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(SLIDE_RELS)
  })
  const archive = zipSync(files, { level: 6 })
  return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
}

function wrapCanvasText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of value.replace(/\r/g, '').split('\n')) {
    let line = ''
    for (const character of Array.from(paragraph)) {
      const next = line + character
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line)
        line = character
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PDF 幻灯片渲染失败')), 'image/png'))
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: string): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
  context.fillStyle = fill
  context.fill()
}

async function presentationPdf(operation: CreatePresentationOperation): Promise<ArrayBuffer> {
  if (typeof window === 'undefined' || !window.document) throw new Error('PDF 只能在 Obsidian 桌面环境中生成')
  const pdf = await PDFDocument.create()
  const width = 1600
  const height = 900
  const theme = operation.theme
  const headingFont = `"${safeFont(theme.headingFont)}", "Microsoft YaHei", sans-serif`
  const bodyFont = `"${safeFont(theme.bodyFont)}", "Microsoft YaHei", sans-serif`
  for (let index = 0; index < operation.slides.length; index++) {
    const slide = operation.slides[index]
    const canvas = window.document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前 Obsidian 无法创建 PDF 画布')
    context.fillStyle = cssColor(theme.background)
    context.fillRect(0, 0, width, height)
    context.fillStyle = cssColor(theme.accent)
    context.globalAlpha = .08
    context.beginPath()
    context.arc(1500, 70, 260, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 1

    const drawText = (value: string, x: number, y: number, maxWidth: number, size: number, color: string, bold = false, lineHeight = 1.3, maxLines = 10) => {
      context.font = `${bold ? 700 : 400} ${size}px ${bold ? headingFont : bodyFont}`
      context.fillStyle = cssColor(color)
      const lines = wrapCanvasText(context, value, maxWidth).slice(0, maxLines)
      lines.forEach((line, lineIndex) => context.fillText(line, x, y + lineIndex * size * lineHeight))
      return lines.length * size * lineHeight
    }

    if (slide.type === 'cover' || slide.type === 'section' || slide.type === 'closing') {
      if (slide.kicker) drawText(slide.kicker.toLocaleUpperCase(), 120, 230, 1000, 23, theme.accent, true)
      drawText(slide.title, 120, 330, 1240, slide.title.length > 28 ? 64 : 82, theme.primary, true, 1.15, 3)
      if (slide.subtitle) drawText(slide.subtitle, 125, 560, 1100, 31, theme.muted, false, 1.45, 3)
      context.fillStyle = cssColor(theme.accent)
      context.fillRect(125, 750, 220, 7)
    } else {
      if (slide.kicker) drawText(slide.kicker.toLocaleUpperCase(), 92, 74, 1100, 18, theme.accent, true)
      drawText(slide.title, 92, 145, 1320, slide.title.length > 34 ? 42 : 52, theme.primary, true, 1.12, 2)
      if (slide.subtitle) drawText(slide.subtitle, 96, 220, 1200, 24, theme.muted, false, 1.3, 2)

      const top = slide.subtitle ? 305 : 260
      if (slide.type === 'statement') {
        drawText(slide.body || slide.subtitle || slide.title, 110, top + 80, 1250, 66, theme.primary, true, 1.22, 5)
      } else if (slide.type === 'bullets') {
        ;(slide.bullets ?? []).forEach((item, bulletIndex) => {
          context.fillStyle = cssColor(theme.accent)
          context.beginPath(); context.arc(118, top + 35 + bulletIndex * 72, 7, 0, Math.PI * 2); context.fill()
          drawText(item, 150, top + 44 + bulletIndex * 72, slide.body ? 830 : 1250, 29, theme.text, false, 1.25, 2)
        })
        if (slide.body) {
          roundRect(context, 1090, top, 390, 430, theme.shape === 'rounded' ? 24 : 2, cssColor(theme.primary))
          drawText(slide.body, 1130, top + 60, 310, 26, theme.surface, false, 1.42, 10)
        }
      } else if (slide.type === 'cards') {
        const cards = slide.cards ?? []
        const columns = cards.length === 2 || cards.length === 4 ? 2 : 3
        const cardWidth = columns === 2 ? 650 : 420
        cards.forEach((card, cardIndex) => {
          const column = cardIndex % columns
          const row = Math.floor(cardIndex / columns)
          const x = 92 + column * (cardWidth + 28)
          const y = top + row * 245
          roundRect(context, x, y, cardWidth, 215, theme.shape === 'rounded' ? 22 : 2, cssColor(theme.surface))
          drawText(card.label || String(cardIndex + 1).padStart(2, '0'), x + 28, y + 38, cardWidth - 56, 18, theme.accent, true)
          drawText(card.title, x + 28, y + 92, cardWidth - 56, 30, theme.primary, true, 1.2, 2)
          if (card.body) drawText(card.body, x + 28, y + 143, cardWidth - 56, 21, theme.muted, false, 1.35, 3)
        })
      } else if (slide.type === 'comparison') {
        ;(slide.columns ?? []).forEach((column, columnIndex) => {
          const x = 92 + columnIndex * 725
          roundRect(context, x, top, 680, 470, theme.shape === 'rounded' ? 22 : 2, cssColor(theme.surface))
          context.fillStyle = cssColor(columnIndex ? theme.accent : theme.primary)
          context.fillRect(x, top, 680, 9)
          drawText(column.title, x + 38, top + 68, 600, 34, theme.primary, true)
          column.items.forEach((item, itemIndex) => drawText(`•  ${item}`, x + 40, top + 132 + itemIndex * 47, 595, 23, theme.text, false, 1.25, 2))
        })
      } else if (slide.type === 'process' || slide.type === 'timeline') {
        const steps = slide.steps ?? []
        const stepWidth = 1370 / steps.length
        context.strokeStyle = cssColor(theme.muted); context.globalAlpha = .25; context.lineWidth = 3; context.beginPath(); context.moveTo(130, top + 70); context.lineTo(1470, top + 70); context.stroke(); context.globalAlpha = 1
        steps.forEach((step, stepIndex) => {
          const x = 110 + stepIndex * stepWidth
          context.fillStyle = cssColor(slide.type === 'timeline' && stepIndex % 2 ? theme.primary : theme.accent)
          context.beginPath(); context.arc(x + 32, top + 70, 31, 0, Math.PI * 2); context.fill()
          drawText(String(stepIndex + 1), x + 21, top + 80, 30, 24, slide.type === 'timeline' && stepIndex % 2 ? theme.surface : theme.primary, true)
          drawText(step.title, x, top + 160, stepWidth - 25, 26, theme.primary, true, 1.2, 3)
          if (step.body) drawText(step.body, x, top + 245, stepWidth - 25, 20, theme.muted, false, 1.35, 6)
        })
      } else if (slide.type === 'metrics') {
        const metrics = slide.metrics ?? []
        const columns = Math.min(3, metrics.length)
        const cardWidth = 1370 / columns - 25
        metrics.forEach((metric, metricIndex) => {
          const column = metricIndex % columns
          const row = Math.floor(metricIndex / columns)
          const x = 92 + column * (cardWidth + 28)
          const y = top + row * 250
          roundRect(context, x, y, cardWidth, 220, theme.shape === 'rounded' ? 22 : 2, cssColor(theme.surface))
          drawText(metric.value, x + 30, y + 78, cardWidth - 60, 58, theme.primary, true, 1.1, 2)
          drawText(metric.label, x + 30, y + 132, cardWidth - 60, 25, theme.primary, true)
          if (metric.note) drawText(metric.note, x + 30, y + 178, cardWidth - 60, 18, theme.muted, false, 1.3, 2)
        })
      } else if (slide.type === 'table' && slide.table) {
        const cellWidth = 1410 / slide.table.headers.length
        const rowHeight = Math.min(58, 490 / (slide.table.rows.length + 1))
        slide.table.headers.forEach((cell, cellIndex) => {
          context.fillStyle = cssColor(theme.primary); context.fillRect(92 + cellIndex * cellWidth, top, cellWidth, rowHeight)
          drawText(cell, 105 + cellIndex * cellWidth, top + rowHeight * .65, cellWidth - 26, 20, theme.surface, true, 1.15, 2)
        })
        slide.table.rows.forEach((row, rowIndex) => row.forEach((cell, cellIndex) => {
          context.fillStyle = cssColor(rowIndex % 2 ? theme.background : theme.surface); context.fillRect(92 + cellIndex * cellWidth, top + (rowIndex + 1) * rowHeight, cellWidth, rowHeight)
          drawText(cell, 105 + cellIndex * cellWidth, top + (rowIndex + 1.62) * rowHeight, cellWidth - 26, 18, theme.text, false, 1.15, 2)
        }))
      } else if (slide.type === 'quote') {
        drawText('“', 70, top + 90, 100, 110, theme.accent, true)
        drawText(slide.quote ?? '', 170, top + 100, 1220, 58, theme.primary, true, 1.25, 6)
        if (slide.attribution) drawText(`— ${slide.attribution}`, 180, top + 450, 800, 23, theme.muted)
      }
    }
    drawText(slide.footer ?? '', 92, 855, 1000, 15, theme.muted)
    drawText(`${index + 1} / ${operation.slides.length}`, 1400, 855, 110, 15, theme.muted)
    const png = await canvasBlob(canvas)
    const image = await pdf.embedPng(await png.arrayBuffer())
    const page = pdf.addPage([width, height])
    page.drawImage(image, { x: 0, y: 0, width, height })
  }
  pdf.setTitle(operation.title)
  pdf.setAuthor('AI霖子')
  pdf.setCreator('AI霖子 Obsidian 插件')
  const bytes = await pdf.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export async function renderPresentation(operation: CreatePresentationOperation): Promise<RenderedPresentationFile[]> {
  const files: RenderedPresentationFile[] = []
  for (const format of operation.formats) {
    if (format === 'html') {
      files.push({ format, binary: false, data: presentationHtml(operation), mimeType: 'text/html' })
    } else if (format === 'pptx') {
      files.push({
        format,
        binary: true,
        data: await presentationPptx(operation),
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      })
    } else {
      files.push({ format, binary: true, data: await presentationPdf(operation), mimeType: 'application/pdf' })
    }
  }
  return files
}

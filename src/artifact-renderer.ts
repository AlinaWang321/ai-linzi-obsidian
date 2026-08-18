import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { PDFDocument } from 'pdf-lib'
import { strToU8, zipSync } from 'fflate'
import {
  parseArtifactMarkdown,
  resolveArtifactLayout,
  type ArtifactBlock,
  type ArtifactDocument,
  type CreateArtifactOperation,
} from './artifact-renderer-core'

export interface RenderedArtifact {
  binary: boolean
  data: string | ArrayBuffer
  mimeType: string
}

const BRAND = {
  orange: 'F39800',
  blue: '0057FF',
  ink: '172033',
  muted: '667085',
  pale: 'FFF7EA',
  line: 'E7EAF0',
  white: 'FFFFFF',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function artifactHtml(document: ArtifactDocument, theme: 'brand' | 'clean'): string {
  const blocks = document.blocks.map((block) => {
    if (block.type === 'heading') {
      const level = Math.min(4, Math.max(2, block.level + 1))
      return `<h${level}>${escapeHtml(block.text)}</h${level}>`
    }
    if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`
    if (block.type === 'quote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`
    if (block.type === 'code') return `<pre><code>${escapeHtml(block.text)}</code></pre>`
    if (block.type === 'rule') return '<hr>'
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`
    }
    const head = `<thead><tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
    const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
    return `<div class="table-wrap"><table>${head}${body}</table></div>`
  }).join('\n')
  const accent = theme === 'clean' ? '#1f2937' : `#${BRAND.orange}`
  const blue = theme === 'clean' ? '#475569' : `#${BRAND.blue}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{--accent:${accent};--blue:${blue};--ink:#172033;--muted:#667085;--line:#e7eaf0;--paper:#fff}
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:var(--ink);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.75}
    main{width:min(920px,calc(100% - 32px));margin:40px auto;padding:64px 72px;background:var(--paper);border-radius:18px;box-shadow:0 16px 50px rgba(23,32,51,.08)}
    header{border-left:8px solid var(--accent);padding:4px 0 4px 24px;margin-bottom:44px}h1{font-size:38px;line-height:1.25;margin:0}header p{margin:10px 0 0;color:var(--muted)}
    h2,h3,h4{line-height:1.4;margin:2em 0 .65em}h2{font-size:27px;color:var(--blue);border-bottom:1px solid var(--line);padding-bottom:.35em}h3{font-size:21px}h4{font-size:18px}
    p,li{font-size:17px}p{margin:.8em 0}li{margin:.35em 0}blockquote{margin:1.4em 0;padding:16px 20px;border-left:5px solid var(--accent);background:#fff7ea;border-radius:8px;color:#3d4657}
    pre{overflow:auto;padding:18px 20px;background:#111827;color:#f9fafb;border-radius:10px;line-height:1.55}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
    .table-wrap{overflow-x:auto;margin:1.5em 0}table{width:100%;border-collapse:collapse;font-size:15px}th,td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}th{background:#f7f8fa;color:var(--blue)}
    footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
    @media(max-width:680px){main{margin:0;width:100%;padding:36px 24px;border-radius:0}h1{font-size:30px}}
    @media print{body{background:#fff}main{width:100%;margin:0;padding:18mm;box-shadow:none}footer{break-inside:avoid}}
  </style>
</head>
<body><main><header><h1>${escapeHtml(document.title)}</h1><p>AI霖子 · 智能生成文档</p></header>${blocks}<footer>由 AI霖子生成 · 请在使用前核对关键信息</footer></main></body>
</html>`
}

/** `- [ ] 文案` / `- [x] 文案` → 可勾选任务；其余按普通条目。 */
function taskItem(raw: string): { done: boolean; text: string } | null {
  const match = /^\[([ xX])\]\s*(.*)$/.exec(raw.trim())
  if (!match) return null
  return { done: match[1].toLowerCase() === 'x', text: match[2].trim() }
}

/** 按关键词给分区/卡片配一个语义色，纯展示，识别不出就用中性色。 */
function toneOf(text: string): 'urgent' | 'warn' | 'calm' | 'muted' | 'none' {
  if (/优先级一|必须|今天必须|紧急|立即|高优/.test(text)) return 'urgent'
  if (/优先级二|建议|完成一项|中优/.test(text)) return 'warn'
  if (/优先级三|有余力|可选|低优|以后/.test(text)) return 'calm'
  if (/不做|暂时不|不要|避免|禁止/.test(text)) return 'muted'
  return 'none'
}

function dashboardBlockHtml(block: ArtifactBlock): string {
  if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`
  if (block.type === 'quote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`
  if (block.type === 'code') return `<pre><code>${escapeHtml(block.text)}</code></pre>`
  if (block.type === 'rule') return '<hr>'
  if (block.type === 'heading') return `<h4>${escapeHtml(block.text)}</h4>`
  if (block.type === 'list') {
    const tasks = block.items.map((item) => taskItem(item))
    if (tasks.every((task) => task !== null) && tasks.length > 0) {
      const rows = tasks.map((task) => {
        const item = task as { done: boolean; text: string }
        return `<li class="task"><label><input type="checkbox" class="tick"${item.done ? ' checked' : ''}><span>${escapeHtml(item.text)}</span></label></li>`
      }).join('')
      return `<ul class="tasks">${rows}</ul>`
    }
    const tag = block.ordered ? 'ol' : 'ul'
    return `<${tag}>${block.items.map((item) => {
      const task = taskItem(item)
      if (!task) return `<li>${escapeHtml(item)}</li>`
      return `<li class="task"><label><input type="checkbox" class="tick"${task.done ? ' checked' : ''}><span>${escapeHtml(task.text)}</span></label></li>`
    }).join('')}</${tag}>`
  }
  const head = `<thead><tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
  const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
  return `<div class="table-wrap"><table>${head}${body}</table></div>`
}

/**
 * 交互看板版式（0.7.54，Alina 2026-08-19 反馈「文档式太丑，要能点标签分类、有交互感」）：
 * 顶层小标题切成标签页，下层小标题成卡片，`- [ ]` 成真实可勾选任务（进度实时统计、
 * 勾选状态存 localStorage），支持深色模式与搜索过滤。整页自包含、零外部依赖、可离线打开。
 */
function artifactDashboardHtml(document: ArtifactDocument, theme: 'brand' | 'clean'): string {
  const headings = document.blocks.filter(
    (block): block is Extract<ArtifactBlock, { type: 'heading' }> => block.type === 'heading',
  )
  const tabLevel = headings.length > 0 ? Math.min(...headings.map((block) => block.level)) : 0
  const intro: ArtifactBlock[] = []
  const sections: { title: string; blocks: ArtifactBlock[] }[] = []
  for (const block of document.blocks) {
    if (block.type === 'heading' && block.level === tabLevel && tabLevel > 0) {
      sections.push({ title: block.text, blocks: [] })
      continue
    }
    if (sections.length === 0) intro.push(block)
    else sections[sections.length - 1].blocks.push(block)
  }
  if (sections.length === 0) sections.push({ title: '全部内容', blocks: intro.splice(0, intro.length) })

  // 卡片切分：分区内的下层小标题各起一张卡；标题前的内容并入首卡。
  const renderSection = (section: { title: string; blocks: ArtifactBlock[] }, index: number): string => {
    const cards: { title: string | null; blocks: ArtifactBlock[] }[] = []
    for (const block of section.blocks) {
      if (block.type === 'heading' && block.level > tabLevel) {
        cards.push({ title: block.text, blocks: [] })
        continue
      }
      if (cards.length === 0) cards.push({ title: null, blocks: [] })
      cards[cards.length - 1].blocks.push(block)
    }
    if (cards.length === 0) cards.push({ title: null, blocks: [] })
    const body = cards.map((card) => {
      const tone = toneOf(`${section.title} ${card.title ?? ''}`)
      const head = card.title
        ? `<div class="card-head"><h3>${escapeHtml(card.title)}</h3><button class="fold" type="button" aria-label="折叠">−</button></div>`
        : ''
      const inner = card.blocks.map((block) => dashboardBlockHtml(block)).join('\n')
      if (!head && !inner.trim()) return ''
      return `<article class="card tone-${tone}">${head}<div class="card-body">${inner}</div></article>`
    }).filter(Boolean).join('\n')
    return `<section class="panel${index === 0 ? ' active' : ''}" data-panel="${index}">${body}</section>`
  }

  const tabs = sections.map((section, index) =>
    `<button class="tab${index === 0 ? ' active' : ''} tone-${toneOf(section.title)}" type="button" data-tab="${index}">${escapeHtml(section.title)}<span class="tab-count" data-tab-count="${index}"></span></button>`,
  ).join('')
  const panels = sections.map((section, index) => renderSection(section, index)).join('\n')
  const introHtml = intro.length > 0
    ? `<div class="intro">${intro.map((block) => dashboardBlockHtml(block)).join('\n')}</div>`
    : ''
  const accent = theme === 'clean' ? '#1f2937' : `#${BRAND.orange}`
  const blue = theme === 'clean' ? '#475569' : `#${BRAND.blue}`
  const storageKey = `ai-linzi-board:${document.title}`
  const script = [
    '(function(){',
    `  var KEY=${JSON.stringify(storageKey)};`,
    '  var ticks=[].slice.call(document.querySelectorAll(".tick"));',
    '  ticks.forEach(function(box,i){box.dataset.idx=String(i)});',
    '  var saved={};',
    '  try{saved=JSON.parse(localStorage.getItem(KEY)||"{}")}catch(e){saved={}}',
    '  ticks.forEach(function(box){var v=saved[box.dataset.idx];if(typeof v==="boolean")box.checked=v});',
    '  function persist(){',
    '    var out={};ticks.forEach(function(box){out[box.dataset.idx]=box.checked});',
    '    try{localStorage.setItem(KEY,JSON.stringify(out))}catch(e){}',
    '  }',
    '  function paint(){',
    '    var total=ticks.length,done=ticks.filter(function(b){return b.checked}).length;',
    '    var pct=total?Math.round(done/total*100):0;',
    '    var bar=document.getElementById("bar"),num=document.getElementById("num");',
    '    if(bar)bar.style.width=pct+"%";',
    '    if(num)num.textContent=total?done+" / "+total+" 项完成 · "+pct+"%":"本页无勾选任务";',
    '    ticks.forEach(function(b){var li=b.closest("li");if(li)li.classList.toggle("checked",b.checked)});',
    '    [].slice.call(document.querySelectorAll("[data-tab-count]")).forEach(function(el){',
    '      var panel=document.querySelector(\'[data-panel="\'+el.dataset.tabCount+\'"]\');',
    '      if(!panel)return;',
    '      var boxes=[].slice.call(panel.querySelectorAll(".tick"));',
    '      if(boxes.length===0){el.textContent="";return}',
    '      var d=boxes.filter(function(b){return b.checked}).length;',
    '      el.textContent=d+"/"+boxes.length;',
    '    });',
    '  }',
    '  ticks.forEach(function(box){box.addEventListener("change",function(){persist();paint()})});',
    '  [].slice.call(document.querySelectorAll(".tab")).forEach(function(tab){',
    '    tab.addEventListener("click",function(){',
    '      [].slice.call(document.querySelectorAll(".tab")).forEach(function(t){t.classList.remove("active")});',
    '      [].slice.call(document.querySelectorAll(".panel")).forEach(function(p){p.classList.remove("active")});',
    '      tab.classList.add("active");',
    '      var panel=document.querySelector(\'[data-panel="\'+tab.dataset.tab+\'"]\');',
    '      if(panel)panel.classList.add("active");',
    '    });',
    '  });',
    '  [].slice.call(document.querySelectorAll(".fold")).forEach(function(btn){',
    '    btn.addEventListener("click",function(){',
    '      var card=btn.closest(".card");if(!card)return;',
    '      var folded=card.classList.toggle("folded");',
    '      btn.textContent=folded?"+":"−";',
    '    });',
    '  });',
    '  var search=document.getElementById("q");',
    '  if(search){',
    '    search.addEventListener("input",function(){',
    '      var q=search.value.trim().toLowerCase();',
    '      [].slice.call(document.querySelectorAll(".panel")).forEach(function(p){p.classList.add("active")});',
    '      [].slice.call(document.querySelectorAll(".tab")).forEach(function(t){t.classList.toggle("active",!q&&t.dataset.tab==="0")});',
    '      if(!q){',
    '        [].slice.call(document.querySelectorAll(".panel")).forEach(function(p){p.classList.toggle("active",p.dataset.panel==="0")});',
    '        [].slice.call(document.querySelectorAll(".card")).forEach(function(c){c.style.display=""});',
    '        return;',
    '      }',
    '      [].slice.call(document.querySelectorAll(".card")).forEach(function(c){',
    '        c.style.display=c.textContent.toLowerCase().indexOf(q)>=0?"":"none";',
    '      });',
    '    });',
    '  }',
    '  paint();',
    '})();',
  ].join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{--accent:${accent};--blue:${blue};--ink:#172033;--muted:#667085;--line:#e7eaf0;--paper:#fff;--bg:#f4f6f8;--soft:#f8fafc}
    @media(prefers-color-scheme:dark){:root{--ink:#e8ecf4;--muted:#9aa5b8;--line:#2a3446;--paper:#151b26;--bg:#0d1219;--soft:#1b2331}}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.7;-webkit-font-smoothing:antialiased}
    .wrap{width:min(1180px,calc(100% - 32px));margin:28px auto 64px}
    .top{background:var(--paper);border-radius:18px;padding:26px 30px;box-shadow:0 10px 34px rgba(15,23,42,.08);border:1px solid var(--line)}
    .top h1{margin:0;font-size:29px;line-height:1.3;letter-spacing:-.01em}
    .top .sub{margin:8px 0 0;color:var(--muted);font-size:14px}
    .meter{display:flex;align-items:center;gap:14px;margin-top:20px;flex-wrap:wrap}
    .track{flex:1;min-width:220px;height:9px;background:var(--soft);border-radius:99px;overflow:hidden;border:1px solid var(--line)}
    #bar{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--blue));border-radius:99px;transition:width .35s cubic-bezier(.4,0,.2,1)}
    #num{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
    #q{flex:0 1 240px;padding:9px 14px;border-radius:99px;border:1px solid var(--line);background:var(--soft);color:var(--ink);font-size:14px;outline:none}
    #q:focus{border-color:var(--accent)}
    .intro{margin-top:18px;padding-top:16px;border-top:1px dashed var(--line);color:var(--muted);font-size:15px}
    .intro p{margin:.5em 0}.intro blockquote{margin:.6em 0;padding:12px 16px;border-left:4px solid var(--accent);background:var(--soft);border-radius:8px}
    .tabs{display:flex;gap:8px;overflow-x:auto;padding:20px 2px 4px;scrollbar-width:thin}
    .tab{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;padding:9px 17px;border-radius:99px;border:1px solid var(--line);background:var(--paper);color:var(--muted);font-size:14px;font-family:inherit;cursor:pointer;transition:all .18s}
    .tab:hover{color:var(--ink);border-color:var(--accent);transform:translateY(-1px)}
    .tab.active{background:var(--ink);color:var(--paper);border-color:var(--ink);font-weight:600}
    .tab-count{font-size:12px;opacity:.65;font-variant-numeric:tabular-nums}
    .tab.tone-urgent:not(.active){border-left:3px solid #e5484d}.tab.tone-warn:not(.active){border-left:3px solid var(--accent)}
    .tab.tone-calm:not(.active){border-left:3px solid var(--blue)}.tab.tone-muted:not(.active){opacity:.72}
    .panel{display:none;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;margin-top:10px}
    .panel.active{display:grid}
    .card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:0 3px 14px rgba(15,23,42,.05);transition:box-shadow .2s,transform .2s}
    .card:hover{box-shadow:0 10px 26px rgba(15,23,42,.09);transform:translateY(-2px)}
    .card.tone-urgent{border-top:3px solid #e5484d}.card.tone-warn{border-top:3px solid var(--accent)}
    .card.tone-calm{border-top:3px solid var(--blue)}.card.tone-muted{background:var(--soft)}
    .card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
    .card h3{margin:0;font-size:17px;line-height:1.45}
    .card h4{margin:1.1em 0 .4em;font-size:15px;color:var(--blue)}
    .fold{border:0;background:var(--soft);color:var(--muted);width:26px;height:26px;border-radius:8px;cursor:pointer;font-size:15px;line-height:1;flex:0 0 auto;font-family:inherit}
    .fold:hover{background:var(--accent);color:#fff}
    .card.folded .card-body{display:none}
    .card p{margin:.55em 0;font-size:14.5px}
    .card ul,.card ol{margin:.5em 0;padding-left:20px}.card li{margin:.3em 0;font-size:14.5px}
    .card ul.tasks{list-style:none;padding-left:0}
    li.task{display:block;margin:.3em 0}
    li.task label{display:flex;align-items:flex-start;gap:9px;cursor:pointer;padding:5px 8px;border-radius:8px;transition:background .15s}
    li.task label:hover{background:var(--soft)}
    li.task input{margin:4px 0 0;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex:0 0 auto}
    li.task.checked span{text-decoration:line-through;color:var(--muted)}
    .card blockquote{margin:.7em 0;padding:11px 15px;border-left:4px solid var(--accent);background:var(--soft);border-radius:8px;font-size:14px;color:var(--muted)}
    .card pre{overflow:auto;padding:13px 15px;background:#111827;color:#f9fafb;border-radius:9px;font-size:13px}
    .table-wrap{overflow-x:auto;margin:.8em 0}
    table{width:100%;border-collapse:collapse;font-size:13.5px}
    th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
    th{background:var(--soft);color:var(--blue);font-weight:600}
    hr{border:0;border-top:1px solid var(--line);margin:1.1em 0}
    footer{margin-top:30px;color:var(--muted);font-size:12.5px;text-align:center}
    @media(max-width:640px){.wrap{width:calc(100% - 20px);margin:14px auto 40px}.top{padding:20px}.top h1{font-size:23px}.panel.active{grid-template-columns:1fr}}
    @media print{body{background:#fff}.tabs,#q,.fold{display:none}.panel{display:grid!important}.card{break-inside:avoid;box-shadow:none}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>${escapeHtml(document.title)}</h1>
      <p class="sub">AI霖子 · 交互看板 · 勾选进度会保存在本机浏览器</p>
      <div class="meter">
        <div class="track"><div id="bar"></div></div>
        <span id="num"></span>
        <input id="q" type="search" placeholder="搜索卡片内容…" autocomplete="off">
      </div>
      ${introHtml}
    </div>
    <nav class="tabs">${tabs}</nav>
    ${panels}
    <footer>由 AI霖子生成 · 请在使用前核对关键信息</footer>
  </div>
  <script>${script}</script>
</body>
</html>`
}

function docxTable(block: Extract<ArtifactBlock, { type: 'table' }>): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: BRAND.line }
  const row = (cells: string[], header = false) => new TableRow({
    children: cells.map((cell) => new TableCell({
      shading: header ? { type: ShadingType.CLEAR, fill: 'F3F6FA' } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
      children: [new Paragraph({
        children: [new TextRun({ text: cell, bold: header, color: header ? BRAND.blue : BRAND.ink, font: 'Hiragino Sans GB' })],
      })],
    })),
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [row(block.headers, true), ...block.rows.map((cells) => row(cells))],
  })
}

async function artifactDocx(document: ArtifactDocument): Promise<ArrayBuffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      text: document.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 460 },
      children: [new TextRun({ text: 'AI霖子 · 智能生成文档', color: BRAND.muted, size: 20, font: 'Hiragino Sans GB' })],
    }),
  ]
  for (const block of document.blocks) {
    if (block.type === 'heading') {
      const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]
      children.push(new Paragraph({
        text: block.text,
        heading: headings[Math.max(0, Math.min(3, block.level - 1))],
        spacing: { before: 260, after: 120 },
      }))
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, font: 'Hiragino Sans GB', size: 22, color: BRAND.ink })],
        spacing: { after: 150, line: 360 },
      }))
    } else if (block.type === 'quote') {
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, italics: true, color: BRAND.muted, font: 'Hiragino Sans GB' })],
        indent: { left: 420 },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: BRAND.orange, space: 10 } },
        spacing: { before: 120, after: 160 },
      }))
    } else if (block.type === 'code') {
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, font: 'Menlo', size: 18, color: BRAND.ink })],
        shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
        spacing: { before: 100, after: 160 },
      }))
    } else if (block.type === 'rule') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BRAND.line, space: 8 } } }))
    } else if (block.type === 'list') {
      block.items.forEach((item, index) => children.push(new Paragraph({
        children: [new TextRun({ text: item, font: 'Hiragino Sans GB', size: 22 })],
        bullet: block.ordered ? undefined : { level: 0 },
        numbering: block.ordered ? { reference: 'artifact-numbering', level: 0, instance: 1 } : undefined,
        spacing: { after: 80, line: 320 },
      })))
    } else {
      children.push(docxTable(block))
    }
  }
  const doc = new Document({
    creator: 'AI霖子',
    title: document.title,
    description: '由 AI霖子 Obsidian 插件生成',
    numbering: {
      config: [{
        reference: 'artifact-numbering',
        levels: [{
          level: 0,
          format: 'decimal',
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    styles: {
      default: { document: { run: { font: 'Hiragino Sans GB', size: 22, color: BRAND.ink } } },
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'AI霖子  ·  ', color: BRAND.muted, size: 18 }),
              new TextRun({ children: [PageNumber.CURRENT], color: BRAND.muted, size: 18 }),
            ],
          })],
        }),
      },
    }],
  })
  const blob = await Packer.toBlob(doc)
  return blob.arrayBuffer()
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
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
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PDF 页面渲染失败')), 'image/png')
  })
}

async function artifactPdf(artifactDocument: ArtifactDocument, theme: 'brand' | 'clean'): Promise<ArrayBuffer> {
  if (typeof window === 'undefined' || !window.document) {
    throw new Error('PDF 只能在 Obsidian 桌面环境中生成')
  }
  const pageWidth = 1240
  const pageHeight = 1754
  const margin = 104
  const bottom = pageHeight - 104
  const accent = theme === 'clean' ? '#1f2937' : `#${BRAND.orange}`
  const pages: HTMLCanvasElement[] = []
  let canvas: HTMLCanvasElement
  let context!: CanvasRenderingContext2D
  let y = 0

  const newPage = (first = false) => {
    canvas = window.document.createElement('canvas')
    canvas.width = pageWidth
    canvas.height = pageHeight
    const next = canvas.getContext('2d')
    if (!next) throw new Error('当前 Obsidian 无法创建 PDF 画布')
    context = next
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, pageWidth, pageHeight)
    context.fillStyle = accent
    context.fillRect(0, 0, 18, pageHeight)
    context.fillStyle = '#98A2B3'
    context.font = '24px "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillText(`AI霖子  ·  ${pages.length + 1}`, margin, pageHeight - 52)
    y = first ? 170 : 110
    pages.push(canvas)
  }

  const ensure = (height: number) => {
    if (y + height > bottom) newPage()
  }
  const drawText = (text: string, options: { size: number; color?: string; bold?: boolean; indent?: number; gap?: number }) => {
    const indent = options.indent ?? 0
    context.font = `${options.bold ? '700' : '400'} ${options.size}px "PingFang SC", "Microsoft YaHei", sans-serif`
    const lineHeight = Math.round(options.size * 1.58)
    const lines = wrapCanvasText(context, text, pageWidth - margin * 2 - indent)
    for (const line of lines) {
      ensure(lineHeight)
      context.fillStyle = options.color ?? `#${BRAND.ink}`
      context.fillText(line, margin + indent, y)
      y += lineHeight
    }
    y += options.gap ?? Math.round(options.size * .55)
  }

  newPage(true)
  context.fillStyle = accent
  context.fillRect(margin, 108, 14, 132)
  drawText(artifactDocument.title, { size: 58, bold: true, indent: 38, gap: 30 })
  drawText('AI霖子 · 智能生成文档', { size: 25, color: `#${BRAND.muted}`, indent: 38, gap: 64 })

  for (const block of artifactDocument.blocks) {
    if (block.type === 'heading') {
      drawText(block.text, { size: block.level <= 2 ? 38 : 31, color: block.level <= 2 ? `#${BRAND.blue}` : `#${BRAND.ink}`, bold: true, gap: 22 })
    } else if (block.type === 'paragraph') {
      drawText(block.text, { size: 28, gap: 20 })
    } else if (block.type === 'quote') {
      ensure(70)
      context.fillStyle = accent
      context.fillRect(margin, y - 30, 8, 56)
      drawText(block.text, { size: 27, color: '#475467', indent: 30, gap: 24 })
    } else if (block.type === 'code') {
      drawText(block.text, { size: 23, color: '#344054', indent: 18, gap: 24 })
    } else if (block.type === 'rule') {
      ensure(42)
      context.strokeStyle = `#${BRAND.line}`
      context.beginPath()
      context.moveTo(margin, y)
      context.lineTo(pageWidth - margin, y)
      context.stroke()
      y += 42
    } else if (block.type === 'list') {
      block.items.forEach((item, index) => drawText(`${block.ordered ? `${index + 1}.` : '•'} ${item}`, { size: 27, indent: 18, gap: 8 }))
      y += 14
    } else {
      const rows = [block.headers, ...block.rows]
      for (const [index, row] of rows.entries()) {
        drawText(`${index === 0 ? '' : '• '}${row.join('  |  ')}`, { size: index === 0 ? 25 : 23, bold: index === 0, color: index === 0 ? `#${BRAND.blue}` : `#${BRAND.ink}`, gap: 8 })
      }
      y += 18
    }
  }

  const pdf = await PDFDocument.create()
  pdf.setTitle(artifactDocument.title)
  pdf.setAuthor('AI霖子')
  pdf.setCreator('AI霖子 Obsidian 插件')
  for (const pageCanvas of pages) {
    const bytes = await (await canvasBlob(pageCanvas)).arrayBuffer()
    const image = await pdf.embedPng(bytes)
    const page = pdf.addPage([595.28, 841.89])
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 })
  }
  return (await pdf.save()).buffer as ArrayBuffer
}

function slideText(block: ArtifactBlock): string[] {
  if (block.type === 'heading') return [`§ ${block.text}`]
  if (block.type === 'paragraph' || block.type === 'quote') return [block.text]
  if (block.type === 'code') return [block.text]
  if (block.type === 'rule') return []
  if (block.type === 'list') return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '•'} ${item}`)
  return [block.headers.join('  |  '), ...block.rows.map((row) => row.join('  |  '))]
}

function pptxPages(document: ArtifactDocument): Array<{ title: string; lines: string[] }> {
  const pages: Array<{ title: string; lines: string[] }> = []
  let current = { title: '核心内容', lines: [] as string[] }
  let chars = 0
  const flush = () => {
    if (current.lines.length > 0) pages.push(current)
    current = { title: '核心内容', lines: [] }
    chars = 0
  }
  for (const block of document.blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      flush()
      current.title = block.text
      continue
    }
    for (const line of slideText(block)) {
      const chunks = line.match(/[\s\S]{1,180}/g) ?? []
      for (const chunk of chunks) {
        if (chars + chunk.length > 520 || current.lines.length >= 10) {
          const continuingTitle = current.title
          flush()
          current.title = `${continuingTitle}（续）`
        }
        current.lines.push(chunk)
        chars += chunk.length
      }
    }
  }
  flush()
  return pages.length > 0 ? pages : [{ title: '核心内容', lines: ['内容已生成，请根据实际情况补充。'] }]
}

async function artifactPptx(document: ArtifactDocument, theme: 'brand' | 'clean'): Promise<ArrayBuffer> {
  const accent = theme === 'clean' ? '1F2937' : BRAND.orange
  const pages = pptxPages(document)
  const slides = [
    pptxSlide([
      pptxRect(2, 0, 0, .18, 7.5, accent),
      pptxRect(3, .18, 0, 13.15, .12, BRAND.blue),
      pptxText(4, document.title, 1, 2.05, 11.2, 1.5, { size: 34, bold: true, color: BRAND.ink }),
      pptxText(5, 'AI霖子 · 智能生成演示文稿', 1.03, 3.78, 8, .45, { size: 15, color: BRAND.muted }),
      pptxRect(6, 1.03, 4.42, 2, .05, accent),
    ]),
    ...pages.map((page, index) => {
      const lineHeight = Math.min(.72, 5.25 / Math.max(1, page.lines.length))
      const shapes = [
        pptxRect(2, 0, 0, .13, 7.5, accent),
        pptxText(3, page.title, .75, .55, 11.6, .65, { size: 25, bold: true, color: BRAND.blue }),
        pptxRect(4, .75, 1.35, 11.75, .012, BRAND.line),
        ...page.lines.map((line, lineIndex) => {
          const isSection = line.startsWith('§ ')
          return pptxText(
            5 + lineIndex,
            isSection ? line.slice(2) : line,
            isSection ? .85 : 1.02,
            1.65 + lineIndex * lineHeight,
            isSection ? 11.45 : 11.1,
            Math.max(.42, lineHeight - .05),
            { size: isSection ? 20 : 17, bold: isSection, color: isSection ? BRAND.ink : '344054' },
          )
        }),
        pptxText(30, `${index + 2} / ${pages.length + 1}`, 11.8, 7.03, .8, .22, { size: 9, color: '98A2B3', align: 'r' }),
      ]
      return pptxSlide(shapes)
    }),
  ]
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(pptxContentTypes(slides.length)),
    '_rels/.rels': strToU8(PPTX_ROOT_RELS),
    'docProps/app.xml': strToU8(pptxApp(slides.length)),
    'docProps/core.xml': strToU8(pptxCore(document.title)),
    'ppt/presentation.xml': strToU8(pptxPresentation(slides.length)),
    'ppt/_rels/presentation.xml.rels': strToU8(pptxPresentationRels(slides.length)),
    'ppt/theme/theme1.xml': strToU8(PPTX_THEME),
    'ppt/slideMasters/slideMaster1.xml': strToU8(PPTX_MASTER),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(PPTX_MASTER_RELS),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(PPTX_LAYOUT),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(PPTX_LAYOUT_RELS),
  }
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide)
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(PPTX_SLIDE_RELS)
  })
  const archive = zipSync(files, { level: 6 })
  return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
}

const PPTX_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const EMU = 914400
const pptxEmu = (value: number) => Math.round(value * EMU)

function pptxRect(id: number, x: number, y: number, width: number, height: number, color: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rectangle ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${pptxEmu(x)}" y="${pptxEmu(y)}"/><a:ext cx="${pptxEmu(width)}" cy="${pptxEmu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
}

function pptxText(
  id: number,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: { size: number; color: string; bold?: boolean; align?: 'l' | 'r' | 'ctr' },
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${pptxEmu(x)}" y="${pptxEmu(y)}"/><a:ext cx="${pptxEmu(width)}" cy="${pptxEmu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr" lIns="0" rIns="0" tIns="0" bIns="0"/><a:lstStyle/><a:p><a:pPr algn="${options.align ?? 'l'}"/><a:r><a:rPr lang="zh-CN" sz="${options.size * 100}"${options.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${options.color}"/></a:solidFill><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/></a:rPr><a:t>${escapeHtml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${options.size * 100}"/></a:p></p:txBody></p:sp>`
}

function pptxSlide(shapes: string[]): string {
  return `${PPTX_XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function pptxContentTypes(slideCount: number): string {
  const slideTypes = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  return `${PPTX_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideTypes}</Types>`
}

function pptxCore(title: string): string {
  const now = new Date().toISOString()
  return `${PPTX_XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeHtml(title)}</dc:title><dc:creator>AI霖子</dc:creator><cp:lastModifiedBy>AI霖子</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
}

function pptxPresentation(slideCount: number): string {
  const ids = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  return `${PPTX_XML}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
}

function pptxPresentationRels(slideCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
  return `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}</Relationships>`
}

const PPTX_ROOT_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
const pptxApp = (slideCount: number) => `${PPTX_XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>AI霖子</Application><PresentationFormat>宽屏</PresentationFormat><Slides>${slideCount}</Slides><Company>AI霖子</Company><AppVersion>1.0</AppVersion></Properties>`
const PPTX_SLIDE_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const PPTX_LAYOUT_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
const PPTX_MASTER_RELS = `${PPTX_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const PPTX_LAYOUT = `${PPTX_XML}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
const PPTX_MASTER = `${PPTX_XML}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
const PPTX_THEME = `${PPTX_XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AI霖子"><a:themeElements><a:clrScheme name="AI霖子"><a:dk1><a:srgbClr val="172033"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="344054"/></a:dk2><a:lt2><a:srgbClr val="F4F6F8"/></a:lt2><a:accent1><a:srgbClr val="0057FF"/></a:accent1><a:accent2><a:srgbClr val="F39800"/></a:accent2><a:accent3><a:srgbClr val="12B76A"/></a:accent3><a:accent4><a:srgbClr val="7F56D9"/></a:accent4><a:accent5><a:srgbClr val="06AED4"/></a:accent5><a:accent6><a:srgbClr val="F04438"/></a:accent6><a:hlink><a:srgbClr val="0057FF"/></a:hlink><a:folHlink><a:srgbClr val="7F56D9"/></a:folHlink></a:clrScheme><a:fontScheme name="AI霖子"><a:majorFont><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="AI霖子"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

export async function renderArtifact(operation: CreateArtifactOperation): Promise<RenderedArtifact> {
  const document = parseArtifactMarkdown(operation.content, operation.title)
  const theme = operation.theme ?? 'brand'
  if (operation.format === 'html') {
    // 看板/日报类内容走交互版式；长文继续文档版式（0.7.54）。
    const data = resolveArtifactLayout(operation) === 'dashboard'
      ? artifactDashboardHtml(document, theme)
      : artifactHtml(document, theme)
    return { binary: false, data, mimeType: 'text/html' }
  }
  if (operation.format === 'docx') {
    return { binary: true, data: await artifactDocx(document), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  }
  if (operation.format === 'pdf') {
    return { binary: true, data: await artifactPdf(document, theme), mimeType: 'application/pdf' }
  }
  return { binary: true, data: await artifactPptx(document, theme), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
}

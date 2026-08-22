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

export interface ArtifactRenderContext {
  /** 仅用于把成品中的“打开 Vault 路径”渲染成可点击的 Obsidian URI。 */
  vaultName?: string
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

function safeVaultNavigationPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  if (!normalized || normalized.length > 240) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null
  // eslint-disable-next-line no-control-regex -- Obsidian URI 绝不能接收控制字符。
  return /[\u0000-\u001f<>"|?*]/u.test(normalized) ? null : normalized
}

function vaultNavigationLink(label: string, path: string, vaultName: string): string {
  const query = `path:"${path.replace(/"/gu, '')}"`
  const href = `obsidian://search?vault=${encodeURIComponent(vaultName)}&query=${encodeURIComponent(query)}`
  return `<a class="vault-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
}

function artifactInlineHtml(value: string, context: ArtifactRenderContext): string {
  const escaped = escapeHtml(value)
  const vaultName = context.vaultName?.trim()
  if (!vaultName) return escaped

  // 模型偶尔会把“导航页”正文写成 <div><a><span>打开 path</span></a></div>。
  // 原始 HTML 绝不能直接放行（会带来脚本/事件属性注入）；只确定性提取其中的
  // “打开/进入/查看 + Vault 相对路径”，丢弃模型标签并重建为受控 Obsidian URI。
  if (/<\/?(?:a|div|nav|span)\b/iu.test(value)) {
    const links: string[] = []
    const seen = new Set<string>()
    for (const match of value.matchAll(/(打开|进入|查看)\s+([^<\r\n]{1,240})/gu)) {
      const path = safeVaultNavigationPath(match[2])
      if (!path || seen.has(path.toLocaleLowerCase())) continue
      seen.add(path.toLocaleLowerCase())
      links.push(vaultNavigationLink(`${match[1]} ${path}`, path, vaultName))
    }
    if (links.length > 0) return `<nav class="vault-nav-links">${links.join('')}</nav>`
  }

  const match = /^(?:打开|进入|查看)\s+(.+)$/u.exec(value.trim())
  const path = match ? safeVaultNavigationPath(match[1]) : null
  if (!path) return escaped
  return vaultNavigationLink(value.trim(), path, vaultName)
}

function artifactHtml(
  document: ArtifactDocument,
  theme: 'brand' | 'clean',
  context: ArtifactRenderContext,
): string {
  const blocks = document.blocks.map((block) => {
    if (block.type === 'heading') {
      const level = Math.min(4, Math.max(2, block.level + 1))
      return `<h${level}>${escapeHtml(block.text)}</h${level}>`
    }
    if (block.type === 'paragraph') {
      const inline = artifactInlineHtml(block.text, context)
      return inline.startsWith('<nav class="vault-nav-links">') ? inline : `<p>${inline}</p>`
    }
    if (block.type === 'quote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`
    if (block.type === 'code') return `<pre><code>${escapeHtml(block.text)}</code></pre>`
    if (block.type === 'rule') return '<hr>'
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      return `<${tag}>${block.items.map((item) => `<li>${artifactInlineHtml(item, context)}</li>`).join('')}</${tag}>`
    }
    const head = `<thead><tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
    const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${artifactInlineHtml(cell, context)}</td>`).join('')}</tr>`).join('')}</tbody>`
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
    .vault-nav-links{display:flex;flex-wrap:wrap;gap:12px;margin:1.1em 0}.vault-nav-links .vault-link{display:inline-flex;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:#f8fafc}
    .vault-link{color:var(--blue);font-weight:650;text-decoration:none;border-bottom:1px solid currentColor}.vault-link:hover{color:var(--accent)}
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
function toneOf(text: string): 'urgent' | 'risk' | 'warn' | 'calm' | 'muted' | 'none' {
  // 盲区/风险类先判：它比「优先级一」更需要被一眼看见，用陶土色区别于暖金。
  if (/盲区|风险|隐患|停滞|卡住|遗漏|预警|逾期/.test(text)) return 'risk'
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
    const tag = block.ordered ? 'ol' : 'ul'
    return `<${tag}>${block.items.map((item) => {
      const task = taskItem(item)
      return `<li>${escapeHtml(task?.text ?? item)}</li>`
    }).join('')}</${tag}>`
  }
  const head = `<thead><tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
  const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
  return `<div class="table-wrap"><table>${head}${body}</table></div>`
}

/**
 * 交互看板版式（0.7.64 按「水·木·光」品牌视觉重做）。
 *
 * 视觉规范（05_System/品牌视觉规范）：日报/看板属于「产品 · 文档底」场景 ——
 * 暖米底 + 海军蓝结构 + 墨色正文，青碧只用正向语义（完成/进度），暖金只点睛
 * （一屏几处），大圆角 + 充足留白；背景用极淡「水波涟漪」母题，进度条用
 * 水→木→光渐变（sea → jade → gold）。动效克制：入场轻微上浮、数字滚动、
 * hover 抬起，不炫技。整页自包含、零外部依赖、可离线打开、可直接打印。
 */
export function artifactDashboardHtml(document: ArtifactDocument, theme: 'brand' | 'clean'): string {
  type DashboardSection = { title: string; level: number; blocks: ArtifactBlock[] }
  type DashboardCard = { title: string; blocks: ArtifactBlock[] }
  const headings = document.blocks.filter(
    (block): block is Extract<ArtifactBlock, { type: 'heading' }> => block.type === 'heading',
  )
  const sectionLevel = headings.length > 0 ? Math.min(...headings.map((block) => block.level)) : 2
  const intro: ArtifactBlock[] = []
  const sections: DashboardSection[] = []
  for (const block of document.blocks) {
    if (block.type === 'heading' && block.level === sectionLevel) {
      sections.push({ title: block.text, level: block.level, blocks: [] })
    } else if (sections.length === 0) {
      intro.push(block)
    } else {
      sections[sections.length - 1].blocks.push(block)
    }
  }

  const splitCards = (section: DashboardSection): DashboardCard[] => {
    const cards: DashboardCard[] = []
    for (const block of section.blocks) {
      if (block.type === 'heading' && block.level > section.level) {
        cards.push({ title: block.text, blocks: [] })
      } else {
        if (cards.length === 0) cards.push({ title: '', blocks: [] })
        cards[cards.length - 1].blocks.push(block)
      }
    }
    return cards.length > 0 ? cards : [{ title: '', blocks: [] }]
  }
  const findSection = (pattern: RegExp): DashboardSection | undefined =>
    sections.find((section) => pattern.test(section.title))
  const recognized = new Set<DashboardSection>()
  const takeSection = (pattern: RegExp): DashboardSection | undefined => {
    const section = findSection(pattern)
    if (section) recognized.add(section)
    return section
  }
  const todoSection = takeSection(/今日待办|今天做什么|今日任务/u)
  const funnelSection = takeSection(/经营链路|漏在哪一步|转化漏斗/u)
  const metricsSection = takeSection(/本周数字|经营总览|关键指标/u)
  const weekSection = takeSection(/七天节奏|七天轨迹|每日进展/u)
  const yesterdaySection = takeSection(/昨天发生了什么|昨日重点|昨日复盘/u)
  const decisionSection = takeSection(/下周决策|下一步决策|决策/u)
  const evidenceSection = takeSection(/数据依据|数据来源|统计口径/u)

  const allBlocks = [...intro, ...sections.flatMap((section) => section.blocks)]
  const coverageBlock = allBlocks.find(
    (block): block is Extract<ArtifactBlock, { type: 'quote' }> =>
      block.type === 'quote' && /扫描\s*\d+\s*份.*(?:完整)?读取\s*\d+\s*份.*跳过\s*\d+\s*份/u.test(block.text),
  )
  const coverage = coverageBlock
    ? /扫描\s*(\d+)\s*份.*(?:完整)?读取\s*(\d+)\s*份.*跳过\s*(\d+)\s*份/u.exec(coverageBlock.text)
    : null
  const total = Number(coverage?.[1] ?? 0)
  const read = Number(coverage?.[2] ?? 0)
  const skipped = Number(coverage?.[3] ?? 0)
  const coveragePercent = total > 0 ? Math.min(100, Math.round((read / total) * 100)) : 0
  const judges = intro.filter(
    (block): block is Extract<ArtifactBlock, { type: 'quote' }> =>
      block.type === 'quote' && block !== coverageBlock,
  )
  const judgeBlocks = new Set<ArtifactBlock>(judges)

  const numericValue = (value: string): number | null => {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
    if (!match) return null
    const result = Number(match[0])
    return Number.isFinite(result) ? result : null
  }
  const deltaClass = (value: string): 'good' | 'bad' | 'flat' => {
    if (/▲|\+|上升|增长|增加|向好/u.test(value)) return 'good'
    if (/▼|下降|减少|走低|变差/u.test(value)) return 'bad'
    return 'flat'
  }
  const metricTable =
    metricsSection?.blocks.find(
      (block): block is Extract<ArtifactBlock, { type: 'table' }> => block.type === 'table',
    ) ??
    intro.find(
      (block): block is Extract<ArtifactBlock, { type: 'table' }> =>
        block.type === 'table' && block.headers.length >= 2 && block.headers.length <= 4,
    )
  const metricHtml = metricTable
    ? `<div class="metrics">${metricTable.rows.map((row) => {
        const value = (row[1] ?? '').trim()
        const delta = (row[2] ?? '').trim()
        const numeric = numericValue(value)
        const trend = (row[3] ?? '')
          .split(/[，,、\s]+/u)
          .map((item) => numericValue(item))
          .filter((item): item is number => item !== null)
        let sparkline = ''
        if (trend.length >= 3) {
          const max = Math.max(...trend)
          const min = Math.min(...trend)
          const span = Math.max(1, max - min)
          const points = trend.map((item, index) => {
            const x = trend.length === 1 ? 0 : (index / (trend.length - 1)) * 100
            const y = 28 - ((item - min) / span) * 24
            return `${x.toFixed(1)},${y.toFixed(1)}`
          }).join(' ')
          sparkline = `<svg class="spark" viewBox="0 0 100 32" aria-label="七日趋势"><polyline points="${points}"></polyline></svg>`
        }
        return `<article class="metric"><div class="metric-label">${escapeHtml(row[0] ?? '')}</div><div class="metric-num"${numeric !== null ? ` data-count="${numeric}"` : ''}>${escapeHtml(value || '未记录')}</div>${delta ? `<div class="delta ${deltaClass(delta)}">${escapeHtml(delta)}</div>` : ''}${sparkline}</article>`
      }).join('')}</div>`
    : ''

  const interactiveTasks = (blocks: ArtifactBlock[], core: boolean): string => {
    const items = blocks.flatMap((block) => block.type === 'list' ? block.items : [])
    const tasks = items.map((item) => taskItem(item)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    if (tasks.length === 0) return blocks.map((block) => dashboardBlockHtml(block)).join('\n')
    return `<ul class="today-tasks">${tasks.map((task) => `<li class="today-task"><label><input type="checkbox" class="today-check"${core ? ' data-core="1"' : ''}${task.done ? ' checked' : ''}><span>${escapeHtml(task.text)}</span></label></li>`).join('')}</ul>`
  }
  const todoHtml = todoSection
    ? (() => {
        const cards = splitCards(todoSection)
        const rendered = cards.map((card) => {
          const core = /必须|核心|优先推进/u.test(card.title)
          return `<article class="todo-card ${core ? 'core' : 'optional'}"><div class="tier"><i></i><span>${escapeHtml(card.title || (core ? '今天必须推进' : '今天待办'))}</span></div>${interactiveTasks(card.blocks, core)}</article>`
        }).join('')
        return `<section id="today" data-dashboard-section><div class="sec-head"><div><h2>今天做什么</h2><p id="today-meta">只统计今天的任务</p></div><div class="ring" aria-label="今日任务完成率"><svg viewBox="0 0 72 72"><circle class="ring-bg" cx="36" cy="36" r="26"></circle><circle id="ring-fg" cx="36" cy="36" r="26"></circle></svg><b id="ring-pct">0%</b></div></div><div class="todo-grid">${rendered}</div></section>`
      })()
    : ''

  const funnelHtml = funnelSection
    ? (() => {
        const table = funnelSection.blocks.find(
          (block): block is Extract<ArtifactBlock, { type: 'table' }> =>
            block.type === 'table' && block.headers.some((header) => /环节|阶段/u.test(header)),
        )
        if (!table) {
          return `<section id="funnel" data-dashboard-section><div class="sec-head"><h2>漏在哪一步</h2></div><article class="card">${funnelSection.blocks.map((block) => dashboardBlockHtml(block)).join('')}</article></section>`
        }
        const rows = table.rows.map((row) => ({
          label: row[0] ?? '',
          currentText: row[1] ?? '未记录',
          previousText: row[2] ?? '未记录',
          current: numericValue(row[1] ?? ''),
          previous: numericValue(row[2] ?? ''),
        }))
        const currentMax = Math.max(1, ...rows.map((row) => row.current ?? 0))
        const conversions = rows.slice(0, -1).map((row, index) => {
          const next = rows[index + 1]
          const currentRate = row.current && next.current !== null
            ? (next.current / row.current) * 100
            : null
          const previousRate = row.previous && next.previous !== null
            ? (next.previous / row.previous) * 100
            : null
          return {
            currentRate,
            delta: currentRate !== null && previousRate !== null ? currentRate - previousRate : null,
          }
        })
        let leakIndex = -1
        let worstDelta = 0
        conversions.forEach((item, index) => {
          if (item.delta !== null && item.delta < worstDelta) {
            worstDelta = item.delta
            leakIndex = index
          }
        })
        const bars = rows.map((row, index) => {
          const width = row.current === null ? 34 : Math.max(18, Math.round((row.current / currentMax) * 100))
          const conversion = conversions[index]
          const conversionHtml = conversion
            ? `<div class="conversion${index === leakIndex ? ' leak' : ''}"><span>${conversion.currentRate === null ? '转化率待补' : `转化 ${conversion.currentRate.toFixed(1)}%`}</span>${conversion.delta === null ? '' : `<em>${conversion.delta >= 0 ? '▲' : '▼'} ${Math.abs(conversion.delta).toFixed(1)}pp</em>`}${index === leakIndex ? '<b>最大漏点</b>' : ''}</div>`
            : ''
          return `<div class="funnel-row"><div class="funnel-bar fn${(index % 6) + 1}" style="--w:${width}%"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.currentText)}</strong></div><small>上周 ${escapeHtml(row.previousText)}</small></div>${conversionHtml}`
        }).join('')
        const notes = funnelSection.blocks.filter((block) => block !== table && block.type !== 'heading')
        return `<section id="funnel" data-dashboard-section><div class="sec-head"><div><h2>漏在哪一步</h2><p>先看转化，再决定本周最该补哪一环</p></div></div><article class="card funnel-card">${bars}${notes.length > 0 ? `<div class="funnel-note">${notes.map((block) => dashboardBlockHtml(block)).join('')}</div>` : ''}</article></section>`
      })()
    : ''

  const metricsHtml = metricHtml
    ? `<section id="metrics" data-dashboard-section><div class="sec-head"><div><h2>本周数字</h2><p>有环比才知道是进步还是退步</p></div></div>${metricHtml}</section>`
    : ''

  const weekHtml = weekSection
    ? (() => {
        const table = weekSection.blocks.find(
          (block): block is Extract<ArtifactBlock, { type: 'table' }> => block.type === 'table',
        )
        let rhythm = ''
        if (table && table.rows.length > 0) {
          const values = table.rows.map((row) => numericValue(row[1] ?? '') ?? 0)
          const max = Math.max(1, ...values)
          rhythm = `<div class="rhythm">${table.rows.slice(0, 7).map((row, index) => {
            const value = values[index]
            const height = Math.max(8, Math.round((value / max) * 100))
            return `<article class="day${value === max && max > 0 ? ' peak' : ''}"><b>${escapeHtml(row[0] ?? '')}</b><div class="day-bar"><i style="--h:${height}%"></i></div><strong>${escapeHtml(row[1] ?? '')}</strong><span>${escapeHtml(row[2] ?? '')}</span><em>${escapeHtml(row[3] ?? '')}</em><p>${escapeHtml(row[4] ?? '')}</p></article>`
          }).join('')}</div>`
        }
        const rest = weekSection.blocks.filter((block) => block !== table && block.type !== 'heading')
        return `<section id="rhythm" data-dashboard-section><div class="sec-head"><div><h2>七天节奏</h2><p>哪一天真的产生了经营结果</p></div></div>${rhythm || `<article class="card">${weekSection.blocks.map((block) => dashboardBlockHtml(block)).join('')}</article>`}${rest.length > 0 ? `<div class="cards">${rest.map((block) => `<article class="card">${dashboardBlockHtml(block)}</article>`).join('')}</div>` : ''}</section>`
      })()
    : ''

  const receiptBlocks = (blocks: ArtifactBlock[]): string => blocks.map((block) => {
    if (block.type !== 'list') return dashboardBlockHtml(block)
    return `<ul class="receipts">${block.items.map((item) => {
      const task = taskItem(item)
      const done = task?.done === true
      return `<li class="${done ? 'done' : 'open'}"><i>${done ? '✓' : '—'}</i><span>${escapeHtml(task?.text ?? item)}</span></li>`
    }).join('')}</ul>`
  }).join('')
  const yesterdayHtml = yesterdaySection
    ? `<section id="yesterday" data-dashboard-section><div class="sec-head"><div><h2>昨天发生了什么</h2><p>已经发生的事只做回执，不参与今天进度</p></div></div><div class="cards">${splitCards(yesterdaySection).map((card) => `<article class="card"><h3>${escapeHtml(card.title || '昨日记录')}</h3>${receiptBlocks(card.blocks)}</article>`).join('')}</div></section>`
    : ''

  const decisionHtml = decisionSection
    ? `<section id="decide" data-dashboard-section><div class="sec-head"><div><h2>下周决策</h2><p>三做一不做，减少分散</p></div></div><div class="cards">${splitCards(decisionSection).map((card) => `<article class="card ${toneOf(card.title) === 'muted' ? 'muted' : ''}"><h3>${escapeHtml(card.title || '行动')}</h3>${card.blocks.map((block) => dashboardBlockHtml(block)).join('')}</article>`).join('')}</div></section>`
    : ''

  const evidenceHtml = evidenceSection
    ? `<section id="evidence" data-dashboard-section><details class="evidence"><summary>数据依据${total > 0 ? ` · ${read} 份读取、${skipped} 份跳过` : ''}</summary><div class="evidence-body">${evidenceSection.blocks.filter((block) => block.type !== 'heading').map((block) => dashboardBlockHtml(block)).join('')}<div class="warnbox"><b>口径提醒：</b>最近 7 天按文件修改时间统计；同步、git pull 或批量脚本改写会影响本周口径。AI霖子输出目录默认不参与扫描，附件只有本机工具明确读取成功才算已读。</div></div></details></section>`
    : ''

  const genericSections = sections.filter((section) => !recognized.has(section))
  const genericHtml = genericSections.map((section, index) =>
    `<section id="extra-${index}" data-dashboard-section><div class="sec-head"><h2>${escapeHtml(section.title)}</h2></div><div class="cards">${splitCards(section).map((card) => `<article class="card"><h3>${escapeHtml(card.title)}</h3>${card.blocks.map((block) => dashboardBlockHtml(block)).join('')}</article>`).join('')}</div></section>`,
  ).join('')
  const introRest = intro.filter((block) => block !== coverageBlock && !judgeBlocks.has(block) && block !== metricTable)
  const navItems = [
    todoHtml ? ['today', '今天', ''] : null,
    funnelHtml ? ['funnel', '漏点', ''] : null,
    metricsHtml ? ['metrics', '数字', ''] : null,
    weekHtml ? ['rhythm', '七天', ''] : null,
    yesterdayHtml ? ['yesterday', '昨天', ''] : null,
    decisionHtml ? ['decide', '决策', ''] : null,
    evidenceHtml ? ['evidence', '依据', ''] : null,
  ].filter((item): item is string[] => Boolean(item))
  if (navItems[0]) navItems[0][2] = '0/0'
  const navigation = navItems.map((item, index) =>
    `<a href="#${item[0]}"${index === 0 ? ' class="on"' : ''}><span>${escapeHtml(item[1])}</span>${item[2] ? `<b>${item[2]}</b>` : ''}</a>`,
  ).join('')
  const bodySections = `${todoHtml}${funnelHtml}${metricsHtml}${weekHtml}${yesterdayHtml}${decisionHtml}${evidenceHtml}${genericHtml}` ||
    `<section data-dashboard-section><article class="card">${intro.map((block) => dashboardBlockHtml(block)).join('')}</article></section>`

  const gold = theme === 'clean' ? '#2E5A8F' : '#F5C518'
  const goldSoft = theme === 'clean' ? '#CBD9EA' : '#FCE38A'
  const storageKey = `ai-linzi-board:${document.title}`
  const script = [
    '(function(){',
    `var KEY=${JSON.stringify(storageKey)}+":"+location.pathname;`,
    'var boxes=[].slice.call(document.querySelectorAll("#today input[type=checkbox]"));',
    'boxes.forEach(function(box,i){box.dataset.idx=String(i)});',
    'var saved={};try{saved=JSON.parse(localStorage.getItem(KEY)||"{}")}catch(e){saved={}}',
    'boxes.forEach(function(box){if(typeof saved[box.dataset.idx]==="boolean")box.checked=saved[box.dataset.idx]});',
    'var CIRC=2*Math.PI*26;',
    'function paint(){',
    'var total=boxes.length,done=boxes.filter(function(b){return b.checked}).length;',
    'var core=boxes.filter(function(b){return b.dataset.core==="1"}),coreDone=core.filter(function(b){return b.checked}).length;',
    `var pct=total?Math.round(done/total*100):0,ring=document.getElementById("ring-fg"),label=document.getElementById("ring-pct"),meta=document.getElementById("today-meta"),rail=document.querySelector('.rail a[href="#today"] b');`,
    'if(ring)ring.setAttribute("stroke-dashoffset",String(CIRC*(1-pct/100)));if(label)label.textContent=pct+"%";if(rail)rail.textContent=coreDone+"/"+core.length;',
    'if(meta)meta.textContent=core.length?(coreDone===core.length?"必须推进的 "+core.length+" 件已经全部完成":(core.length-coreDone)+" 件必须推进 · "+(total-core.length)+" 件完成一项即可"):"今天没有可勾选任务";',
    'boxes.forEach(function(box){var li=box.closest("li");if(li)li.classList.toggle("done",box.checked)});',
    '}',
    'boxes.forEach(function(box){box.addEventListener("change",function(){var out={};boxes.forEach(function(item){out[item.dataset.idx]=item.checked});try{localStorage.setItem(KEY,JSON.stringify(out))}catch(e){}paint()})});',
    'var links=[].slice.call(document.querySelectorAll(".rail a")),targets=links.map(function(link){return document.querySelector(link.getAttribute("href"))});',
    'if("IntersectionObserver" in window){var io=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(!entry.isIntersecting)return;links.forEach(function(link,index){link.classList.toggle("on",targets[index]===entry.target)})})},{rootMargin:"-12% 0px -70% 0px",threshold:0});targets.forEach(function(target){if(target)io.observe(target)})}',
    'var search=document.getElementById("q");if(search)search.addEventListener("input",function(){var q=search.value.trim().toLowerCase();[].slice.call(document.querySelectorAll("[data-dashboard-section]")).forEach(function(section){section.hidden=Boolean(q)&&section.textContent.toLowerCase().indexOf(q)<0})});',
    'var opened=[];window.addEventListener("beforeprint",function(){opened=[].slice.call(document.querySelectorAll("details:not([open])"));opened.forEach(function(item){item.open=true})});window.addEventListener("afterprint",function(){opened.forEach(function(item){item.open=false});opened=[]});',
    'paint();',
    '})();',
  ].join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{
      --navy:#293857;--ink-navy:#0B1730;--navy-light:#5C7BB0;--sea:#2E5A8F;
      --jade:#3DB389;--positive:#237A5C;--gold:${gold};--gold-soft:${goldSoft};--clay:#B0532F;
      --cream:#FAF6F0;--warm:#F1ECE3;--line:#E7DFD2;--paper:#FFFDFA;
      --ink:#1A1612;--ink-soft:#4A4036;--ink-mute:#8A7E74;--shadow:0 14px 30px rgba(41,56,87,.07);
      --fn1:#DCE8F5;--fn2:#C6D9ED;--fn3:#9CBBDD;--fn4:#739BC7;--fn5:#4B78AD;--fn6:#2E5A8F;
      --num:"Avenir Next","DIN Alternate","Helvetica Neue",sans-serif;
    }
    @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
      --cream:#0B1730;--warm:#16243F;--line:#2C3D5C;--paper:#101D33;--ink:#FAF6F0;
      --ink-soft:#D8DEEA;--ink-mute:#A6B6D4;--navy:#FAF6F0;--positive:#6FD9B0;--clay:#E08A5F;
      --shadow:0 14px 30px rgba(0,0,0,.34);--fn1:#263C60;--fn2:#2E4A74;--fn3:#365A88;--fn4:#4773A7;--fn5:#5C8BC0;--fn6:#75A4D4;
    }}
    :root[data-theme="dark"]{
      --cream:#0B1730;--warm:#16243F;--line:#2C3D5C;--paper:#101D33;--ink:#FAF6F0;
      --ink-soft:#D8DEEA;--ink-mute:#A6B6D4;--navy:#FAF6F0;--positive:#6FD9B0;--clay:#E08A5F;
      --shadow:0 14px 30px rgba(0,0,0,.34);--fn1:#263C60;--fn2:#2E4A74;--fn3:#365A88;--fn4:#4773A7;--fn5:#5C8BC0;--fn6:#75A4D4;
    }
    *{box-sizing:border-box}html{scroll-behavior:smooth}
    body{margin:0;background:var(--cream);color:var(--ink);font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;line-height:1.65;-webkit-font-smoothing:antialiased}
    .shell{width:min(1240px,calc(100% - 32px));margin:34px auto 70px;display:grid;grid-template-columns:132px minmax(0,1fr);gap:24px;align-items:start}
    .rail{position:sticky;top:24px;display:grid;gap:6px;padding:10px;border:1px solid var(--line);background:var(--paper);border-radius:18px;box-shadow:var(--shadow)}
    .rail a{display:flex;justify-content:space-between;gap:8px;padding:9px 10px;border-radius:10px;color:var(--ink-mute);font-size:13px;text-decoration:none;transition:.18s}
    .rail a:hover,.rail a.on{background:var(--warm);color:var(--navy);font-weight:650}.rail b{font-family:var(--num);font-size:11px;color:var(--positive)}
    main{min-width:0}.hero,.card,.metric,.todo-card,.evidence{background:var(--paper);border:1px solid var(--line)}
    .hero{padding:34px 38px;border-radius:24px;box-shadow:var(--shadow)}
    h1{margin:0;color:var(--navy);font-size:clamp(27px,4vw,38px);line-height:1.25;letter-spacing:-.02em}.sub{margin:8px 0 0;color:var(--ink-mute);font-size:13px}
    .judge{margin-top:22px;padding:15px 20px;border-left:3px solid var(--gold);border-radius:0 12px 12px 0;background:linear-gradient(90deg,var(--gold-soft),transparent 78%)}
    .judge p{margin:.2em 0;font-family:"Songti SC","STSong",Georgia,serif;font-style:italic;color:var(--ink-soft);font-size:19px}
    .coverage{margin-top:22px;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;color:var(--ink-mute);font-size:12px}.coverage-track{height:7px;border-radius:99px;background:var(--warm);overflow:hidden}.coverage-track i{display:block;height:100%;width:var(--coverage);background:linear-gradient(90deg,var(--sea),var(--jade));border-radius:inherit}
    #q{margin-top:20px;width:min(340px,100%);padding:10px 15px;border:1px solid var(--line);border-radius:99px;background:var(--cream);color:var(--ink);font:inherit;font-size:13px;outline:none}#q:focus{border-color:var(--sea)}
    .intro{margin-top:18px;color:var(--ink-soft);font-size:14px}.intro p{margin:.5em 0}
    section[data-dashboard-section]{margin-top:34px;scroll-margin-top:24px}.sec-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:14px}.sec-head h2{margin:0;color:var(--navy);font-size:24px}.sec-head p{margin:4px 0 0;color:var(--ink-mute);font-size:13px}
    .ring{position:relative;width:72px;height:72px;flex:0 0 auto}.ring svg{display:block;width:72px;height:72px;transform:rotate(-90deg)}.ring circle{fill:none;stroke-width:7}.ring-bg{stroke:var(--warm)}#ring-fg{stroke:var(--jade);stroke-linecap:round;stroke-dasharray:163.36;stroke-dashoffset:163.36;transition:stroke-dashoffset .4s}.ring b{position:absolute;inset:0;display:grid;place-items:center;color:var(--navy);font:750 14px var(--num)}
    .todo-grid,.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.todo-card,.card{border-radius:18px;padding:21px 23px}.todo-card.core{border-top:3px solid var(--gold)}.todo-card.optional{border-top:3px solid var(--sea)}
    .tier{display:flex;align-items:center;gap:9px;margin-bottom:10px;color:var(--navy);font-weight:700}.tier i{width:9px;height:9px;border-radius:50%;background:var(--sea)}.core .tier i{background:var(--gold)}
    .today-tasks,.receipts{list-style:none;padding:0;margin:0}.today-task{margin:6px 0}.today-task label{display:flex;gap:10px;align-items:flex-start;padding:8px 9px;border-radius:10px;cursor:pointer}.today-task label:hover{background:var(--warm)}.today-task input{width:17px;height:17px;margin:3px 0 0;accent-color:var(--jade)}.today-task.done span{text-decoration:line-through;color:var(--ink-mute)}
    .funnel-card{padding:26px}.funnel-row{display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:12px;align-items:center}.funnel-row small{color:var(--ink-mute);font:12px var(--num)}.funnel-bar{width:var(--w);min-width:160px;max-width:100%;display:flex;justify-content:space-between;gap:14px;padding:10px 14px;border-radius:8px;color:var(--ink-navy);transform-origin:left;animation:grow .65s ease both}.funnel-bar strong{font-family:var(--num)}.fn1{background:var(--fn1)}.fn2{background:var(--fn2)}.fn3{background:var(--fn3)}.fn4{background:var(--fn4)}.fn5{background:var(--fn5)}.fn6{background:var(--fn6);color:var(--paper)}
    .conversion{display:flex;align-items:center;gap:10px;margin:5px 0 5px 20px;color:var(--ink-mute);font:12px var(--num)}.conversion em{font-style:normal}.conversion.leak{color:var(--clay);font-weight:700}.conversion b{padding:2px 7px;border:1px solid currentColor;border-radius:99px;font-size:10px}.funnel-note{margin-top:18px;padding:14px 16px;border-left:3px solid var(--clay);background:var(--warm);border-radius:0 10px 10px 0}.funnel-note p{margin:.35em 0}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.metric{border-radius:16px;padding:17px}.metric-label{font-size:12px;color:var(--ink-mute)}.metric-num{margin-top:4px;color:var(--navy);font:800 28px var(--num);font-variant-numeric:tabular-nums}.delta{margin-top:7px;font:12px var(--num)}.delta.good{color:var(--positive)}.delta.bad{color:var(--clay)}.delta.flat{color:var(--ink-mute)}.spark{width:100%;height:34px;margin-top:8px;overflow:visible}.spark polyline{fill:none;stroke:var(--sea);stroke-width:2;vector-effect:non-scaling-stroke}
    .rhythm{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:9px}.day{min-width:0;padding:14px 10px;border:1px solid var(--line);border-radius:14px;background:var(--paper);text-align:center}.day>b{font:700 12px var(--num);color:var(--navy)}.day-bar{height:70px;margin:9px auto 7px;display:flex;align-items:flex-end;justify-content:center}.day-bar i{display:block;width:20px;height:var(--h);border-radius:6px 6px 2px 2px;background:var(--sea);transform-origin:bottom;animation:barGrow .6s ease both}.day.peak .day-bar i{background:var(--jade)}.day strong{display:block;font:700 13px var(--num)}.day span,.day em,.day p{display:block;margin:4px 0 0;color:var(--ink-mute);font-size:10px;font-style:normal;overflow-wrap:anywhere}.day em{color:var(--positive)}
    .card h3{margin:0 0 10px;color:var(--navy);font-size:17px}.card h4{margin:1em 0 .4em;color:var(--sea);font-size:14px}.card p,.card li{color:var(--ink-soft);font-size:14px}.card ul,.card ol{padding-left:20px}.card.muted{background:var(--warm)}.receipts li{display:flex;gap:10px;align-items:flex-start;margin:8px 0}.receipts i{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--warm);color:var(--ink-mute);font-style:normal;font-size:11px;flex:0 0 auto}.receipts .done i{background:var(--jade);color:var(--ink-navy)}.receipts .open span{color:var(--ink-mute)}
    .table-wrap{overflow-x:auto;margin:.7em 0}table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{padding:8px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--warm);color:var(--navy)}pre{overflow:auto;padding:13px;background:var(--ink-navy);color:var(--cream);border-radius:10px}blockquote{margin:.7em 0;padding:10px 14px;border-left:3px solid var(--sea);background:var(--warm)}
    .evidence{border-radius:18px;overflow:hidden}.evidence summary{padding:17px 20px;cursor:pointer;color:var(--navy);font-weight:700}.evidence-body{padding:0 20px 20px}.warnbox{margin-top:14px;padding:13px 15px;border-left:3px solid var(--clay);background:var(--warm);color:var(--ink-soft);font-size:12px}
    footer{margin-top:38px;text-align:center;color:var(--ink-mute);font-size:12px}
    @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes barGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
    @media(max-width:860px){.shell{grid-template-columns:1fr}.rail{position:static;display:flex;overflow-x:auto}.rail a{flex:0 0 auto}.rhythm{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:620px){.shell{width:calc(100% - 20px);margin-top:12px}.hero{padding:24px 21px}.todo-grid,.cards{grid-template-columns:1fr}.rhythm{grid-template-columns:repeat(2,minmax(0,1fr))}.funnel-row{grid-template-columns:1fr}.funnel-row small{padding-left:10px}.funnel-bar{min-width:120px}}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
    @media print{body{background:#fff}.shell{display:block;width:100%;margin:0}.rail,#q{display:none}.hero,.card,.metric,.todo-card,.evidence{box-shadow:none;break-inside:avoid}details .evidence-body{display:block!important}section{break-inside:avoid}}
  </style>
</head>
<body>
  <div class="shell">
    <nav class="rail" aria-label="看板导航">${navigation}</nav>
    <main>
      <header class="hero">
        <h1>${escapeHtml(document.title)}</h1>
        <p class="sub">AI霖子 · 经营驾驶舱 · 只有“今天做什么”可以勾选，进度保存在本机</p>
        ${judges.length > 0 ? `<div class="judge">${judges.map((block) => `<p>${escapeHtml(block.text)}</p>`).join('')}</div>` : ''}
        ${coverage ? `<div class="coverage"><span>本轮覆盖率</span><div class="coverage-track"><i style="--coverage:${coveragePercent}%"></i></div><b>${read}/${total} · 跳过 ${skipped}</b></div>` : ''}
        <input id="q" type="search" placeholder="搜索看板内容…" autocomplete="off">
        ${introRest.length > 0 ? `<div class="intro">${introRest.map((block) => dashboardBlockHtml(block)).join('')}</div>` : ''}
      </header>
      ${bodySections}
      <footer>由 AI霖子生成 · 事实以文件原文为准，判断与假设请继续核对</footer>
    </main>
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
      block.items.forEach((item) => children.push(new Paragraph({
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
    canvas = createEl('canvas')
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
  return Uint8Array.from(archive).buffer
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

export async function renderArtifact(
  operation: CreateArtifactOperation,
  context: ArtifactRenderContext = {},
): Promise<RenderedArtifact> {
  const document = parseArtifactMarkdown(operation.content, operation.title)
  const theme = operation.theme ?? 'brand'
  if (operation.format === 'html') {
    // 看板/日报类内容走交互版式；长文继续文档版式（0.7.54）。
    const data = resolveArtifactLayout(operation) === 'dashboard'
      ? artifactDashboardHtml(document, theme)
      : artifactHtml(document, theme, context)
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

/**
 * 客户咨询简报的导出关键样式。
 *
 * PNG 不能把正确性押在 Obsidian 当前主题或 styles.css 是否已热加载上。这里在
 * 离屏导出树上写入一份最小、确定的内联样式；普通插件界面仍由 styles.css 管理。
 * 所有值都是本仓库常量，绝不接受模型 CSS。
 */

type StyleMap = Record<string, string>

function setStyles(element: Element | null, styles: StyleMap): void {
  if (!(element instanceof HTMLElement)) return
  for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value)
}

function setAll(root: ParentNode, selector: string, styles: StyleMap): void {
  for (const element of Array.from(root.querySelectorAll(selector))) setStyles(element, styles)
}

export function applyConsultationBriefExportStyles(
  host: HTMLElement,
  card: HTMLElement,
  body: HTMLElement,
): void {
  setStyles(host, {
    position: 'fixed', 'z-index': '-10000', top: '0', left: '-12000px', width: '880px',
    'pointer-events': 'none',
  })
  setStyles(card, {
    'box-sizing': 'border-box', width: '880px', overflow: 'hidden',
    border: '1px solid rgba(15, 23, 42, 0.10)', 'border-radius': '20px',
    background: '#fafaf7', color: '#1f2937',
    'font-family': '-apple-system, BlinkMacSystemFont, "PingFang SC", Arial, sans-serif',
  })
  const header = card.querySelector('.ai-linzi-consultation-header')
  setStyles(header, {
    position: 'relative', 'box-sizing': 'border-box', padding: '36px 48px 32px',
    background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', color: '#ffffff',
  })
  setStyles(card.querySelector('.ai-linzi-consultation-header-label'), {
    position: 'absolute', top: '20px', right: '32px', color: 'rgba(248, 250, 252, 0.50)',
    'font-size': '11px', 'font-weight': '600', 'letter-spacing': '0.15em',
  })
  setAll(card, '.ai-linzi-consultation-header h1', {
    margin: '0 0 10px', color: '#ffffff', 'font-size': '32px', 'font-weight': '700',
    'line-height': '1.2', 'letter-spacing': '-0.02em',
  })
  setAll(card, '.ai-linzi-consultation-header blockquote', {
    margin: '0', padding: '0', border: '0', color: 'rgba(248, 250, 252, 0.75)',
    'font-size': '14px', 'letter-spacing': '0.02em',
  })
  setAll(card, '.ai-linzi-consultation-header blockquote p', { margin: '0', color: 'inherit' })

  setStyles(body, {
    'box-sizing': 'border-box', padding: '36px 48px 32px', color: '#1f2937',
    background: '#fafaf7', 'font-size': '15px', 'line-height': '1.75',
  })
  setAll(body, 'h2', {
    display: 'flex', 'align-items': 'center', gap: '10px', margin: '28px 0 14px',
    color: '#0f172a', 'font-size': '17px', 'font-weight': '700',
  })
  setStyles(body.querySelector('h2'), { 'margin-top': '0' })
  setAll(body, 'h3', {
    margin: '20px 0 6px', 'padding-left': '12px', 'border-left': '3px solid #d97706',
    color: '#0f172a', 'font-size': '15px', 'font-weight': '700', 'line-height': '1.4',
  })
  setAll(body, 'p', { margin: '8px 0', color: '#1f2937', 'line-height': '1.75' })
  setAll(body, 'strong', { color: 'inherit', 'font-weight': '750' })

  setAll(body, '.ai-linzi-consultation-section-icon', {
    display: 'inline-flex', flex: '0 0 32px', 'align-items': 'center',
    'justify-content': 'center', width: '32px', height: '32px', 'border-radius': '8px',
    background: '#f1f5f9', color: '#0f172a', 'font-size': '16px',
  })
  const iconTones: Array<[string, string, string]> = [
    ['is-diagnosis', '#fef3c7', '#d97706'], ['is-insight', '#e0e7ff', '#4338ca'],
    ['is-path', '#dcfce7', '#15803d'], ['is-products', '#dbeafe', '#1e40af'],
    ['is-goal', '#dbeafe', '#1e40af'], ['is-summary', '#fef3c7', '#b45309'],
    ['is-action', '#ffedd5', '#c2410c'], ['is-takeaway', '#fef9c3', '#a16207'],
  ]
  for (const [kind, background, color] of iconTones) {
    setAll(body, `.ai-linzi-consultation-section-icon.${kind}`, { background, color })
  }

  const darkQuote = {
    'box-sizing': 'border-box', border: '0', background: '#0f172a', color: '#f8fafc',
  }
  setAll(body, 'blockquote.ai-linzi-consultation-advice', {
    ...darkQuote, margin: '10px 0', padding: '14px 18px 12px',
    'border-left': '4px solid #d97706', 'border-radius': '10px',
    'font-size': '14px', 'line-height': '1.7',
  })
  setAll(body, 'blockquote.ai-linzi-consultation-summary', {
    ...darkQuote, position: 'relative', margin: '16px 0', padding: '24px 28px 24px 56px',
    'border-radius': '14px', 'font-size': '15px', 'line-height': '1.8',
  })
  setAll(body, 'blockquote.ai-linzi-consultation-advice p, blockquote.ai-linzi-consultation-summary p', {
    margin: '0', color: '#f8fafc',
  })
  setAll(body, '.ai-linzi-consultation-quote-mark', {
    position: 'absolute', top: '12px', left: '20px', color: '#d97706',
    'font-family': 'Georgia, serif', 'font-size': '42px', 'font-weight': '700', 'line-height': '1',
  })
  setAll(body, '.ai-linzi-consultation-signature', {
    'margin-top': '12px', color: '#d97706', 'font-size': '13px',
    'font-weight': '600', 'text-align': 'right',
  })

  setAll(body, 'table', {
    width: '100%', margin: '14px 0', overflow: 'hidden', border: '1px solid #e2e8f0',
    'border-radius': '10px', 'border-collapse': 'collapse', background: '#ffffff', 'font-size': '14px',
  })
  setAll(body, 'th, td', {
    padding: '12px 16px', border: '0', 'border-top': '1px solid #f1f5f9',
    color: '#1f2937', 'text-align': 'left', 'vertical-align': 'top', background: '#ffffff',
  })
  setAll(body, 'th', {
    'border-top': '0', background: '#0f172a', color: '#f8fafc',
    'font-size': '13px', 'font-weight': '600', 'letter-spacing': '0.02em',
  })
  setAll(body, '.ai-linzi-consultation-structured-grid', {
    display: 'grid', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
    gap: '12px', margin: '14px 0',
  })
  setAll(body, '.ai-linzi-consultation-structured-card', {
    'box-sizing': 'border-box', 'min-width': '0', padding: '14px 12px',
    border: '1.5px solid #dbe3f0', 'border-radius': '12px', background: '#ffffff',
  })
  setAll(body, '.ai-linzi-consultation-layer', {
    'margin-bottom': '6px', color: '#324e7d', 'font-size': '10px',
    'font-weight': '700', 'letter-spacing': '0.5px', 'text-transform': 'uppercase',
  })
  setAll(body, '.ai-linzi-consultation-structured-title', {
    color: '#0f172a', 'font-size': '13px', 'font-weight': '700', 'line-height': '1.4',
  })
  setAll(body, '.ai-linzi-consultation-price', {
    margin: '6px 0', color: '#d97706', 'font-size': '16px', 'font-weight': '800',
  })
  setAll(body, '.ai-linzi-consultation-structured-description', {
    color: '#666666', 'font-size': '11px', 'line-height': '1.5',
  })
  setAll(body, 'ul', { margin: '8px 0', 'padding-left': '22px', 'list-style': 'disc' })
  setAll(body, 'li', { margin: '6px 0', color: '#1f2937', 'line-height': '1.7' })
  setAll(body, 'li.task-list-item', {
    display: 'flex', 'align-items': 'flex-start', gap: '10px', margin: '8px 0',
    padding: '10px 14px', border: '1px solid #e5e7eb', 'border-radius': '10px',
    background: '#ffffff', color: '#1f2937', 'line-height': '1.6', 'list-style': 'none',
  })

  const footer = card.querySelector('.ai-linzi-consultation-footer')
  setStyles(footer, {
    'box-sizing': 'border-box', display: 'flex', 'align-items': 'center',
    'justify-content': 'space-between', gap: '16px', padding: '16px 48px',
    'border-top': '1px solid #e5e7eb', background: '#ffffff', color: '#64748b',
    'font-size': '11px',
  })
  setAll(card, '.ai-linzi-consultation-footer span', { color: 'inherit' })
  setAll(card, '.ai-linzi-consultation-footer-site', { color: '#0f172a', 'font-weight': '600' })
  setAll(card, '.ai-linzi-consultation-footer-date', {
    'flex-shrink': '0', 'font-family': 'Arial, monospace',
  })
}

/** 本机排版兼容：只处理 HTML 表现与明确的章节编号，不改写文章。 */
function htmlAttributes(attributes: string): string[] {
  return attributes.match(/\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g) ?? []
}

export function normalizeWechatSourceHtml(html: string): string {
  // 处理完整标签（包括带 > 的引号属性），不能用 <h2> 的精确字符串
  // 匹配导入的 <h2 class="..." style="...">。
  return html.replace(/<!--[\s\S]*?-->|<(\/?)([a-z][\w:-]*)((?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?)\s*\/?>/gi,
    (tag, closing: string | undefined, name: string | undefined, attributes: string | undefined) => {
      if (!name) return ''
      const lower = name.toLowerCase()
      // 图片已有的尺寸是内容布局，不是文字主题；避免把导入图片放大。
      if (['img', 'picture', 'source', 'video', 'audio', 'svg', 'path'].includes(lower)) return tag
      // Word/WPS 的 span/font 只承载旧字体与颜色；保留其文字和内部语义标签。
      if (lower === 'span' || lower === 'font') return ''
      const semantic = lower === 'b' ? 'strong' : lower === 'i' ? 'em' : lower
      if (closing) return `</${semantic}>`
      const attrs = htmlAttributes(attributes ?? '')
        .filter((attribute) => !/^\s+(?:style|class|color|face|size)(?:\s*=|\s*$)/i.test(attribute))
        .join('').trimEnd()
      return `<${semantic}${attrs}${/\/\s*>$/.test(tag) ? '/' : ''}>`
    })
}

/** 一次性写入样式，保留 href/id/列表起始值等语义属性及带 > 的引号值。 */
export function applyWechatTagStyles(html: string, styles: Record<string, string>): string {
  return html.replace(/<([a-z][\w:-]*)((?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?)\s*\/?>/gi,
    (tag, name: string, attributes: string) => {
      const style = styles[name]
      if (!style || htmlAttributes(attributes).some((attr) => /^\s+style\s*=/i.test(attr))) return tag
      return `<${name}${attributes.trimEnd().replace(/\/$/, '')} style="${style}">`
    })
}

/** 只提升独立、短小的中文编号段落；列表、引用、表格、代码保持原结构。 */
export function promoteWechatSectionHeadings(html: string): string {
  let protectedDepth = 0
  return html.replace(/<p((?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?)>([\s\S]*?)<\/p>|<(\/?)(blockquote|li|td|th|pre|code)\b[^>]*>/gi,
    (block, attributes: string | undefined, paragraph: string | undefined, closing: string | undefined) => {
      if (paragraph === undefined) {
        protectedDepth = Math.max(0, protectedDepth + (closing ? -1 : 1))
        return block
      }
      if (protectedDepth) return block
      const text = paragraph.replace(/<\/?(?:strong|em)>/gi, '').trim()
      if (/[<>\n\r。；;！!]/u.test(text) || Array.from(text).length > 60) return block
      const main = /^[一二三四五六七八九十百]+[、．.]\s*\S/u.test(text)
      const sub = /^[（(][一二三四五六七八九十百]+[）)]\s*\S/u.test(text)
      if (!main && !sub) return block
      const heading = main ? 'h2' : 'h3'
      return `<${heading}${attributes ?? ''}>${paragraph.trim()}</${heading}>`
    })
}

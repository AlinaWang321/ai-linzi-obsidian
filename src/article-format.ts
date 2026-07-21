/**
 * AI霖子公众号文章结构契约。
 *
 * 两个写作入口历史上产出过三种 PART 结构：
 * - **PART 01** + **金句标题**
 * - PART 01 金句标题
 * - **PART 01** + ## 金句标题（当前标准）
 *
 * 保存、配图和发布都经过这里，保证旧文章与新文章得到同一份可发布正文。
 */

export interface PreparedWechatArticle {
  body: string
  titleCandidates: string[]
  digest: string
  /** 是否识别并剥离了「候选标题 / 正文 / 摘要」外层结构 */
  recognizedContainer: boolean
}

export interface EmbedItem {
  path: string
  anchor: string
}

export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function stripOuterFence(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md)?\s*\r?\n/i, '')
    .replace(/\r?\n```\s*$/i, '')
    .trim()
}

function headingIndex(lines: string[], kind: 'titles' | 'body' | 'digest'): number {
  const patterns = {
    titles: /^#{1,6}\s*(?:一|1)[、.．)]\s*(?:5\s*个)?(?:爆款)?标题候选\s*$/i,
    body: /^#{1,6}\s*(?:二|2)[、.．)]\s*正文(?:\s*[（(].*?[）)])?\s*$/i,
    digest: /^#{1,6}\s*(?:三|3)[、.．)]\s*摘要\s*$/i,
  }
  return lines.findIndex((line) => patterns[kind].test(line.trim()))
}

function extractCandidates(lines: string[]): string[] {
  return lines
    .map((line) => /^\s*\d+[.、．)]\s*(.+?)\s*$/.exec(line)?.[1]?.trim() ?? '')
    .map((line) => line.replace(/^\*\*(.+)\*\*$/, '$1').replace(/^[「“”"]|[」“”"]$/g, '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

function firstDigest(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && line !== '---')[0]
    ?.replace(/^\*\*(.+)\*\*$/, '$1')
    .trim() ?? ''
}

function unwrapBold(line: string): string | null {
  const match = /^\*\*\s*(.+?)\s*\*\*$/.exec(line.trim())
  return match?.[1]?.trim() ?? null
}

function normalizePartLabel(label: string): string {
  const match = /^PART\s*0*(\d+)$/i.exec(label.trim())
  if (!match) return label.trim().toUpperCase()
  return `PART ${match[1].padStart(2, '0')}`
}

/** 把历史 PART 写法归一为「黄胶囊 PART + ## 亮蓝金句标题」。 */
export function normalizePartStructure(markdown: string): string {
  const source = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  for (let i = 0; i < source.length; i++) {
    const line = source[i]
    const trimmed = line.trim()
    const emphasized = unwrapBold(trimmed) ?? /^\*\s*(PART\s*0*\d+)\s*\*$/i.exec(trimmed)?.[1] ?? null
    const emphasizedPart = emphasized && /^PART\s*0*\d+$/i.test(emphasized) ? emphasized : null
    const combined = /^PART\s*0*(\d+)\s*(?:[：:·—–-]\s*|\s+)(.+)$/i.exec(trimmed)

    if (combined) {
      out.push(`**PART ${combined[1].padStart(2, '0')}**`, '', `## ${combined[2].replace(/^\*\*(.+)\*\*$/, '$1').trim()}`)
      continue
    }

    if (!emphasizedPart) {
      out.push(line)
      continue
    }

    out.push(`**${normalizePartLabel(emphasizedPart)}**`)

    // 旧版公众号写作会把金句标题输出成下一行粗体；提升为 H2。
    let j = i + 1
    while (j < source.length && !source[j].trim()) j++
    const next = j < source.length ? source[j].trim() : ''
    const nextBold = unwrapBold(next)
    if (nextBold && !/^PART\s*0*\d+$/i.test(nextBold)) {
      out.push('', `## ${nextBold}`)
      i = j
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function prepareWechatArticle(raw: string): PreparedWechatArticle {
  const clean = stripOuterFence(stripFrontmatter(raw)).replace(/\r\n/g, '\n')
  const lines = clean.split('\n')
  const titlesAt = headingIndex(lines, 'titles')
  const bodyAt = headingIndex(lines, 'body')
  const digestAt = headingIndex(lines, 'digest')
  const recognizedContainer = bodyAt >= 0

  const titleLines = titlesAt >= 0 && bodyAt > titlesAt ? lines.slice(titlesAt + 1, bodyAt) : []
  const bodyEnd = digestAt > bodyAt ? digestAt : lines.length
  let bodyLines = recognizedContainer ? lines.slice(bodyAt + 1, bodyEnd) : lines
  const digestLines = digestAt >= 0 ? lines.slice(digestAt + 1) : []

  // 正文末尾为分隔元信息服务的横线不进入公众号。
  while (
    bodyLines.length &&
    (!bodyLines[bodyLines.length - 1].trim() || bodyLines[bodyLines.length - 1].trim() === '---')
  ) {
    bodyLines.pop()
  }

  return {
    body: normalizePartStructure(bodyLines.join('\n')),
    titleCandidates: extractCandidates(titleLines),
    digest: firstDigest(digestLines),
    recognizedContainer,
  }
}

/** frontmatter 必须永远留在文件第一行；返回正文可插入的第一行索引。 */
export function bodyStartLine(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i].trim())) return i + 1
  }
  return 0
}

/** 按 anchor 回写正文图；定位失败时也只会落在 frontmatter 之后。 */
export function insertEmbeds(content: string, items: EmbedItem[]): { out: string; hits: number; missed: number } {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const start = bodyStartLine(lines)
  const used = new Set<number>()
  const placed: { idx: number; embed: string }[] = []
  const missed: string[] = []

  for (const item of items) {
    const embed = `![[${item.path}]]`
    if (lines.some((line) => line.trim() === embed)) continue
    const anchor = (item.anchor ?? '').trim()
    let idx = -1
    if (anchor.length >= 3) {
      idx = lines.findIndex((line, i) => i >= start && !used.has(i) && line.includes(anchor))
      if (idx < 0) {
        const short = anchor.replace(/[#*\s]/g, '').slice(0, 8)
        if (short.length >= 4) {
          idx = lines.findIndex(
            (line, i) => i >= start && !used.has(i) && line.replace(/[#*\s]/g, '').includes(short),
          )
        }
      }
    }
    if (idx >= 0) {
      used.add(idx)
      placed.push({ idx, embed })
    } else {
      missed.push(embed)
    }
  }

  placed.sort((a, b) => b.idx - a.idx)
  for (const item of placed) lines.splice(item.idx + 1, 0, '', item.embed)

  const safeStart = bodyStartLine(lines)
  if (missed.length > 0) {
    lines.splice(safeStart, 0, '', missed[0], '')
    for (const embed of missed.slice(1)) lines.push('', embed)
  }
  return { out: lines.join('\n'), hits: placed.length, missed: missed.length }
}

export function insertCoverEmbed(content: string, path: string): string {
  const embed = `![[${path}]]`
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.some((line) => line.trim() === embed)) return content
  const start = bodyStartLine(lines)
  lines.splice(start, 0, '', embed, '')
  return lines.join('\n')
}

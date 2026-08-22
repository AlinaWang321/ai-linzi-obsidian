export interface VaultSearchDocument {
  path: string
  filename: string
  text: string
  /** Obsidian file mtime；仅在本地用于“今天/最新”检索，不会发送到服务器。 */
  mtime?: number
}

export interface VaultSearchOptions {
  maxSources?: number
  maxExcerptChars?: number
  maxTotalChars?: number
  excludedPaths?: string[]
  /** 整个文件夹树不参与普通 Vault 搜索，例如用户指定的本地 Skills 根目录。 */
  excludedFolders?: string[]
  /** 只在这些文件夹树内检索；为空时表示整个 Vault。 */
  includedFolders?: string[]
  /** 仅用于可重复测试；生产环境默认使用当前设备时间。 */
  nowMs?: number
  /** 只供 Agent 明确调用 vault_search 使用；允许“小B”这类短代号，自动预扫仍保持四字门槛。 */
  explicit?: boolean
}

export interface VaultSearchResult {
  sourceId: string
  path: string
  filename: string
  excerpt: string
  score: number
}

export interface VaultLocalFact {
  kind: 'consultation-session-count'
  year?: number
  month?: number
  count: number
  text: string
  matchedDocuments: VaultSearchDocument[]
}

export const VAULT_SEARCH_DEFAULTS = {
  maxSources: 6,
  maxExcerptChars: 1_200,
  maxTotalChars: 7_200,
} as const

const GENERIC_QUERY_WORDS = new Set([
  '帮我',
  '请问',
  '一下',
  '这个',
  '那个',
  '怎么',
  '如何',
  '可以',
  '需要',
  '有没有',
  '什么',
  '一下子',
  'the',
  'and',
  'for',
  'with',
  'please',
])

const NO_SEARCH_MESSAGES = new Set([
  '你好',
  '您好',
  '在吗',
  '谢谢',
  '好的',
  '可以',
  '继续',
  '收到',
  'ok',
  'hello',
  'hi',
  'thanks',
  'thank you',
])

export function isVaultSearchPathExcluded(path: string): boolean {
  const normalized = normalizePath(path)
  if (!normalized) return true
  const lower = normalized.toLocaleLowerCase()
  // 本地 Skill 有独立的显式调用通道，不能再被普通 Vault 搜索截成资料片段误送。
  // 新旧两个默认目录都排除（0.7.54：默认目录已改为 05_System/Skills，
  // 只写死旧值等于对新用户完全失效；调用方另有 excludedFolders 传真实设置值）。
  for (const root of ['system/skills', '05_system/skills']) {
    if (lower === root || lower.startsWith(`${root}/`)) return true
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.startsWith('.'))) return true
  if (segments.some((segment) => /^trash$/i.test(segment))) return true
  const filename = segments.at(-1)?.toLocaleLowerCase() ?? ''
  if (['_sub-agent-summaries.md', 'agents.md', 'claude.md'].includes(filename)) return true
  return false
}

export function isPathInsideFolder(path: string, folder: string): boolean {
  const normalizedPath = normalizePath(path).toLocaleLowerCase()
  const normalizedFolder = normalizePath(folder).toLocaleLowerCase()
  return Boolean(
    normalizedPath &&
      normalizedFolder &&
      (normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`)),
  )
}

/**
 * 能由本机文件列表确定回答的统计问题，不交给模型从前几条片段里猜。
 * 覆盖“某年某月有多少场咨询”与“全部有多少场咨询”。优先读取 Vault 内已有的
 * 咨询时间线/汇总真相源；没有汇总时，才按逐字稿文件名和路径全量去重统计。
 */
export function buildVaultLocalFact(
  query: string,
  documents: VaultSearchDocument[],
  excludedPaths: string[] = [],
  nowMs = Date.now(),
): VaultLocalFact | undefined {
  const target = parseConsultationCountQuery(query, nowMs)
  if (!target) return undefined
  const excludedPathSet = new Set(excludedPaths.map(normalizePath))
  const eligibleDocuments = documents.filter((doc) => {
    const path = normalizePath(doc.path)
    return Boolean(path && !excludedPathSet.has(path) && !isVaultSearchPathExcluded(path))
  })
  const summaryFact = buildConsultationSummaryFact(target, eligibleDocuments)
  if (summaryFact) return summaryFact

  const unique = new Map<string, VaultSearchDocument>()
  for (const doc of eligibleDocuments) {
    const path = normalizePath(doc.path)
    if (!path) continue
    if (!isConsultationTranscriptPath(`${doc.path} ${doc.filename}`)) continue
    if (target.privateOnly && !/私教/.test(`${doc.path} ${doc.filename}`.normalize('NFKC'))) {
      continue
    }
    if (
      target.year !== undefined &&
      target.month !== undefined &&
      !pathMatchesYearMonth(`${doc.path} ${doc.filename}`, target.year, target.month)
    ) {
      continue
    }
    const key = consultationSessionKey(doc)
    if (!unique.has(key)) unique.set(key, doc)
  }
  const matchedDocuments = [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const examples = matchedDocuments.slice(0, 8).map((doc) => doc.filename)
  const scopeLabel =
    target.year !== undefined && target.month !== undefined
      ? `${target.year}年${target.month}月`
      : '全部已落盘记录中'
  const categoryLabel = target.privateOnly ? '私教逐字稿' : '咨询逐字稿'
  const exampleText = examples.length > 0 ? ` 命中文件示例：${examples.join('；')}。` : ''
  return {
    kind: 'consultation-session-count',
    year: target.year,
    month: target.month,
    count: matchedDocuments.length,
    text:
      `Vault 本地全量统计：按文件名和路径识别咨询逐字稿并去重，${scopeLabel}共有 ` +
      `${matchedDocuments.length} 场${categoryLabel}。${exampleText}` +
      (target.privateOnly
        ? '该数字只统计文件名或路径明确含“私教”的已落盘逐字稿，不包含测评、普通沟通和未落盘的私教。'
        : '该数字只统计已保存为咨询/私教/测评/访谈/沟通逐字稿或转写稿的文件，不包含未落盘的咨询。'),
    matchedDocuments,
  }
}

interface ConsultationCountTarget {
  year?: number
  month?: number
  privateOnly: boolean
}

function parseConsultationCountQuery(
  query: string,
  nowMs = Date.now(),
): ConsultationCountTarget | undefined {
  const normalized = query.normalize('NFKC')
  if (!/(?:多少|几\s*(?:场|次|份|篇|个)|数量|统计|一共|总共)/.test(normalized)) return undefined
  if (!/(?:咨询|私教|测评|访谈|沟通)/.test(normalized)) return undefined
  const now = new Date(nowMs)
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  const explicitDate = normalized.match(
    /((?:19|20)\d{2})\s*(?:年|[./_-])\s*(1[0-2]|0?[1-9])\s*(?:月|月份)?/,
  )
  const privateOnly = /私教/.test(normalized)
  if (explicitDate) {
    return {
      year: Number(explicitDate[1]),
      month: Number(explicitDate[2]),
      privateOnly,
    }
  }
  if (/(?:上个月|上月)/.test(normalized)) {
    const previous = new Date(currentYear, currentMonth - 2, 1)
    return {
      year: previous.getFullYear(),
      month: previous.getMonth() + 1,
      privateOnly,
    }
  }
  if (/(?:本月|这个月|当月)/.test(normalized)) {
    return { year: currentYear, month: currentMonth, privateOnly }
  }
  const mentionedMonth = normalized.match(
    /(?:^|[^\d])((?:1[0-2]|0?[1-9]))\s*月(?:份)?(?!个)/,
  )
  if (mentionedMonth) {
    const relativeYear = /去年/.test(normalized)
      ? currentYear - 1
      : currentYear
    return { year: relativeYear, month: Number(mentionedMonth[1]), privateOnly }
  }
  if (/去年/.test(normalized)) return { year: currentYear - 1, privateOnly }
  if (/今年/.test(normalized)) return { year: currentYear, privateOnly }
  return { privateOnly }
}

export function isConsultationCountQuestion(query: string, nowMs = Date.now()): boolean {
  return Boolean(parseConsultationCountQuery(query, nowMs))
}

function buildConsultationSummaryFact(
  target: ConsultationCountTarget,
  documents: VaultSearchDocument[],
): VaultLocalFact | undefined {
  const candidates = documents
    .filter((doc) => isConsultationSummaryPath(`${doc.path} ${doc.filename}`))
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
  for (const doc of candidates) {
    let count: number | undefined
    let scopeLabel = '全部记录'
    if (target.privateOnly) {
      const detailRows = doc.text.split('\n').filter((line) => {
        const date = line.match(
          /^\s*\|\s*((?:19|20)\d{2})\.(0?[1-9]|1[0-2])\.(0?[1-9]|[12]\d|3[01])\s*\|/,
        )
        if (!date || !/私教/.test(line)) return false
        return (
          (target.year === undefined || Number(date[1]) === target.year) &&
          (target.month === undefined || Number(date[2]) === target.month)
        )
      })
      const hasDatedDetailRows = /^\s*\|\s*(?:19|20)\d{2}\.\d{1,2}\.\d{1,2}\s*\|/m.test(
        doc.text,
      )
      if (hasDatedDetailRows) count = detailRows.length
      scopeLabel =
        target.year !== undefined && target.month !== undefined
          ? `${target.year}年${target.month}月的明细中`
          : target.year !== undefined
            ? `${target.year}年的明细中`
          : '全部日期明细中'
    } else if (target.year !== undefined && target.month !== undefined) {
      const row = doc.text.match(
        new RegExp(
          `^\\s*\\|\\s*${target.year}\\s*年\\s*0?${target.month}\\s*月\\s*\\|\\s*(\\d+)\\s*\\|`,
          'm',
        ),
      )
      if (row) count = Number(row[1])
      scopeLabel = `${target.year}年${target.month}月`
    } else if (target.year !== undefined) {
      const monthRows = [...doc.text.matchAll(
        new RegExp(
          `^\\s*\\|\\s*${target.year}\\s*年\\s*(?:1[0-2]|0?[1-9])\\s*月\\s*\\|\\s*(\\d+)\\s*\\|`,
          'gm',
        ),
      )]
      if (monthRows.length > 0) {
        count = monthRows.reduce((sum, row) => sum + Number(row[1]), 0)
      }
      scopeLabel = `${target.year}年`
    } else {
      const total = doc.text.match(/总计\s*[：:]?\s*\*{0,2}\s*(\d+)\s*场(?:咨询|私教)/)
      if (total) count = Number(total[1])
    }
    if (!Number.isFinite(count)) continue
    return {
      kind: 'consultation-session-count',
      year: target.year,
      month: target.month,
      count: count as number,
      text:
        `Vault 本地权威汇总：读取「${doc.filename}」，${scopeLabel}共 ${count} 场` +
        (target.privateOnly
          ? '私教。按带日期的明细行中明确含“私教”的记录统计，不包含测评、实操营发售咨询或普通沟通；'
          : '咨询。统计口径包含该时间线汇总中记录的各种咨询类型；') +
        '如汇总文件尚未更新，最新未入档记录不会包含在内。',
      matchedDocuments: [doc],
    }
  }
  return undefined
}

export function isConsultationSummaryPath(value: string): boolean {
  return /咨询时间线.*(?:完整档案|汇总)|(?:咨询|私教).*(?:完整档案|总表|统计汇总)/.test(
    value.normalize('NFKC'),
  )
}

function isConsultationTranscriptPath(value: string): boolean {
  const normalized = normalizeText(value)
  return (
    /逐字稿|转写稿|录音转写/.test(normalized) &&
    /咨询|私教|测评|访谈|沟通/.test(normalized)
  )
}

function pathMatchesYearMonth(value: string, year: number, month: number): boolean {
  const normalized = value.normalize('NFKC').replace(/\\/g, '/')
  const padded = String(month).padStart(2, '0')
  return (
    new RegExp(`(?:^|\\D)${year}${padded}\\d{0,8}(?=\\D|$)`).test(normalized) ||
    new RegExp(`${year}\\s*年\\s*0?${month}\\s*月`).test(normalized) ||
    new RegExp(`${year}[._/-]0?${month}(?:[._/-]|$)`).test(normalized)
  )
}

function consultationSessionKey(doc: VaultSearchDocument): string {
  const basename = doc.filename
    .replace(/\.(?:md|txt|pdf|docx|html?|pptx|xlsx)$/i, '')
    .replace(/[-_\s](?:part\s*)?\d+$/i, '')
    .replace(/[（(]\d+[）)]$/, '')
  const timestamp = basename.match(/(?:19|20)\d{7,12}/)?.[0]
  if (timestamp && timestamp.length > 8) return timestamp
  return normalizeText(basename)
}

export function shouldSearchVault(query: string): boolean {
  const normalized = normalizeText(query)
  if (!normalized || NO_SEARCH_MESSAGES.has(normalized)) return false
  const compact = normalized.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (compact.length < 4) return false
  return buildVaultSearchTerms(query).length > 0
}

export function searchVaultDocuments(
  query: string,
  documents: VaultSearchDocument[],
  options: VaultSearchOptions = {},
): VaultSearchResult[] {
  const normalized = normalizeText(query)
  const terms = buildVaultSearchTerms(query)
  if (options.explicit) {
    if (!normalized || NO_SEARCH_MESSAGES.has(normalized) || terms.length === 0) return []
  } else if (!shouldSearchVault(query)) {
    return []
  }
  const maxSources = clampInt(options.maxSources, 1, 10, VAULT_SEARCH_DEFAULTS.maxSources)
  // 天花板 2026-07-30 从 2000/12000 放宽到 4000/20000(Alina 拍板大幅放宽;
  // 实际生效值由服务端 capabilities 下发,这里只是本地引擎的硬保护)
  const maxExcerptChars = clampInt(
    options.maxExcerptChars,
    240,
    4_000,
    VAULT_SEARCH_DEFAULTS.maxExcerptChars,
  )
  const maxTotalChars = clampInt(
    options.maxTotalChars,
    maxExcerptChars,
    20_000,
    VAULT_SEARCH_DEFAULTS.maxTotalChars,
  )
  const excludedPathSet = new Set((options.excludedPaths ?? []).map(normalizePath))
  const excludedFolders = (options.excludedFolders ?? []).map(normalizePath).filter(Boolean)
  const includedFolders = (options.includedFolders ?? []).map(normalizePath).filter(Boolean)
  const queryPhrase = normalizeText(query).replace(/\s+/g, ' ')
  const querySignals = buildQuerySignals(query, options.nowMs ?? Date.now())
  const eligible = documents.filter(
    (doc) =>
      !excludedPathSet.has(normalizePath(doc.path)) &&
      !excludedFolders.some((folder) => isPathInsideFolder(doc.path, folder)) &&
      (includedFolders.length === 0 ||
        includedFolders.some((folder) => isPathInsideFolder(doc.path, folder))) &&
      !isVaultSearchPathExcluded(doc.path) &&
      Boolean(doc.text.trim()),
  )
  if (eligible.length === 0) return []
  const prepared = eligible.map(prepareDocument)

  const docFrequency = new Map<string, number>()
  for (const term of terms) {
    let count = 0
    for (const doc of prepared) {
      if (doc.path.includes(term) || doc.body.includes(term)) count += 1
    }
    docFrequency.set(term, count)
  }
  const rarePathTerms = terms.filter((term) => {
    if (term.length < 2 || GENERIC_QUERY_WORDS.has(term)) return false
    let pathCount = 0
    for (const doc of prepared) {
      if (doc.title.includes(term) || doc.path.includes(term)) pathCount += 1
    }
    return pathCount > 0 && pathCount <= Math.max(2, Math.ceil(eligible.length * 0.01))
  })

  const ranked = prepared
    .map((doc) =>
      scoreDocument(
        doc,
        terms,
        queryPhrase,
        docFrequency,
        eligible.length,
        rarePathTerms,
        querySignals,
      ),
    )
    .filter((item): item is ScoredDocument => Boolean(item && item.score >= 2.2))
    .sort((left, right) => right.score - left.score || left.doc.path.localeCompare(right.doc.path))

  const results: VaultSearchResult[] = []
  let totalChars = 0
  for (const item of ranked) {
    if (results.length >= maxSources || totalChars >= maxTotalChars) break
    const remaining = maxTotalChars - totalChars
    // buildExcerpt 可能为了标示截断补前后省略号；最后仍必须严格裁到 wire
    // contract 的剩余额度，不能因为 1~2 个标记字符让服务端整轮拒绝。
    const excerpt = buildExcerpt(
      item.doc.text,
      terms,
      Math.min(maxExcerptChars, remaining),
    ).slice(0, remaining)
    if (!excerpt) continue
    results.push({
      sourceId: `V${results.length + 1}`,
      path: item.doc.path,
      filename: item.doc.filename,
      excerpt,
      score: Number(item.score.toFixed(3)),
    })
    totalChars += excerpt.length
  }
  return results
}

interface ScoredDocument {
  doc: VaultSearchDocument
  score: number
}

interface PreparedDocument {
  doc: VaultSearchDocument
  title: string
  path: string
  headings: string
  body: string
}

function prepareDocument(doc: VaultSearchDocument): PreparedDocument {
  return {
    doc,
    title: normalizeText(doc.filename.replace(/\.(?:md|txt|pdf|docx|html?|pptx)$/i, '')),
    path: normalizeText(doc.path),
    headings: normalizeText(
      doc.text
        .split(/\r?\n/)
        .filter((line) => /^#{1,6}\s+/.test(line))
        .join('\n'),
    ),
    body: normalizeText(doc.text),
  }
}

function scoreDocument(
  prepared: PreparedDocument,
  terms: string[],
  queryPhrase: string,
  docFrequency: Map<string, number>,
  totalDocs: number,
  rarePathTerms: string[],
  querySignals: QuerySignals,
): ScoredDocument | null {
  const { doc, title, path, headings, body } = prepared
  let score = 0
  let matchedTerms = 0

  if (queryPhrase.length >= 3) {
    if (title.includes(queryPhrase)) score += 36
    else if (path.includes(queryPhrase)) score += 20
    else if (body.includes(queryPhrase)) score += 10
  }

  for (const term of terms) {
    const df = docFrequency.get(term) ?? 0
    const idf = Math.log(1 + (totalDocs + 1) / (df + 1))
    const titleHits = countOccurrences(title, term)
    const pathHits = countOccurrences(path, term)
    const headingHits = countOccurrences(headings, term)
    const bodyHits = Math.min(countOccurrences(body, term), 8)
    if (titleHits + pathHits + headingHits + bodyHits > 0) matchedTerms += 1
    score += idf * (titleHits * 13 + pathHits * 7 + headingHits * 9 + bodyHits * 1.7)
  }
  // A note that covers several distinct parts of the request should outrank a
  // broadly related note whose title only repeats the topic keyword.
  score += matchedTerms * matchedTerms * 1.25
  // 人名、项目名等稀有词如果明确出现在文件名/路径里，应优先于正文里反复出现
  // “总结、咨询、逐字稿”等泛词的旧材料。
  if (rarePathTerms.length > 0) {
    const rarePathMatches = rarePathTerms.filter(
      (term) => title.includes(term) || path.includes(term),
    ).length
    if (rarePathMatches > 0) score += 180
    else score -= 40
  }
  if (querySignals.todayOrLatest) {
    if (querySignals.localDateTokens.some((token) => path.includes(token))) {
      score += 520
    } else if (isSameLocalDay(doc.mtime, querySignals.nowMs)) {
      score += 300
    } else if (isRecent(doc.mtime, querySignals.nowMs, 3)) {
      score += 90
    }
  }
  if (querySignals.rawFolder && /(?:^|\/)(?:\d+_)?raw(?:\/|$)/i.test(doc.path)) {
    score += 80
  }
  if (querySignals.extension && doc.filename.toLocaleLowerCase().endsWith(`.${querySignals.extension}`)) {
    score += 90
  }

  return score > 0 ? { doc, score } : null
}

interface QuerySignals {
  todayOrLatest: boolean
  rawFolder: boolean
  extension?: 'md' | 'txt' | 'pdf' | 'docx' | 'html' | 'htm' | 'pptx'
  nowMs: number
  localDateTokens: string[]
}

function buildQuerySignals(query: string, nowMs: number): QuerySignals {
  const normalized = normalizeText(query)
  const now = new Date(nowMs)
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const extension = normalized.match(/(?:^|[\s.])(md|txt|pdf|docx|html?|pptx)(?:$|[\s文件文档])/i)?.[1]
    ?.toLocaleLowerCase() as QuerySignals['extension']
  return {
    todayOrLatest: /今天|今日|刚刚|刚才|最新|新加|新增|刚存|刚放|最近一份/.test(normalized),
    rawFolder: /(?:^|[^a-z])raw(?:[^a-z]|$)|原始资料|原始文件/.test(normalized),
    extension,
    nowMs,
    localDateTokens: [
      `${year}${month}${day}`,
      `${year}-${month}-${day}`,
      `${year}.${month}.${day}`,
      `${year}/${month}/${day}`,
    ],
  }
}

function isSameLocalDay(mtime: number | undefined, nowMs: number): boolean {
  if (!Number.isFinite(mtime)) return false
  const left = new Date(mtime as number)
  const right = new Date(nowMs)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function isRecent(mtime: number | undefined, nowMs: number, days: number): boolean {
  if (!Number.isFinite(mtime)) return false
  const age = nowMs - (mtime as number)
  return age >= 0 && age <= days * 24 * 60 * 60 * 1_000
}

function buildExcerpt(text: string, terms: string[], maxChars: number): string {
  if (maxChars < 80) return ''
  const cleaned = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  if (!cleaned) return ''
  const blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  let bestIndex = 0
  let bestScore = -1
  for (let index = 0; index < blocks.length; index++) {
    const normalized = normalizeText(blocks[index])
    const score = terms.reduce(
      (total, term) => total + Math.min(countOccurrences(normalized, term), 4),
      0,
    )
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  const selected: string[] = []
  for (let index = Math.max(0, bestIndex - 1); index < blocks.length; index++) {
    const candidate = selected.length === 0
      ? blocks[index]
      : `${selected.join('\n\n')}\n\n${blocks[index]}`
    if (candidate.length > maxChars) break
    selected.push(blocks[index])
    if (index >= bestIndex + 1) break
  }
  const joined = selected.join('\n\n') || blocks[bestIndex] || cleaned
  if (joined.length <= maxChars) return joined
  const firstMatch = earliestMatch(joined, terms)
  const start = Math.max(0, firstMatch - Math.floor(maxChars * 0.3))
  const clipped = joined.slice(start, start + maxChars)
  return `${start > 0 ? '…' : ''}${clipped}${start + maxChars < joined.length ? '…' : ''}`
}

/** 单独出现时没有检索价值的单字；作为混合词的一部分（如「小B」）仍然保留。 */
const GENERIC_SINGLE_HAN = new Set([
  '的', '了', '和', '与', '或', '在', '是', '有', '个', '把', '给', '到', '从', '被',
  '我', '你', '他', '她', '它', '们', '这', '那', '里', '中', '上', '下', '内', '外',
])

export function buildVaultSearchTerms(query: string): string[] {
  const normalized = normalizeText(query)
  const terms = new Set<string>()
  // 2026-08-19 修复：旧正则要求英文 ≥2 字符、中文 ≥2 连续汉字，于是「小B」「小A」这类
  // 中英混合短代号被整条丢弃 → terms 为空 → 搜索必然返回 0 个结果（Alina 实测：搜「小B」
  // 0 条，但搜「小B 顾晓菲 沈立冬」有 8 条，正是因为后者靠另外两个名字才凑出了 term）。
  // 客户代号、单字人名、缩写在真实使用里非常普遍，必须能搜到。
  // 现在：中英混合整体成词（小b）、单个汉字也保留、单字母/数字仅在与其他字符相连时保留。
  const tokenPattern = /[\p{Script=Han}]+[a-z0-9._-]+|[a-z0-9._-]+[\p{Script=Han}]+|[a-z0-9][a-z0-9._-]*|[\p{Script=Han}]+/gu
  const addToken = (token: string) => {
    if (GENERIC_QUERY_WORDS.has(token)) return
    // 单个泛用汉字（的/了/和…）单独出现时没有检索价值，只在混合词里才保留
    if (/^[\p{Script=Han}]$/u.test(token) && GENERIC_SINGLE_HAN.has(token)) return
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 12) terms.add(token)
      for (let index = 0; index < token.length - 1; index++) {
        const bigram = token.slice(index, index + 2)
        if (!GENERIC_QUERY_WORDS.has(bigram)) terms.add(bigram)
      }
    } else {
      terms.add(token)
    }
  }
  for (const token of normalized.match(tokenPattern) ?? []) {
    // 「20260818日期的obsidian课程逐字稿」旧实现会被正则吞成一个
    // 超长混合词，路径中当然不存在这一整串，所以精确日期也会搜索为空。
    // 短代号（小B）仍保留整体；超长中英数字连写则拆成各脚本连续段。
    const runs = token.match(/[a-z0-9][a-z0-9._-]*|[\p{Script=Han}]+/gu) ?? [token]
    if (runs.length === 1 || token.length <= 16) addToken(token)
    if (runs.length > 1) {
      for (const run of runs) addToken(run)
    }
  }
  return [...terms].slice(0, 24)
}

function earliestMatch(text: string, terms: string[]): number {
  const normalized = normalizeText(text)
  let earliest = 0
  let found = false
  for (const term of terms) {
    const index = normalized.indexOf(term)
    if (index < 0) continue
    if (!found || index < earliest) earliest = index
    found = true
  }
  return found ? earliest : 0
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0
  let count = 0
  let offset = 0
  while (count < 20) {
    const index = text.indexOf(term, offset)
    if (index < 0) break
    count += 1
    offset = index + Math.max(1, term.length)
  }
  return count
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value as number)))
}

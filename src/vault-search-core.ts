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
  /** 仅用于可重复测试；生产环境默认使用当前设备时间。 */
  nowMs?: number
}

export interface VaultSearchResult {
  sourceId: string
  path: string
  filename: string
  excerpt: string
  score: number
}

export interface VaultLocalFact {
  kind: 'monthly-consultation-transcript-count'
  year: number
  month: number
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
  if (lower === 'system/skills' || lower.startsWith('system/skills/')) return true
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
 * 当前只覆盖“某年某月有多少场咨询逐字稿”；没有日期或统计意图时返回 undefined。
 */
export function buildVaultLocalFact(
  query: string,
  documents: VaultSearchDocument[],
  excludedPaths: string[] = [],
): VaultLocalFact | undefined {
  const target = parseMonthlyConsultationCountQuery(query)
  if (!target) return undefined
  const excludedPathSet = new Set(excludedPaths.map(normalizePath))
  const unique = new Map<string, VaultSearchDocument>()
  for (const doc of documents) {
    const path = normalizePath(doc.path)
    if (!path || excludedPathSet.has(path) || isVaultSearchPathExcluded(path)) continue
    if (!isConsultationTranscriptPath(`${doc.path} ${doc.filename}`)) continue
    if (!pathMatchesYearMonth(`${doc.path} ${doc.filename}`, target.year, target.month)) continue
    const key = consultationSessionKey(doc)
    if (!unique.has(key)) unique.set(key, doc)
  }
  const matchedDocuments = [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const examples = matchedDocuments.slice(0, 8).map((doc) => doc.filename)
  const monthLabel = `${target.year}年${target.month}月`
  const exampleText = examples.length > 0 ? ` 命中文件示例：${examples.join('；')}。` : ''
  return {
    kind: 'monthly-consultation-transcript-count',
    year: target.year,
    month: target.month,
    count: matchedDocuments.length,
    text:
      `Vault 本地统计：按文件名和路径中的日期识别并去重，${monthLabel}共有 ` +
      `${matchedDocuments.length} 场咨询逐字稿。${exampleText}` +
      '该数字只统计已保存为咨询/私教/测评/访谈/沟通逐字稿或转写稿的文件，不包含未落盘的咨询。',
    matchedDocuments,
  }
}

function parseMonthlyConsultationCountQuery(
  query: string,
): { year: number; month: number } | undefined {
  const normalized = query.normalize('NFKC')
  const date = normalized.match(/((?:19|20)\d{2})\s*(?:年|[./_-])\s*(1[0-2]|0?[1-9])\s*(?:月|月份)?/)
  if (!date) return undefined
  if (!/(?:多少|几\s*(?:场|次|份|篇|个)|数量|统计|一共|总共)/.test(normalized)) return undefined
  if (!/(?:咨询|私教|测评|访谈|沟通)/.test(normalized)) return undefined
  return { year: Number(date[1]), month: Number(date[2]) }
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
    .replace(/\.(?:md|txt|pdf|docx)$/i, '')
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
  return buildSearchTerms(query).length > 0
}

export function searchVaultDocuments(
  query: string,
  documents: VaultSearchDocument[],
  options: VaultSearchOptions = {},
): VaultSearchResult[] {
  if (!shouldSearchVault(query)) return []
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
  const terms = buildSearchTerms(query)
  const queryPhrase = normalizeText(query).replace(/\s+/g, ' ')
  const querySignals = buildQuerySignals(query, options.nowMs ?? Date.now())
  const eligible = documents.filter(
    (doc) =>
      !excludedPathSet.has(normalizePath(doc.path)) &&
      !excludedFolders.some((folder) => isPathInsideFolder(doc.path, folder)) &&
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
    title: normalizeText(doc.filename.replace(/\.(?:md|txt|pdf|docx)$/i, '')),
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
  extension?: 'md' | 'txt' | 'pdf' | 'docx'
  nowMs: number
  localDateTokens: string[]
}

function buildQuerySignals(query: string, nowMs: number): QuerySignals {
  const normalized = normalizeText(query)
  const now = new Date(nowMs)
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const extension = normalized.match(/(?:^|[\s.])(md|txt|pdf|docx)(?:$|[\s文件文档])/i)?.[1]
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

function buildSearchTerms(query: string): string[] {
  const normalized = normalizeText(query)
  const terms = new Set<string>()
  for (const token of normalized.match(/[a-z0-9][a-z0-9._-]{1,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (GENERIC_QUERY_WORDS.has(token)) continue
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

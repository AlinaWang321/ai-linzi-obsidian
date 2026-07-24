export interface VaultSearchDocument {
  path: string
  filename: string
  text: string
}

export interface VaultSearchOptions {
  maxSources?: number
  maxExcerptChars?: number
  maxTotalChars?: number
  excludedFolders?: string[]
  excludedPaths?: string[]
}

export interface VaultSearchResult {
  sourceId: string
  path: string
  filename: string
  excerpt: string
  score: number
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

export function normalizeVaultFolderExclusions(value: string | string[]): string[] {
  const raw = Array.isArray(value) ? value : value.split(/[\n,，]+/)
  return [...new Set(
    raw
      .map((item) => normalizePath(item))
      .filter(Boolean)
      .map((item) => item.replace(/\/+$/, '')),
  )]
}

export function isVaultSearchPathExcluded(path: string, excludedFolders: string[] = []): boolean {
  const normalized = normalizePath(path)
  if (!normalized || normalized.includes('㊙️')) return true
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.startsWith('.'))) return true
  if (segments.some((segment) => /^trash$/i.test(segment))) return true
  return normalizeVaultFolderExclusions(excludedFolders).some(
    (folder) => normalized === folder || normalized.startsWith(`${folder}/`),
  )
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
  const maxExcerptChars = clampInt(
    options.maxExcerptChars,
    240,
    2_000,
    VAULT_SEARCH_DEFAULTS.maxExcerptChars,
  )
  const maxTotalChars = clampInt(
    options.maxTotalChars,
    maxExcerptChars,
    12_000,
    VAULT_SEARCH_DEFAULTS.maxTotalChars,
  )
  const excludedPathSet = new Set((options.excludedPaths ?? []).map(normalizePath))
  const terms = buildSearchTerms(query)
  const queryPhrase = normalizeText(query).replace(/\s+/g, ' ')
  const eligible = documents.filter(
    (doc) =>
      !excludedPathSet.has(normalizePath(doc.path)) &&
      !isVaultSearchPathExcluded(doc.path, options.excludedFolders) &&
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

  const ranked = prepared
    .map((doc) => scoreDocument(doc, terms, queryPhrase, docFrequency, eligible.length))
    .filter((item): item is ScoredDocument => Boolean(item && item.score >= 2.2))
    .sort((left, right) => right.score - left.score || left.doc.path.localeCompare(right.doc.path))

  const results: VaultSearchResult[] = []
  let totalChars = 0
  for (const item of ranked) {
    if (results.length >= maxSources || totalChars >= maxTotalChars) break
    const remaining = maxTotalChars - totalChars
    const excerpt = buildExcerpt(item.doc.text, terms, Math.min(maxExcerptChars, remaining))
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
    title: normalizeText(doc.filename.replace(/\.md$/i, '')),
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

  return score > 0 ? { doc, score } : null
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

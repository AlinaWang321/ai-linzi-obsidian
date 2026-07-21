export interface NotePatchOperation {
  /** 必须是当前笔记正文里可精确匹配的连续原文，不能写省略号。 */
  old: string
  /** 应替换成的最终文字；空字符串表示删除。 */
  new: string
  /** 仅用户明确要求“全部/统一替换”时为 true。 */
  all?: boolean
  reason?: string
}

export interface ParsedNotePatch {
  displayText: string
  operations: NotePatchOperation[]
}

export interface ApplyNotePatchResult {
  content: string
  replacements: number
  alreadyApplied: number
}

const PATCH_OPEN = '<AI_LINZI_NOTE_PATCH>'
const PATCH_CLOSE = '</AI_LINZI_NOTE_PATCH>'
const MAX_OPERATIONS = 30
const MAX_TEXT_LENGTH = 12_000

/**
 * 只把明确针对当前文章/笔记的编辑指令送进局部修改协议。
 * 普通讨论（例如“产品应该怎么调整”）不会因为出现“调整”两个字而误触发。
 */
export function isNoteEditIntent(text: string): boolean {
  const input = text.trim()
  if (!input) return false
  const editVerb = '(?:修改|改成|改为|换成|替换|删除|删掉|加入|加上|补充|润色|调整|统一|纠正|修正|改写|编辑)'
  const noteTarget = '(?:当前笔记|这篇(?:文章)?|本文|文章|正文|内容|标题|段落|文字|用词)'
  return (
    new RegExp(`${noteTarget}[\\s\\S]{0,40}${editVerb}`).test(input) ||
    new RegExp(`${editVerb}[\\s\\S]{0,40}${noteTarget}`).test(input) ||
    /(?:把|将)[\s\S]{1,100}(?:改成|改为|换成|替换为|删除|删掉|加上|加入)/.test(input)
  )
}

function stripOptionalCodeFence(value: string): string {
  const trimmed = value.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

/** 从 AI 回复中解析受控补丁；格式不完整时返回 null，绝不猜测修改位置。 */
export function parseNotePatch(text: string): ParsedNotePatch | null {
  const start = text.indexOf(PATCH_OPEN)
  const end = text.indexOf(PATCH_CLOSE, start + PATCH_OPEN.length)
  if (start < 0 || end < 0) return null

  const rawJson = stripOptionalCodeFence(text.slice(start + PATCH_OPEN.length, end))
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rawOperations = (parsed as { operations?: unknown }).operations
  if (!Array.isArray(rawOperations) || rawOperations.length === 0 || rawOperations.length > MAX_OPERATIONS) {
    return null
  }

  const operations: NotePatchOperation[] = []
  for (const item of rawOperations) {
    if (!item || typeof item !== 'object') return null
    const candidate = item as Record<string, unknown>
    if (typeof candidate.old !== 'string' || typeof candidate.new !== 'string') return null
    const oldText = candidate.old
    const newText = candidate.new
    if (!oldText || oldText === newText) continue
    if (oldText.length > MAX_TEXT_LENGTH || newText.length > MAX_TEXT_LENGTH) return null
    operations.push({
      old: oldText,
      new: newText,
      all: candidate.all === true,
      reason: typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 300) : undefined,
    })
  }
  if (operations.length === 0) return null

  const before = text.slice(0, start).trim()
  const after = text.slice(end + PATCH_CLOSE.length).trim()
  return {
    displayText: [before, after].filter(Boolean).join('\n\n') || `已标出 ${operations.length} 处修改。`,
    operations,
  }
}

/** 保存补丁回复为普通 Markdown 笔记时，输出人能读懂的修改清单，不落内部 JSON。 */
export function formatNotePatchMarkdown(patch: ParsedNotePatch): string {
  const blocks = patch.operations.map((op, index) => {
    const reason = op.reason ? `\n\n修改说明：${op.reason}` : ''
    const scope = op.all ? '\n\n应用范围：全文全部匹配处' : ''
    return `### 修改 ${index + 1}\n\n原文：\n\n> ${op.old.replace(/\n/g, '\n> ')}\n\n改为：\n\n> ${op.new.replace(/\n/g, '\n> ')}${reason}${scope}`
  })
  return `${patch.displayText}\n\n## 修改清单\n\n${blocks.join('\n\n---\n\n')}`.trim()
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)
  return match ? { frontmatter: match[0], body: content.slice(match[0].length) } : { frontmatter: '', body: content }
}

/**
 * 找出尚未被 new 包裹/替换的 old。典型场景：AI霖子 → 「AI霖子」。
 * 已经是「AI霖子」的位置会跳过，重复点击按钮不会变成「「AI霖子」」。
 */
function eligibleMatches(source: string, oldText: string, newText: string): number[] {
  const positions: number[] = []
  const oldInsideNewAt = newText.indexOf(oldText)
  const prefix = oldInsideNewAt >= 0 ? newText.slice(0, oldInsideNewAt) : ''
  const suffix = oldInsideNewAt >= 0 ? newText.slice(oldInsideNewAt + oldText.length) : ''
  let from = 0
  while (from <= source.length - oldText.length) {
    const at = source.indexOf(oldText, from)
    if (at < 0) break
    const alreadyWrapped =
      oldInsideNewAt >= 0 &&
      source.slice(Math.max(0, at - prefix.length), at) === prefix &&
      source.slice(at + oldText.length, at + oldText.length + suffix.length) === suffix
    if (!alreadyWrapped) positions.push(at)
    from = at + Math.max(1, oldText.length)
  }
  return positions
}

function replaceAtPositions(source: string, positions: number[], oldText: string, newText: string): string {
  let output = source
  for (let i = positions.length - 1; i >= 0; i--) {
    const at = positions[i]
    output = output.slice(0, at) + newText + output.slice(at + oldText.length)
  }
  return output
}

/**
 * 原子地把局部补丁应用到正文。任何一项无法精确定位，整组修改都会抛错并保持原文不变。
 * frontmatter 永远原样保留。
 */
export function applyNotePatch(content: string, patch: ParsedNotePatch): ApplyNotePatchResult {
  const { frontmatter, body } = splitFrontmatter(content)
  let draft = body
  let replacements = 0
  let alreadyApplied = 0

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i]
    const matches = eligibleMatches(draft, op.old, op.new)
    if (op.all) {
      if (matches.length === 0) {
        if (op.new && draft.includes(op.new)) {
          alreadyApplied += 1
          continue
        }
        throw new Error(`第 ${i + 1} 处修改找不到原文，笔记未写入。请让 AI 重新读取当前笔记后再改。`)
      }
      draft = replaceAtPositions(draft, matches, op.old, op.new)
      replacements += matches.length
      continue
    }

    if (matches.length === 0) {
      if (op.new && draft.includes(op.new)) {
        alreadyApplied += 1
        continue
      }
      throw new Error(`第 ${i + 1} 处修改找不到原文，笔记未写入。请让 AI 重新读取当前笔记后再改。`)
    }
    if (matches.length > 1) {
      throw new Error(`第 ${i + 1} 处原文出现了 ${matches.length} 次，无法安全定位，笔记未写入。请让 AI 多引用一些上下文。`)
    }
    draft = replaceAtPositions(draft, matches, op.old, op.new)
    replacements += 1
  }

  return { content: frontmatter + draft, replacements, alreadyApplied }
}

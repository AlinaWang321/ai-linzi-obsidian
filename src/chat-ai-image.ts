export type ChatAiImageRatio = '2.35:1' | '16:9' | '3:4' | '1:1'

export interface ChatAiImageRequest {
  label: string
  instruction: string
  ratio: ChatAiImageRatio
  editPreviousImage: boolean
  /** 修改已有图片时，用户没有明确要求换画幅就保持原比例。 */
  preserveOriginalRatio: boolean
}

export interface ChatAiImageExtraction {
  cleanText: string
  requests: ChatAiImageRequest[]
  invalid: boolean
}

export const CHAT_AI_IMAGE_REQUEST_START = '<<<AI_LINZI_IMAGE_REQUEST>>>'
export const CHAT_AI_IMAGE_MAX_REQUESTS = 6

const BLOCK_RE =
  /<<<AI_LINZI_IMAGE_REQUEST>>>\s*([\s\S]*?)\s*<<<AI_LINZI_IMAGE_REQUEST_END>>>/g

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function ratio(value: unknown): ChatAiImageRatio {
  return value === '2.35:1' || value === '3:4' || value === '1:1' ? value : '16:9'
}

function clean(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Luna 只负责提出结构化图片请求；真正的图片调用仍由插件通过私有后端逐张执行。
 * 任何格式不完整的请求都会被标记为 invalid，不能静默执行或猜参数。
 */
export function extractChatAiImageRequests(value: string): ChatAiImageExtraction {
  const requests: ChatAiImageRequest[] = []
  let invalid = false
  let blockCount = 0
  let cleanText = value.replace(BLOCK_RE, (_block, rawJson: string) => {
    blockCount += 1
    if (blockCount > 1) {
      invalid = true
      return ''
    }
    try {
      const parsed = JSON.parse(rawJson) as { requests?: unknown }
      if (!Array.isArray(parsed.requests) || parsed.requests.length === 0) {
        invalid = true
        return ''
      }
      if (parsed.requests.length > CHAT_AI_IMAGE_MAX_REQUESTS) invalid = true
      for (const [index, raw] of parsed.requests.slice(0, CHAT_AI_IMAGE_MAX_REQUESTS).entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          invalid = true
          continue
        }
        const item = raw as Record<string, unknown>
        const instruction = text(item.instruction, 1_200)
        if (instruction.length < 2) {
          invalid = true
          continue
        }
        const editPreviousImage = item.editPreviousImage === true
        requests.push({
          label: text(item.label, 40) || `图片 ${index + 1}`,
          instruction,
          ratio: ratio(item.ratio),
          editPreviousImage,
          preserveOriginalRatio:
            editPreviousImage && item.preserveOriginalRatio !== false,
        })
      }
    } catch {
      invalid = true
    }
    return ''
  })

  // 流被截断或模型漏了结束标记时，隐藏协议残片，但绝不执行半截 JSON。
  const hangingAt = cleanText.indexOf(CHAT_AI_IMAGE_REQUEST_START)
  if (hangingAt >= 0) {
    cleanText = cleanText.slice(0, hangingAt)
    invalid = true
  }

  return { cleanText: clean(cleanText), requests, invalid }
}

export function isDirectAiImageRequest(value: string): boolean {
  const textValue = value.trim()
  if (!textValue) return false
  if (/(?:当前|这篇|整篇)?(?:文章|正文|笔记|公众号)[^。！？!?\n]{0,12}(?:配图|插图)/.test(textValue)) {
    return false
  }
  if (
    /(?:讨论|聊聊|建议|思路|怎么设计|如何设计|应该怎么)/.test(textValue) &&
    !/(?:生成|生图|画|绘制|做成|做一|做个|出图|制作|渲染)/.test(textValue)
  ) {
    return false
  }
  const action = /(?:生成|生图|画|绘制|做成|做一|做个|出一|出图|设计|制作|渲染|改图|改成|改为|修改|修正|重做|换成|调整)/.test(textValue)
  const visual = /(?:小红书|rednote|卡片|轮播图|海报|长图|封面|图片|图像|视觉图|配图|插画|上一张|这张图|第[一二三四五六\d]+张)/i.test(textValue)
  return action && visual
}

export function isDirectAiImageEditRequest(value: string): boolean {
  const target = /(?:上一张|刚才那张|这张(?:图|卡片|海报)?|第[一二三四五六\d]+张)(?:图|图片|卡片|海报)?/.test(value)
  const edit = /(?:修改|改成|改为|换成|调整|重做|重新生成|修正|去掉|删除|缩小|放大|移到|保留)/.test(value)
  return target && edit
}

export function requestedAiImageIndex(value: string): number | null {
  const match = /第\s*([一二三四五六\d]+)\s*张/.exec(value)
  if (!match) return null
  const chinese: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  }
  const parsed = chinese[match[1]] ?? Number.parseInt(match[1], 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= CHAT_AI_IMAGE_MAX_REQUESTS
    ? parsed
    : null
}

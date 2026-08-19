/**
 * 对话框拖拽与粘贴附件的纯逻辑（0.7.57）。
 *
 * 目标：截图后直接 Cmd+V、文件直接拖进对话框，不必再走「📎 → 选来源 → 弹窗挑文件」。
 * 这里只做分类与校验，不碰 DOM、不认识 Obsidian；读文件与落附件由 UI 层完成，
 * 因此每一条规则都能被 scripts/test-chat-drop.mjs 真跑验证。
 */

/** 与主对话图片附件一致：服务端只接受这三种，且单次最多 3 张。 */
export const DROP_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
/** 能在本机抽出文字、可作为「精确授权资料」的文档类型。 */
export const DROP_DOCUMENT_EXTENSIONS = new Set(['md', 'txt', 'pdf', 'docx', 'html', 'htm', 'pptx', 'xlsx'])
export const DROP_MAX_IMAGES = 3
/** 单张图片上限；服务端 dataUrl 上限 200 万字符，base64 膨胀约 1.37 倍，留足余量。 */
export const DROP_IMAGE_MAX_BYTES = 8 * 1024 * 1024

export type DroppedKind = 'image' | 'document' | 'unsupported'

export function extensionOf(name: string): string {
  const trimmed = name.trim().toLocaleLowerCase()
  const dot = trimmed.lastIndexOf('.')
  return dot > 0 ? trimmed.slice(dot + 1) : ''
}

export function classifyDropped(name: string, mimeType = ''): DroppedKind {
  const ext = extensionOf(name)
  if (DROP_IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (DROP_DOCUMENT_EXTENSIONS.has(ext)) return 'document'
  // 剪贴板里的截图往往没有文件名，只能靠 MIME 判定。
  const mime = mimeType.trim().toLocaleLowerCase()
  if (mime.startsWith('image/')) {
    return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp'
      ? 'image'
      : 'unsupported'
  }
  return 'unsupported'
}

export interface DropCandidate {
  name: string
  mimeType?: string
  size?: number
  /** Vault 内文件才有；从 Finder 拖进来的没有。 */
  vaultPath?: string
  /** 对应 dataTransfer.files 的稳定位置；同名文件也不能串到第一份。 */
  sourceIndex?: number
}

export interface DropPlan {
  images: DropCandidate[]
  documents: DropCandidate[]
  /** 每条都是要原样展示给用户的中文说明，说明为什么某个文件没被接受。 */
  rejections: string[]
}

/**
 * 把一批拖入/粘贴的文件分成「图片附件」和「资料文件」，并给出人话拒绝理由。
 *
 * 规则：
 * - 图片总数（已有 + 新增）不超过 3 张，超出的逐个说明被跳过；
 * - 单张图片超过 8MB 拒绝（避免请求被服务端整单拒收）；
 * - 一般资料文件必须在 Vault 内；.xlsx 是唯一例外，可从电脑直接上传并在本机解析，
 *   原文件不会发到云端；
 * - 不认识的类型直接说明，不静默丢弃。
 */
export function planDroppedFiles(
  candidates: DropCandidate[],
  existingImageCount: number,
): DropPlan {
  const plan: DropPlan = { images: [], documents: [], rejections: [] }
  let imageSlots = Math.max(0, DROP_MAX_IMAGES - existingImageCount)
  for (const candidate of candidates) {
    const label = candidate.name || '这张图片'
    const kind = classifyDropped(candidate.name, candidate.mimeType)
    if (kind === 'image') {
      if (typeof candidate.size === 'number' && candidate.size > DROP_IMAGE_MAX_BYTES) {
        plan.rejections.push(
          `${label} 超过 ${Math.round(DROP_IMAGE_MAX_BYTES / 1024 / 1024)}MB，请压缩后再试`,
        )
        continue
      }
      if (imageSlots <= 0) {
        plan.rejections.push(`${label} 已跳过：主对话单次最多 ${DROP_MAX_IMAGES} 张图片`)
        continue
      }
      imageSlots -= 1
      plan.images.push(candidate)
      continue
    }
    if (kind === 'document') {
      if (!candidate.vaultPath && extensionOf(candidate.name) !== 'xlsx') {
        plan.rejections.push(`${label} 不在知识库里，请先把文件放进 Obsidian 库再拖进来`)
        continue
      }
      plan.documents.push(candidate)
      continue
    }
    plan.rejections.push(
      extensionOf(candidate.name) === 'xls'
        ? `${label} 是旧版 Excel .xls，请先在 Excel 中“另存为” .xlsx`
        : `${label} 暂不支持：图片支持 PNG/JPG/WebP，资料支持 MD/TXT/PDF/DOCX/HTML/PPTX/XLSX`,
    )
  }
  return plan
}

/** 附加成功后的一句话回执；没有任何成功项时返回空串（此时只报拒绝理由）。 */
export function dropSummary(plan: DropPlan): string {
  const parts: string[] = []
  if (plan.images.length > 0) parts.push(`${plan.images.length} 张图片`)
  if (plan.documents.length > 0) parts.push(`${plan.documents.length} 份资料`)
  return parts.length > 0 ? `已添加 ${parts.join(' 和 ')}` : ''
}

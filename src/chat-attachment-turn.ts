export interface AttachmentTurnSummary {
  imageCount: number
  vaultFileCount: number
  computerSpreadsheetCount: number
  longDocumentCount: number
}

export function attachmentTurnCount(summary: AttachmentTurnSummary): number {
  return Math.max(0, summary.imageCount) +
    Math.max(0, summary.vaultFileCount) +
    Math.max(0, summary.computerSpreadsheetCount) +
    Math.max(0, summary.longDocumentCount)
}

/**
 * 用户可以像普通聊天工具一样只发附件。
 *
 * 自动补上的文字只描述「如何继续对话」，不包含文件名、Vault 路径或正文；
 * 因此可以安全进入聊天历史，而附件数据仍然只在当前请求使用。
 */
export function buildAttachmentOnlyTurnText(summary: AttachmentTurnSummary): string {
  const parts: string[] = []
  if (summary.imageCount > 0) parts.push(`${summary.imageCount} 张图片`)
  const documentCount = summary.vaultFileCount + summary.computerSpreadsheetCount
  if (documentCount > 0) parts.push(`${documentCount} 份资料`)
  if (summary.longDocumentCount > 0) parts.push(`${summary.longDocumentCount} 份长文`)
  if (parts.length === 0) return ''
  return (
    `我发送了${parts.join('和')}。` +
    '请结合当前对话理解这些附件：如果上下文已经有明确任务，直接继续完成；' +
    '如果还没有明确任务，先简要说明你识别到的关键信息，再问我想怎么处理。'
  )
}

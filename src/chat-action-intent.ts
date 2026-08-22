/**
 * 主对话里的确定性本机动作意图。
 *
 * 这些动作不能只靠模型“理解”：一旦识别成功，插件会锁定当前来源并走专用
 * 确认/持久化协议。普通讨论不得误触发。
 */

export function explicitMemoryContent(text: string): string | undefined {
  const input = text.normalize('NFKC').trim()
  const prefix = /^(?:AI\s*霖子[，,:：\s]*)?(?:(?:请\s*)?(?:麻烦|帮我)?\s*)?(?:记住|记一下|记下来|存入事实记忆|保存到事实记忆)[，,:：\s]*([\s\S]+)$/iu.exec(input)
  const ba = /^(?:AI\s*霖子[，,:：\s]*)?(?:(?:请\s*)?(?:麻烦|帮我)?\s*)?把\s*([\s\S]+?)\s*(?:记住|记下来|存入事实记忆|保存到事实记忆)[。.!！]?$/iu.exec(input)
  const suffix = /^([\s\S]+?)[，,；;\s]+(?:(?:请\s*)?(?:(?:麻烦|帮我)\s*)?)(?:记住|记一下|记下来|存入事实记忆|保存到事实记忆)[。.!！]?$/iu.exec(input)
  const content = (prefix?.[1] ?? ba?.[1] ?? suffix?.[1])?.trim()
  return content && content.length >= 2 ? content.slice(0, 2_000) : undefined
}

export function isCurrentNoteKnowledgeSaveIntent(text: string): boolean {
  const normalized = text.normalize('NFKC').trim()
  // 这是一个会立即打开本机写入流程的快捷意图，只接受用户能直接说出的短句。
  // Skill Studio 的内部提示词同时包含“当前笔记”“知识库”“写入”，但它是多行
  // 生成协议，不是用户要求保存当前笔记；若只做三个关键词的全局 AND，会把创建
  // Skill 的请求错误劫持到“存入知识库”弹窗。
  if (!normalized || normalized.length > 240 || /[\r\n]/u.test(normalized)) return false
  const input = normalized.replace(/\s+/g, '')
  return /(?:把|将|请把|请将)?(?:当前|这篇|这份|这个|正在打开的|刚打开的).{0,16}(?:笔记|文章|文档|文件|内容).{0,24}(?:存入|保存到|加入|沉淀到|写入|喂给|喂入).{0,12}(?:AI霖子)?知识库[。.!！]?$/u.test(
    input,
  )
}

export function isFullCurrentNoteReplaceIntent(text: string): boolean {
  const input = text.normalize('NFKC').replace(/\s+/g, '')
  const currentTarget =
    /(?:当前|这篇|这份|这个|正在打开的|刚打开的).{0,8}(?:笔记|文章|文档|文件|正文|内容)/u.test(input)
  const replySource =
    /(?:刚才|刚刚|上面|上一条|这条|当前|最终|定稿|这一版|这版).{0,12}(?:回复|内容|版本|全文|成稿)|(?:用|拿)(?:刚才|刚刚|上面|上一条|这条|这一版|这版)/u.test(
      input,
    )
  const replaceAction = /(?:覆盖|替换全文|整篇替换|写回|更新到|更新进)/u.test(input)
  return currentTarget && replySource && replaceAction
}

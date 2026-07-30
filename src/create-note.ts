/**
 * 对话直接创建笔记 · 标记块协议(v0.6.34,2026-07-30 Alina 拍板「对话操作 vault 文件」v1)
 *
 * 服务端在渠道指令里教模型输出:
 *   <<<新建笔记 标题=xxx>>>
 *   (正文 markdown)
 *   <<<新建笔记结束>>>
 * 插件把标记块从展示文本中剥离,渲染成确认卡;用户点击后才通过 actions.writeOutput
 * 落盘(白名单输出文件夹/日期前缀/只新建不覆盖/frontmatter 标来源)。
 * 安全边界:标题在这里净化(去路径字符),路径由 writeOutput 统一拼装,模型永远碰不到路径。
 */

export interface CreateNoteBlock {
  title: string
  body: string
}

export interface CreateNoteExtraction {
  cleanText: string
  blocks: CreateNoteBlock[]
}

/** 单条回复最多接受的新建笔记块(与服务端指令一致) */
export const CREATE_NOTE_MAX_BLOCKS = 3

const BLOCK_RE = /<<<新建笔记\s+标题=([^>\n]{1,80})>>>\r?\n?([\s\S]*?)\r?\n?<<<新建笔记结束>>>/g

/** 标题净化:去掉路径/frontmatter 危险字符,限长(与服务端指令的字符集一致) */
export function sanitizeNoteTitle(raw: string): string {
  // 顺序要点:先把危险字符换成空格并折叠,再剥「前导点+空格」——
  // 否则 `../../etc/passwd` 这类输入折叠后会重新以点开头(隐藏文件),测试 4 抓过这个 bug。
  return raw
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 60)
    .trim()
}

/** 从助手回复中提取新建笔记块;展示文本剥离标记,超出上限的块忽略 */
export function extractCreateNoteBlocks(text: string): CreateNoteExtraction {
  const blocks: CreateNoteBlock[] = []
  const cleanText = text
    .replace(BLOCK_RE, (_match, rawTitle: string, rawBody: string) => {
      if (blocks.length < CREATE_NOTE_MAX_BLOCKS) {
        const title = sanitizeNoteTitle(rawTitle)
        const body = rawBody.trim()
        if (title && body) blocks.push({ title, body })
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, blocks }
}

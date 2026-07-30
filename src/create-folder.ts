/**
 * 对话直接创建文件夹 · 标记块协议(v0.6.42,2026-07-30 Alina 拍板)
 *
 * 目标场景:打卡营 Day 1,学员对 AI霖子说「帮我搭好知识库框架」→ 确认卡列出
 * inbox/raw/wiki/output 等目录 → 点击一次全部建好,驾驶舱第二大脑当场亮起。
 *
 * 服务端渠道指令教模型输出(每行一个路径):
 *   <<<新建文件夹>>>
 *   inbox
 *   raw/逐字稿
 *   <<<新建文件夹结束>>>
 * 插件剥离标记渲染确认卡;**用户点击后才**逐级 vault.createFolder(已存在跳过)。
 * 安全边界:路径在这里净化——每段去危险字符与前导点(防隐藏目录/穿越),
 * 深度 ≤3,单块最多 8 个,总长 ≤120 字符;绝不删除或移动任何已有内容。
 */

export const CREATE_FOLDER_MAX = 8
export const CREATE_FOLDER_MAX_DEPTH = 3

const BLOCK_RE = /<<<新建文件夹>>>\r?\n?([\s\S]*?)\r?\n?<<<新建文件夹结束>>>/g

/** 单段净化与 create-note 的标题净化同规:危险字符换空格、折叠、剥前导点 */
function sanitizeSegment(raw: string): string {
  return raw
    .replace(/[:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .trim()
}

export function sanitizeFolderPath(raw: string): string {
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .map(sanitizeSegment)
    .filter((seg) => seg.length > 0)
    .slice(0, CREATE_FOLDER_MAX_DEPTH)
  return segments.join('/').slice(0, 120).replace(/\/+$/, '')
}

export interface CreateFolderExtraction {
  cleanText: string
  folders: string[]
}

/** 从助手回复中提取新建文件夹块;展示文本剥离标记,越界/重复丢弃 */
export function extractCreateFolderBlocks(text: string): CreateFolderExtraction {
  const folders: string[] = []
  const seen = new Set<string>()
  const cleanText = text
    .replace(BLOCK_RE, (_match, body: string) => {
      for (const line of body.split(/\r?\n/)) {
        if (folders.length >= CREATE_FOLDER_MAX) break
        const path = sanitizeFolderPath(line)
        if (path && !seen.has(path)) {
          seen.add(path)
          folders.push(path)
        }
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, folders }
}

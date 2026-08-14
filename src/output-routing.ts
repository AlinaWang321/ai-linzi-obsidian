/**
 * 技能产出的本地目录路由。
 * 这里只根据已经确定的内容类型和平台机械分流，不包含任何 AI 判断。
 */
export function outputSubfolder(contentType: unknown, platform: string, skill = ''): string {
  if (contentType === '选题') return '选题'
  if (contentType === '公众号文章') return '公众号文章'
  if (skill === '谈单复盘' || skill === '销售复盘') return '销售复盘'
  if (platform === '小红书') return '小红书'
  if (platform === '口播') return '口播脚本'
  if (platform === '朋友圈') return '朋友圈'
  return ''
}

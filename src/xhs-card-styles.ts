/**
 * 小红书卡片风格清单(选择卡/设置页/frontmatter 共用的展示信息)。
 * 绘制细节在 xhs-card-render.ts;这里只放纯数据。
 */
import type { XhsCardStyleId } from './xhs-card-render'

export interface XhsCardStyleInfo {
  id: XhsCardStyleId
  name: string
  tagline: string
  swatch: [string, string, string]
}

export const XHS_CARD_STYLES: XhsCardStyleInfo[] = [
  {
    id: 'classic',
    name: '经典彩色',
    tagline: '白纸+蓝标题+黄色点缀,出厂版(含页码)',
    swatch: ['#1265E8', '#F4B900', '#FFFFFF'],
  },
  {
    id: 'mono',
    name: '黑白极简',
    tagline: '黑白灰细线条,与公众号「极简黑白」同气质(无页码)',
    swatch: ['#111111', '#8C8C8C', '#F5F5F5'],
  },
  {
    id: 'x-dark',
    name: 'X 推文风',
    tagline: '黑底白字推文卡:头像+昵称+蓝勾+装饰互动条(无页码)',
    swatch: ['#000000', '#1D9BF0', '#E7E9EA'],
  },
]

/** 未知/历史 id 一律回退经典彩色,设置值永远安全。 */
export function getXhsCardStyle(id: string | undefined): XhsCardStyleInfo {
  return XHS_CARD_STYLES.find((style) => style.id === id) ?? XHS_CARD_STYLES[0]
}

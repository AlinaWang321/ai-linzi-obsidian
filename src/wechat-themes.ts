/**
 * 公众号排版主题库。
 *
 * 每套主题 = 一组配色 + 大标题/PART 胶囊的样式变体。四套主题共用同一条
 * 排版管线(publish.ts),CSS 属性集不超出「经典亮蓝」已在公众号编辑器
 * 真机验证过的集合——加主题只是加一条数据,不引入新的兼容风险。
 *
 * 「经典亮蓝」是默认主题,取值必须与 0.7.35 及以前写死的 THEME 完全一致,
 * 保证老用户升级后不选择主题时输出逐字节不变(test-format.mjs 有回归断言)。
 */

export type WechatHeadingVariant = 'left-bar' | 'underline' | 'block'
export type WechatPillVariant = 'capsule' | 'outline'

export interface WechatTheme {
  id: string
  /** 选择卡显示名 */
  name: string
  /** 一句话风格说明(选择卡/设置页展示) */
  tagline: string
  /** 选择卡三个代表色块 */
  swatch: [string, string, string]
  /** 大标题(H2)样式变体 */
  heading: WechatHeadingVariant
  /** PART 胶囊样式变体 */
  pill: WechatPillVariant
  /** 正文墨色 */
  ink: string
  /** 图注与次要文字 */
  inkMute: string
  /** 小标题(H3/H4)、胶囊文字与品牌小卡主色 */
  deep: string
  /** 大标题与正文加粗强调色 */
  accent: string
  /** 链接色 */
  link: string
  /** 结构强调色(标题边条/链接下划线/引用边条/胶囊描边) */
  mark: string
  /** 结构强调浅底(胶囊底/块状标题底) */
  markSoft: string
  quoteBg: string
  quoteInk: string
  imgBorder: string
  line: string
  bgSoft: string
  /** 行内代码底色 */
  codeBg: string
  /** 文末品牌小卡底色 */
  footerBg: string
}

export const WECHAT_THEMES: WechatTheme[] = [
  {
    id: 'classic-blue',
    name: '经典亮蓝',
    tagline: '亮蓝大标题+黄色胶囊,AI霖子出厂版',
    swatch: ['#0057FF', '#f5c518', '#fff9dc'],
    heading: 'left-bar',
    pill: 'capsule',
    ink: '#2b2b2b',
    inkMute: '#7d7d7d',
    deep: '#1f3f7c',
    accent: '#0057FF',
    link: '#1f63c5',
    mark: '#f5c518',
    markSoft: '#fce38a',
    quoteBg: '#fff9dc',
    quoteInk: '#4f4a3f',
    imgBorder: '#e3e8f0',
    line: '#e8ebf1',
    bgSoft: '#f4f6f9',
    codeBg: '#eef4ff',
    footerBg: '#fbfcfe',
  },
  {
    id: 'mono-ink',
    name: '极简黑白',
    tagline: '黑白灰细线条,克制高级',
    swatch: ['#111111', '#8c8c8c', '#f0f0f0'],
    heading: 'underline',
    pill: 'outline',
    ink: '#262626',
    inkMute: '#8c8c8c',
    deep: '#1f1f1f',
    accent: '#111111',
    link: '#111111',
    mark: '#111111',
    markSoft: '#f0f0f0',
    quoteBg: '#f7f7f7',
    quoteInk: '#555555',
    imgBorder: '#e3e3e3',
    line: '#dedede',
    bgSoft: '#f7f7f7',
    codeBg: '#efefef',
    footerBg: '#fbfbfb',
  },
  {
    id: 'warm-clay',
    name: '暖橙杂志',
    tagline: '暖橙标题底色块,杂志感',
    swatch: ['#d9480f', '#f76707', '#fff4ec'],
    heading: 'block',
    pill: 'capsule',
    ink: '#3d3733',
    inkMute: '#a08d80',
    deep: '#9a3f12',
    accent: '#d9480f',
    link: '#c2410c',
    mark: '#f76707',
    markSoft: '#ffe3d1',
    quoteBg: '#fff4ec',
    quoteInk: '#6f5443',
    imgBorder: '#f2ded0',
    line: '#f2e3d8',
    bgSoft: '#faf3ee',
    codeBg: '#ffefe3',
    footerBg: '#fffaf6',
  },
  {
    id: 'deep-green',
    name: '墨绿人文',
    tagline: '墨绿+米白,沉稳人文',
    swatch: ['#0e5c38', '#34a06b', '#f1f8f3'],
    heading: 'left-bar',
    pill: 'capsule',
    ink: '#2e3531',
    inkMute: '#82918a',
    deep: '#1d4d36',
    accent: '#0e5c38',
    link: '#14724a',
    mark: '#34a06b',
    markSoft: '#dcf1e5',
    quoteBg: '#f1f8f3',
    quoteInk: '#48584f',
    imgBorder: '#dce9e0',
    line: '#e1ede5',
    bgSoft: '#f3f8f4',
    codeBg: '#e8f4ec',
    footerBg: '#f9fcfa',
  },
]

export const DEFAULT_WECHAT_THEME = WECHAT_THEMES[0]

/** 未知/历史 id 一律回退默认主题,设置值永远安全。 */
export function getWechatTheme(id: string | undefined): WechatTheme {
  return WECHAT_THEMES.find((t) => t.id === id) ?? DEFAULT_WECHAT_THEME
}

// ── 各元素内联样式(publish.ts 正式排版与选择卡迷你预览共用同一份) ──

export function pillStyle(t: WechatTheme): string {
  const base = 'display:inline-block;margin:34px 0 10px;padding:6px 14px;font-size:14px;line-height:1.4;font-weight:700;letter-spacing:2px;'
  if (t.pill === 'outline') {
    return `${base}border:1px solid ${t.mark};border-radius:3px;background:#ffffff;color:${t.deep};`
  }
  return `${base}border-radius:999px;background:${t.markSoft};color:${t.deep};`
}

export function h2Style(t: WechatTheme): string {
  if (t.heading === 'underline') {
    return `margin:4px 0 22px;padding-bottom:10px;border-bottom:1px solid ${t.line};color:${t.accent};font-size:23px;line-height:1.45;font-weight:800;letter-spacing:0;`
  }
  if (t.heading === 'block') {
    return `margin:4px 0 22px;padding:8px 14px;border-radius:6px;background:${t.markSoft};color:${t.accent};font-size:22px;line-height:1.5;font-weight:800;letter-spacing:0;`
  }
  return `margin:4px 0 22px;padding-left:13px;border-left:4px solid ${t.mark};color:${t.accent};font-size:23px;line-height:1.45;font-weight:800;letter-spacing:0;`
}

export function paragraphStyle(t: WechatTheme): string {
  return `margin:0 0 18px;color:${t.ink};font-size:16px;line-height:1.95;text-align:justify;letter-spacing:0;`
}

export function strongStyle(t: WechatTheme): string {
  return `color:${t.accent};font-weight:700;`
}

export function quoteStyle(t: WechatTheme): string {
  return `margin:22px 0;padding:14px 18px;border-left:4px solid ${t.mark};background:${t.quoteBg};color:${t.quoteInk};font-size:16px;line-height:1.85;`
}

export interface MarkdownTemplateRequirements {
  frontmatterKeys: string[]
  headings: string[]
}

function normalizedHeading(value: string): string {
  return value
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从用户自己的模板中提取可确定校验的结构：顶层 YAML 字段和不含变量的 H2/H3 标题。
 * 模板内容仍由 Skill 决定；插件只做结构验收，不猜业务值。
 */
export function markdownTemplateRequirements(template: string): MarkdownTemplateRequirements {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(template)?.[1] ?? ''
  const frontmatterKeys = [...frontmatter.matchAll(/^([^\s:#][^:\r\n]{0,79}):(?:\s|$)/gm)]
    .map((match) => match[1].trim())
  const headings = [...template.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)]
    .map((match) => match[1])
    .filter((heading) => !/\{\{[^}]+\}\}/.test(heading))
    .map(normalizedHeading)
    .filter(Boolean)
  return {
    frontmatterKeys: [...new Set(frontmatterKeys)],
    headings: [...new Set(headings)],
  }
}

export function validateMarkdownAgainstTemplate(content: string, template: string): void {
  const requirements = markdownTemplateRequirements(template)
  if (requirements.frontmatterKeys.length === 0 && requirements.headings.length === 0) {
    throw new Error('Skill 指定的模板没有可校验的 YAML 字段或 Markdown 标题')
  }
  const current = markdownTemplateRequirements(content)
  const currentKeys = new Set(current.frontmatterKeys)
  const currentHeadings = new Set(current.headings)
  const missingKeys = requirements.frontmatterKeys.filter((key) => !currentKeys.has(key))
  const missingHeadings = requirements.headings.filter((heading) => !currentHeadings.has(heading))
  if (missingKeys.length === 0 && missingHeadings.length === 0) return
  const details = [
    missingKeys.length > 0 ? `缺少 YAML 字段：${missingKeys.join('、')}` : '',
    missingHeadings.length > 0 ? `缺少章节：${missingHeadings.join('、')}` : '',
  ].filter(Boolean)
  throw new Error(`未通过 Skill 模板预检（${details.join('；')}）`)
}

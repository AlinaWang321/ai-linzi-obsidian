import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-consultation-brief-'))
const outfile = path.join(tempDir, 'core.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/customer-consultation-brief-core.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const core = await import(pathToFileURL(outfile).href)
const runtimeOutfile = path.join(tempDir, 'runtime.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/official-skill-runtime-core.ts', import.meta.url))],
  outfile: runtimeOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const runtime = await import(pathToFileURL(runtimeOutfile).href)
const styleOutfile = path.join(tempDir, 'style.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/customer-consultation-brief-style.ts', import.meta.url))],
  outfile: styleOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const styleModule = await import(pathToFileURL(styleOutfile).href)

assert.equal(core.CUSTOMER_CONSULTATION_TRANSCRIPT_MIN, 800)
assert.equal(core.CUSTOMER_CONSULTATION_TRANSCRIPT_MAX, 100_000)
assert.equal(core.CUSTOMER_CONSULTATION_OUTPUT_FOLDER, '客户咨询简报')
assert.equal(core.isConsultationBriefRevisionIntent('把刚才的咨询简报里核心诊断第 2 条改成更直接的说法'), true)
assert.equal(core.isConsultationBriefRevisionIntent('修改这张简报图片上的标题文字'), true)
assert.equal(core.isConsultationBriefRevisionIntent('修改咨询简报 Skill 的输出规则'), false)
assert.equal(core.isConsultationBriefRevisionIntent('帮我生成一份咨询简报'), false)
const originalBrief = `# 客户 A · 咨询简报

## 核心诊断

${'旧内容'.repeat(80)}

## 下一步行动

${'行动内容'.repeat(40)}`
assert.equal(
  core.consultationBriefRevisionIssue(
    originalBrief,
    originalBrief.replace('旧内容', '新内容'),
    '把核心诊断第一处改成新内容',
  ),
  undefined,
)
assert.equal(
  core.consultationBriefRevisionIssue(
    originalBrief,
    originalBrief.replace('## 核心诊断', '## 商业诊断'),
    '把核心诊断的标题改成商业诊断',
  ),
  undefined,
)
assert.match(
  core.consultationBriefRevisionIssue(
    originalBrief,
    '# 客户 A · 咨询简报\n\n## 核心诊断\n\n新内容',
    '修改一句话',
  ),
  /严重缩水/,
)
assert.match(
  core.consultationBriefRevisionIssue(originalBrief, originalBrief, '把标题改一下'),
  /没有落实/,
)
assert.equal(
  core.customerConsultationPngBase('2026.08.15', '客户/A'),
  '2026.08.15_客户 A_客户咨询简报',
)
assert.equal(core.normalizeConsultationBriefMarkdown('```markdown\n# 客户 A · 咨询简报\n```'), '# 客户 A · 咨询简报')
assert.equal(
  core.normalizeConsultationBriefMarkdown('```markdown\n# 客户 A · 咨询简报\n\n## 核心诊断'),
  '# 客户 A · 咨询简报\n\n## 核心诊断',
  '缺少末尾围栏时也必须保留完整正文',
)
assert.equal(
  core.normalizeConsultationBriefMarkdown('下面是为你生成的简报：\n\n# 客户 A · 咨询简报\n\n## 核心诊断'),
  '# 客户 A · 咨询简报\n\n## 核心诊断',
  '一级标题前的模型客套话不得进入客户成品',
)
assert.equal(
  core.ensureConsultationBriefHeading('## 核心诊断\n\n正文', {
    clientName: '客户 A',
    coachName: 'Alina霖子',
    topic: '商业定位',
    sessionInfo: '2026-08-20',
  }),
  '# 客户 A · 咨询简报\n\n> 商业定位 · 2026-08-20 · 咨询师 Alina霖子\n\n## 核心诊断\n\n正文',
  '正文结构完整但缺少一级标题时应使用已确认表单字段补齐',
)
assert.equal(
  core.ensureConsultationBriefHeading('服务暂时不可用', {
    clientName: '客户 A',
    coachName: 'Alina霖子',
    topic: '',
    sessionInfo: '',
  }),
  '',
  '错误句或无结构内容不得被包装成成功简报',
)
const action = runtime.extractConsultationBriefAction(
  `前四步完成\n${runtime.CONSULTATION_BRIEF_ACTION_MARKER}`,
)
assert.equal(action.requested, true)
assert.equal(action.cleanText, '前四步完成')
const ordinaryReply = '第一段。\n\n\n第二段。  '
const untouched = runtime.extractConsultationBriefAction(ordinaryReply)
assert.equal(untouched.requested, false)
assert.equal(untouched.cleanText, ordinaryReply)

const source = await readFile(new URL('../src/customer-consultation-brief.ts', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const actions = await readFile(new URL('../src/actions.ts', import.meta.url), 'utf8')
const transcriptSource = await readFile(new URL('../src/transcript-source.ts', import.meta.url), 'utf8')
assert.match(source, /本次只读取并锁定这一份逐字稿/)
assert.match(source, /只生成给客户看的 PNG 长图/)
assert.match(source, /\/api\/plugin\/v1\/skills\/consultation-brief/)
assert.match(source, /createBinary\(path, png\)/)
assert.match(source, /existingBrief: draft\.markdown/)
assert.match(source, /revisionInstruction: instruction/)
assert.match(source, /consultationBriefRevisionIssue\(draft\.markdown, markdown, instruction\)/)
assert.match(source, /rememberConsultationBriefDraft\(/)
assert.match(source, /旧图片仍保留，没有覆盖/)
assert.match(mainSource, /consultationBriefDraft\?: CustomerConsultationBriefDraft/)
assert.match(mainSource, /recentConsultationBriefDraft\(\)/)
assert.match(mainSource, /isConsultationBriefRevisionIntent\(text\)/)
assert.match(mainSource, /delete message\.consultationBriefDraft/)
assert.match(
  mainSource,
  /messagesForApi\(\): WireMessage\[\][\s\S]*?\.map\(\(\{ id, role, parts \}\) => \(\{ id, role, parts \}\)\)/,
  '咨询简报隐藏源稿不得上传普通主对话 API',
)
assert.match(source, /CUSTOMER_CONSULTATION_OUTPUT_FOLDER/)
assert.match(source, /selectTranscriptSource\(/)
assert.match(source, /lockedSourceFile\?: TFile/)
assert.match(source, /readLocalDocumentText\(/)
assert.doesNotMatch(source, /writeOutput\(/)
assert.doesNotMatch(source, /toneMode/)
assert.match(source, /toPng\(card/)
assert.match(source, /applyConsultationBriefExportStyles\(host, card, body\)/)
assert.match(source, /ai-linzi-consultation-quote-mark/)
assert.match(source, /ai-linzi-consultation-footer/)
assert.match(source, /AI 霖子生成/)
assert.match(actions, /runSalesReview[\s\S]+?selectTranscriptSource\(/)
// v0.7.42 起通用白名单放宽到 HTML/PPTX，但逐字稿候选必须钉死在这四种格式上。
assert.match(transcriptSource, /TRANSCRIPT_EXTENSIONS = new Set\(\['md', 'txt', 'pdf', 'docx'\]\)/)
assert.match(transcriptSource, /isTranscriptExtension\(file\.extension\)/)
assert.match(transcriptSource, /readLocalDocumentText\(plugin\.app, file, maxChars, 'skill'\)/)
assert.match(transcriptSource, /stripFrontmatter\(result\.text\)/)
assert.match(transcriptSource, /原始 Word\/PDF\/TXT 文件不会上传/)

// 真跑导出样式行为：先模拟深色主题把所有文字刷成近白，再确认导出专用
// 内联样式能独立恢复正文、标题、建议卡、表格和页脚，不依赖 styles.css。
class FakeStyle {
  values = new Map()
  setProperty(name, value) { this.values.set(name, value) }
  get(name) { return this.values.get(name) }
}
class FakeElement {
  style = new FakeStyle()
  selectors = new Map()
  add(selector, ...elements) { this.selectors.set(selector, elements); return this }
  querySelectorAll(selector) { return this.selectors.get(selector) ?? [] }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
globalThis.HTMLElement = FakeElement
const host = new FakeElement()
const card = new FakeElement()
const body = new FakeElement()
const header = new FakeElement()
const headerLabel = new FakeElement()
const headerTitle = new FakeElement()
const headerQuote = new FakeElement()
const headerQuoteText = new FakeElement()
const h2 = new FakeElement()
const paragraph = new FakeElement()
const advice = new FakeElement()
const adviceText = new FakeElement()
const summary = new FakeElement()
const summaryText = new FakeElement()
const quoteMark = new FakeElement()
const table = new FakeElement()
const th = new FakeElement()
const td = new FakeElement()
const footer = new FakeElement()
const footerText = new FakeElement()
const footerSite = new FakeElement()
const footerDate = new FakeElement()
for (const element of [card, body, paragraph, headerTitle, adviceText, summaryText, th, td, footer]) {
  element.style.setProperty('color', '#f8fafc')
  element.style.setProperty('background', '#0b1020')
}
card
  .add('.ai-linzi-consultation-header', header)
  .add('.ai-linzi-consultation-header-label', headerLabel)
  .add('.ai-linzi-consultation-header h1', headerTitle)
  .add('.ai-linzi-consultation-header blockquote', headerQuote)
  .add('.ai-linzi-consultation-header blockquote p', headerQuoteText)
  .add('.ai-linzi-consultation-footer', footer)
  .add('.ai-linzi-consultation-footer span', footerText, footerSite, footerDate)
  .add('.ai-linzi-consultation-footer-site', footerSite)
  .add('.ai-linzi-consultation-footer-date', footerDate)
body
  .add('h2', h2)
  .add('p', paragraph)
  .add('blockquote.ai-linzi-consultation-advice', advice)
  .add('blockquote.ai-linzi-consultation-summary', summary)
  .add('blockquote.ai-linzi-consultation-advice p, blockquote.ai-linzi-consultation-summary p', adviceText, summaryText)
  .add('.ai-linzi-consultation-quote-mark', quoteMark)
  .add('table', table)
  .add('th, td', th, td)
  .add('th', th)
styleModule.applyConsultationBriefExportStyles(host, card, body)
assert.equal(host.style.get('left'), '-12000px')
assert.equal(card.style.get('background'), '#fafaf7')
assert.equal(card.style.get('color'), '#1f2937')
assert.match(header.style.get('background'), /#0f172a/)
assert.equal(headerTitle.style.get('color'), '#ffffff')
assert.equal(body.style.get('background'), '#fafaf7')
assert.equal(paragraph.style.get('color'), '#1f2937')
assert.equal(advice.style.get('background'), '#0f172a')
assert.equal(adviceText.style.get('color'), '#f8fafc')
assert.equal(summaryText.style.get('color'), '#f8fafc')
assert.equal(quoteMark.style.get('color'), '#d97706')
assert.equal(table.style.get('background'), '#ffffff')
assert.equal(th.style.get('background'), '#0f172a')
assert.equal(th.style.get('color'), '#f8fafc')
assert.equal(td.style.get('color'), '#1f2937')
assert.equal(footer.style.get('background'), '#ffffff')
assert.equal(footerSite.style.get('color'), '#0f172a')
delete globalThis.HTMLElement

console.log('customer consultation brief PNG tests passed')

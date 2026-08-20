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

assert.equal(core.CUSTOMER_CONSULTATION_TRANSCRIPT_MIN, 800)
assert.equal(core.CUSTOMER_CONSULTATION_TRANSCRIPT_MAX, 100_000)
assert.equal(core.CUSTOMER_CONSULTATION_OUTPUT_FOLDER, '客户咨询简报')
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
const actions = await readFile(new URL('../src/actions.ts', import.meta.url), 'utf8')
const transcriptSource = await readFile(new URL('../src/transcript-source.ts', import.meta.url), 'utf8')
assert.match(source, /本次只读取并锁定这一份逐字稿/)
assert.match(source, /只生成给客户看的 PNG 长图/)
assert.match(source, /\/api\/plugin\/v1\/skills\/consultation-brief/)
assert.match(source, /createBinary\(path, png\)/)
assert.match(source, /CUSTOMER_CONSULTATION_OUTPUT_FOLDER/)
assert.match(source, /selectTranscriptSource\(/)
assert.match(source, /lockedSourceFile\?: TFile/)
assert.match(source, /readLocalDocumentText\(/)
assert.doesNotMatch(source, /writeOutput\(/)
assert.doesNotMatch(source, /toneMode/)
assert.match(source, /toPng\(card/)
assert.match(source, /ai-linzi-consultation-footer/)
assert.match(source, /AI 霖子生成/)
assert.match(actions, /runSalesReview[\s\S]+?selectTranscriptSource\(/)
// v0.7.42 起通用白名单放宽到 HTML/PPTX，但逐字稿候选必须钉死在这四种格式上。
assert.match(transcriptSource, /TRANSCRIPT_EXTENSIONS = new Set\(\['md', 'txt', 'pdf', 'docx'\]\)/)
assert.match(transcriptSource, /isTranscriptExtension\(file\.extension\)/)
assert.match(transcriptSource, /readLocalDocumentText\(plugin\.app, file, maxChars, 'skill'\)/)
assert.match(transcriptSource, /stripFrontmatter\(result\.text\)/)
assert.match(transcriptSource, /原始 Word\/PDF\/TXT 文件不会上传/)

console.log('customer consultation brief PNG tests passed')

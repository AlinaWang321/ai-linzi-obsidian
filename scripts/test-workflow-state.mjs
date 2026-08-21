import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function importBundle(entryPoint) {
  const bundled = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

const consultation = await importBundle('src/consultation-workflow-source.ts')
const weekly = await importBundle('src/weekly-business-cache.ts')

console.log('[test-workflow-state]')

const transcriptPath = consultation.consultationWorkflowSourcePath([
  {
    sourceId: 'consultation-preload-template-1',
    filename: '客户档案模板.md',
    path: '05_System/模板库/客户档案模板.md',
  },
  {
    sourceId: 'r2-read-1',
    filename: '20260813193042-顾老师商业咨询-逐字稿文本-1.txt',
    path: '01_Raw/销售逐字稿/20260813193042-顾老师商业咨询-逐字稿文本-1.txt',
  },
  {
    sourceId: 'r4-read-2',
    filename: '顾老师客户档案.md',
    path: '02_Wiki/客户档案/顾老师客户档案.md',
  },
], {
  localSkillsRoot: '05_System/Skills',
  outputRoot: '04_Output/AI霖子输出',
})
assert.equal(
  transcriptPath,
  '01_Raw/销售逐字稿/20260813193042-顾老师商业咨询-逐字稿文本-1.txt',
  '必须从本轮真实读取来源中锁定 TXT 逐字稿，而不是模板或客户档案',
)
assert.equal(
  consultation.consultationWorkflowSourcePath([
    { sourceId: 'r1-read', filename: '客户甲咨询逐字稿.txt', path: '01_Raw/客户甲咨询逐字稿.txt' },
    { sourceId: 'r1-read', filename: '客户乙咨询逐字稿.txt', path: '01_Raw/客户乙咨询逐字稿.txt' },
  ]),
  undefined,
  '两份同分逐字稿必须回退文件选择器，不能串客户',
)
assert.equal(consultation.isConsultationTranscriptPath('01_Raw/咨询.pdf'), true)
assert.equal(consultation.isConsultationTranscriptPath('04_Output/简报.png'), false)

const oldCache = {
  version: 1,
  artifactPath: '04_Output/AI霖子输出/经营周报/旧看板.html',
  updatedAt: 1_000,
  capturedAt: 900,
  sinceDays: 7,
  files: [
    { path: '01_Raw/A.md', mtime: 100, size: 10 },
    { path: '02_Wiki/B.md', mtime: 200, size: 20 },
    { path: '02_Wiki/已移出窗口.md', mtime: 50, size: 30 },
  ],
}
const incremental = weekly.selectWeeklyBusinessRefresh([
  { path: '01_Raw/A.md', mtime: 100, size: 10 },
  { path: '02_Wiki/B.md', mtime: 201, size: 21 },
  { path: '04_Output/新任务.md', mtime: 300, size: 40 },
], oldCache, { baselineAvailable: true, sinceDays: 7, now: 2_000 })
assert.equal(incremental.mode, 'incremental')
assert.deepEqual(
  incremental.readFiles.map((file) => file.path),
  ['02_Wiki/B.md', '04_Output/新任务.md'],
  '增量刷新只重读新增或 mtime/size 变化的文件',
)
assert.equal(incremental.unchangedFiles, 1)
assert.deepEqual(incremental.removedPaths, ['02_Wiki/已移出窗口.md'])

const missingBaseline = weekly.selectWeeklyBusinessRefresh([
  { path: '01_Raw/A.md', mtime: 100, size: 10 },
], oldCache, { baselineAvailable: false, sinceDays: 7, now: 2_000 })
assert.equal(missingBaseline.mode, 'full')
assert.equal(missingBaseline.readFiles.length, 1)

assert.equal(weekly.storedWeeklyBusinessDashboardCache({ version: 1, files: [] }), null)
assert.equal(weekly.storedWeeklyBusinessDashboardCache(oldCache)?.artifactPath, oldCache.artifactPath)
assert.equal(
  weekly.storedWeeklyBusinessScanState({ sinceDays: 7, capturedAt: 100, files: oldCache.files })?.files.length,
  3,
)
assert.equal(weekly.storedWeeklyBusinessScanState({ sinceDays: 7, capturedAt: 100, files: [{}] }), null)

console.log('workflow source lock + weekly incremental cache tests passed')

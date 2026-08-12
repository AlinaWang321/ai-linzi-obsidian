import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/content-dashboard.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

for (const label of ['发布矩阵', '创作管线', '数据分析', '公众号', '小红书', '视频号', '抖音']) {
  assert.match(source, new RegExp(label), `missing dashboard label: ${label}`)
}

for (const lane of ['选题库', '草稿', '制作中', '分发中', '已发完']) {
  assert.match(source, new RegExp(lane), `missing pipeline lane: ${lane}`)
}

assert.match(source, /📷 截图导入数据/)
assert.match(source, /chooseComputerAiImageReferences/)
assert.match(source, /chat\/history\?sessionId=/)
assert.match(source, /AI霖子已根据你主动选择的截图预填数据/)
assert.match(source, /内容看板\/平台数据\.md/)
assert.match(source, /只有点击“保存数据”后才会写入本地 Vault/)

for (const selector of [
  '.ai-linzi-dashboard-matrix',
  '.ai-linzi-dashboard-pipeline',
  '.ai-linzi-dashboard-account-grid',
  '.ai-linzi-dashboard-top-list',
]) {
  assert.match(styles, new RegExp(selector.replaceAll('.', '\\.')), `missing dashboard style: ${selector}`)
}

console.log('content dashboard UI contract tests passed')

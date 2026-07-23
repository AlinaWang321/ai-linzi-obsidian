import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')

assert.doesNotMatch(source, /AI霖子正文配图_方案\.md/)
assert.doesNotMatch(source, /function planMarkdown/)
assert.match(source, /illustration-jobs\.json/)
assert.match(source, /继续上次未完成的配图/)
assert.match(source, /不会重新生成方案，也不会重做已经成功的图片/)
assert.match(source, /再次运行“文章配图”可直接继续补图/)
assert.match(source, /完成并查看文章/)
assert.doesNotMatch(source, /setButtonText\('修改其中一张配图'\)/)
assert.match(source, /offerArticleIllustrationEdit\(note\.file\.path, completionSummary\)/)

console.log('illustration resume regression tests passed')

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/cockpit-view.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

assert.match(source, /private taskTab: 'week' \| 'month' \| 'quarter' \| 'customer' \| 'overdue'/)
assert.match(source, /const customerTodos = this\.cloud\?\.crm\?\.todos/)
assert.match(source, /key: 'customer', label: '客户待办'/)
assert.match(source, /todo\.customerName \|\| '客户'/)
assert.match(source, /todo\.overdue \? '⏰' : '⬜️'/)
assert.match(source, /text: '客户管理'/)
assert.match(source, /\/customers`/)
assert.match(styles, /\.ai-linzi-cockpit-tabs \{[^}]*flex-wrap: wrap;/)
assert.match(styles, /\.ai-linzi-cockpit-task-due/)
assert.match(styles, /\.ai-linzi-cockpit-task\.is-overdue/)

// 第二大脑统计口径：内容文件不只 Markdown——PDF/Word/PPT 等也计入（2026-08-17
// No.283 反馈 Raw 全是 PDF 却显示 0）；内容流水线看板仍只认 Markdown。
assert.match(source, /const COCKPIT_COUNTED_EXTENSIONS = new Set\(\[/)
assert.match(source, /'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv',/)
assert.match(source, /\.getFiles\(\)/)
assert.match(source, /COCKPIT_COUNTED_EXTENSIONS\.has\(file\.extension\.toLocaleLowerCase\(\)\)/)
assert.match(source, /file\.extension === 'md' && isDashboardContentPath/)
assert.match(source, /'全库文件'/)
assert.doesNotMatch(source, /getMarkdownFiles/)

console.log('cockpit customer todo contract tests passed')

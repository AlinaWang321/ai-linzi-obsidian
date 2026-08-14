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

console.log('cockpit customer todo contract tests passed')

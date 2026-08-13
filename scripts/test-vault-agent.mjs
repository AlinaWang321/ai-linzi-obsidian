import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/vault-agent-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = bundled.outputFiles[0].text
const core = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const calls = core.extractVaultToolCalls(`准备继续查找。
<<<VAULT_TOOL_CALLS>>>
{"calls":[{"id":"search-1","name":"vault_search","arguments":{"query":"高客单产品"}},{"id":"read-1","name":"read_note","arguments":{"path":"wiki/产品.md","maxChars":12000}}]}
<<<VAULT_TOOL_CALLS_END>>>`)
assert.equal(calls.invalid, false)
assert.equal(calls.calls.length, 2)
assert.equal(calls.calls[0].name, 'vault_search')
assert.equal(calls.cleanText, '准备继续查找。')

const roundOne = core.namespaceVaultToolCalls(calls.calls, 0)
const roundTwo = core.namespaceVaultToolCalls(calls.calls, 1)
assert.equal(roundOne[0].id, 'r1-1-search-1')
assert.equal(roundTwo[0].id, 'r2-1-search-1')
assert.equal(new Set([...roundOne, ...roundTwo].map((call) => call.id)).size, 4)

assert.equal(
  core.extractVaultToolCalls(`<<<VAULT_TOOL_CALLS>>>{"calls":[{"id":"x","name":"delete_file","arguments":{}}]}<<<VAULT_TOOL_CALLS_END>>>`).invalid,
  true,
)

const plan = core.extractVaultOrganizePlan(`我先给你一份待确认方案。
<<<VAULT_ORGANIZE_PLAN>>>
{"title":"整理收件箱","summary":"按主题归档","operations":[{"type":"create_folder","path":"wiki/产品"},{"type":"move","from":"inbox/产品灵感.md","to":"wiki/产品/产品灵感.md"}],"notes":["确认后才执行"]}
<<<VAULT_ORGANIZE_PLAN_END>>>`)
assert.equal(plan.invalid, false)
assert.equal(plan.plan?.operations.length, 2)
assert.equal(plan.plan?.operations[1].type, 'move')
assert.equal(plan.cleanText, '我先给你一份待确认方案。')

assert.equal(core.normalizeVaultRelativePath('../secret.md'), null)
assert.equal(core.normalizeVaultRelativePath('/absolute/file.md'), null)
assert.equal(core.normalizeVaultRelativePath('.obsidian/plugins/x'), null)
assert.equal(core.isProtectedVaultPath('AGENTS.md'), true)
assert.equal(core.isProtectedVaultPath('system/skills/demo/SKILL.md'), true)
assert.equal(core.isProtectedVaultPath('㊙️财务/收入.md'), false)
assert.equal(core.isProtectedVaultPath('wiki/产品.md'), false)
assert.equal(core.VAULT_AGENT_MAX_ROUNDS, 6)

console.log('vault agent protocol tests passed')

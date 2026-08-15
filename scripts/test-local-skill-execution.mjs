import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/local-skill-execution-core.ts', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const executorSource = await readFile(new URL('../src/local-skill-executor.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('module', 'exports', compiled)(module, module.exports)
const core = module.exports

const valid = core.prepareLocalSkillAction({
  label: '生成测试文件',
  program: 'python',
  args: ['$SKILL/scripts/demo.py', '$OUTPUT/demo.txt'],
  cwd: '$VAULT',
  timeoutSeconds: 60,
  writes: ['$OUTPUT/demo.txt'],
  usesNetwork: false,
  shareOutputWithAi: false,
})
assert.equal(valid.ok, true)
assert.equal(valid.action.program, 'python')
assert.equal(valid.action.shareOutputWithAi, false)

const sharedOutput = core.prepareLocalSkillAction({
  label: '读取转换结果',
  program: 'node',
  args: ['$SKILL/scripts/demo.js'],
  shareOutputWithAi: true,
})
assert.equal(sharedOutput.ok, true)
assert.equal(sharedOutput.action.shareOutputWithAi, true)

for (const [label, proposal, expected] of [
  ['拒绝 Python 内联代码', { label: 'x', program: 'python', args: ['-c', 'print(1)'] }, /只能运行当前 Skill/],
  ['拒绝 Node eval', { label: 'x', program: 'node', args: ['-e', 'process.exit()'] }, /只能运行当前 Skill/],
  ['拒绝 npm', { label: 'x', program: 'npm', args: ['run', 'build'] }, /未开放的程序/],
  ['拒绝越界脚本', { label: 'x', program: 'python', args: ['$VAULT/demo.py'] }, /当前 Skill/],
  ['拒绝 URL', { label: 'x', program: 'ffmpeg', args: ['-i', 'https://x.test/a.mp4'], writes: ['$OUTPUT/a.mp4'] }, /远程 URL/],
  ['拒绝覆盖开关', { label: 'x', program: 'ffmpeg', args: ['-y', '-i', '$VAULT/a.mp4', '$OUTPUT/b.mp4'], writes: ['$OUTPUT/b.mp4'] }, /静默覆盖/],
  ['拒绝输出到 Skill', { label: 'x', program: 'ffmpeg', args: ['-i', '$VAULT/a.mp4', '$SKILL/b.mp4'], writes: ['$SKILL/b.mp4'] }, /输出文件/],
  ['拒绝路径穿越', { label: 'x', program: 'python', args: ['$SKILL/../demo.py'] }, /当前 Skill/],
  ['拒绝 Windows 保留名', { label: 'x', program: 'python', args: ['$SKILL/scripts/demo.py', '$OUTPUT/CON.txt'] }, /文件参数/],
  ['拒绝未授权绝对参数', { label: 'x', program: 'python', args: ['$SKILL/scripts/demo.py', '/etc/passwd'] }, /文件参数/],
  ['拒绝相对文件名', { label: 'x', program: 'python', args: ['$SKILL/scripts/demo.py', 'secret.txt'] }, /文件参数/],
  ['拒绝内嵌路径开关', { label: 'x', program: 'python', args: ['$SKILL/scripts/demo.py', '--config=/etc/passwd'] }, /文件参数/],
  ['拒绝目录型输出', { label: 'x', program: 'python', args: ['$SKILL/scripts/demo.py'], writes: ['$OUTPUT/demo'] }, /带扩展名/],
  ['拒绝 FFmpeg 声明与参数不一致', { label: 'x', program: 'ffmpeg', args: ['-i', '$VAULT/a.mp4', '$OUTPUT/b.mp4'], writes: ['$OUTPUT/c.mp4'] }, /必须出现在参数/],
]) {
  const result = core.prepareLocalSkillAction(proposal)
  assert.equal(result.ok, false, label)
  assert.match(result.error, expected, label)
}

const timeout = core.prepareLocalSkillAction({
  label: '最长动作',
  program: 'node',
  args: ['$SKILL/scripts/demo.js'],
  timeoutSeconds: 999999,
})
assert.equal(timeout.ok, true)
assert.equal(timeout.action.timeoutSeconds, core.LOCAL_SKILL_ACTION_MAX_TIMEOUT_SECONDS)

assert.match(mainSource, /setName\('允许“我的 Skills”运行程序'\)/)
assert.match(mainSource, /getCapabilities\(true\)/)
assert.match(mainSource, /execution\?\.status !== 'available'/)
assert.match(mainSource, /脚本不是系统沙箱/)
assert.match(mainSource, /不会把终端输出交给 AI/)
assert.match(executorSource, /missingDeclaredOutputs/)
assert.match(executorSource, /proposal\.shareOutputWithAi/)

console.log('local Skill execution safety tests passed')

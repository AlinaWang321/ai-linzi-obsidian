import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const build = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../src/local-skill-process.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
})
const source = build.outputFiles[0].text
const processModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const fixture = await mkdtemp(join(tmpdir(), 'ai-linzi-process-test-'))
try {
  const echoScript = join(fixture, 'echo.mjs')
  const timeoutScript = join(fixture, 'timeout.mjs')
  const environmentScript = join(fixture, 'environment.mjs')
  const unexpected = join(fixture, 'must-not-exist.txt')
  await writeFile(echoScript, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
  await writeFile(timeoutScript, 'setTimeout(() => {}, 5000)\n', 'utf8')
  await writeFile(
    environmentScript,
    `console.log(JSON.stringify({ fish: process.env.FISH_API_KEY === 'test-secret', blocked: Boolean(process.env.SHOULD_NOT_PASS) }))\n`,
    'utf8',
  )

  const literal = `;touch ${unexpected}`
  const result = await processModule.runLocalSkillProcess('node', [echoScript, literal], fixture, 5_000)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(JSON.parse(result.stdout.trim()), [literal])
  await assert.rejects(readFile(unexpected), { code: 'ENOENT' })

  const timedOut = await processModule.runLocalSkillProcess('node', [timeoutScript], fixture, 100)
  assert.equal(timedOut.timedOut, true)
  assert.notEqual(timedOut.exitCode, 0)

  const environment = await processModule.runLocalSkillProcess(
    'node',
    [environmentScript],
    fixture,
    5_000,
    { FISH_API_KEY: 'test-secret', SHOULD_NOT_PASS: 'blocked-secret' },
  )
  assert.deepEqual(JSON.parse(environment.stdout.trim()), { fish: true, blocked: false })

  const windowsPython = processModule.commandCandidates('python')
  if (process.platform === 'win32') {
    assert.deepEqual(windowsPython[0], { command: 'py', prefixArgs: ['-3'] })
  } else {
    assert.deepEqual(windowsPython[0], { command: 'python3', prefixArgs: [] })
  }
  assert.deepEqual(processModule.commandCandidates('ffmpeg')[0], {
    command: 'ffmpeg',
    prefixArgs: ['-nostdin'],
  })
  if (process.platform !== 'win32') {
    assert.ok(windowsPython.some((candidate) => candidate.command === '/opt/homebrew/bin/python3'))
    assert.ok(
      processModule.commandCandidates('node').some(
        (candidate) => candidate.command === '/usr/local/bin/node',
      ),
    )
  }
} finally {
  await rm(fixture, { recursive: true, force: true })
}

console.log('local Skill no-shell process tests passed')

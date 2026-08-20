import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import esbuild from 'esbuild'

const obsidianMock = `
export class FileSystemAdapter {
  constructor(basePath) { this.basePath = basePath }
  getBasePath() { return this.basePath }
}
export class TFile {
  constructor(path, fileStat) { this.path = path; this.name = path.split('/').at(-1); this.stat = fileStat }
}
export const normalizePath = (value) => value.replaceAll('\\\\', '/').replace(/^\\.\\//, '')
`

const built = await esbuild.build({
  stdin: {
    contents: `
      export { LocalSkillExecutor } from './src/local-skill-executor.ts'
      export { FileSystemAdapter, TFile } from 'obsidian'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'local-skill-executor-test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
  plugins: [
    {
      name: 'obsidian-test-double',
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-double' }))
        build.onLoad({ filter: /.*/, namespace: 'test-double' }, () => ({
          contents: obsidianMock,
          loader: 'js',
        }))
      },
    },
  ],
})
const executorModule = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)

const fixture = await mkdtemp(join(tmpdir(), 'ai-linzi-executor-test-'))
const skillDirectory = 'system/skills/smoke'
const scriptVaultPath = `${skillDirectory}/scripts/write.mjs`
const scriptPath = join(fixture, scriptVaultPath)
const outputDirectory = join(fixture, 'AI霖子输出')
const trashCalls = []

const fakeVault = {
  adapter: new executorModule.FileSystemAdapter(fixture),
  getAbstractFileByPath(path) {
    return stat(join(fixture, path))
      .then((info) => new executorModule.TFile(path, {
        size: info.size,
        mtime: Math.trunc(info.mtimeMs),
      }))
      .catch(() => null)
  },
  async trash(file, system) {
    trashCalls.push({ path: file.path, system })
    await rm(join(fixture, file.path))
  },
}

// The production API is synchronous here, so wrap the filesystem-backed test double.
fakeVault.getAbstractFileByPath = (path) => fakeVault.files?.get(path) ?? null
fakeVault.refreshFile = async (path) => {
  try {
    const info = await stat(join(fixture, path))
    const file = new executorModule.TFile(path, {
      size: info.size,
      mtime: Math.trunc(info.mtimeMs),
    })
    fakeVault.files.set(path, file)
    return file
  } catch {
    fakeVault.files.delete(path)
    return null
  }
}
fakeVault.files = new Map()
fakeVault.trash = async (file) => {
  trashCalls.push({ path: file.path })
  await rm(join(fixture, file.path))
  fakeVault.files.delete(file.path)
}

try {
  await mkdir(join(fixture, skillDirectory, 'scripts'), { recursive: true })
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(
    scriptPath,
    `import { writeFile } from 'node:fs/promises'\nawait writeFile(process.argv[2], 'safe output', 'utf8')\n`,
    'utf8',
  )
  const executor = new executorModule.LocalSkillExecutor({
    vault: fakeVault,
    fileManager: { trashFile: (file) => fakeVault.trash(file) },
  }, () => 'AI霖子输出')
  const context = {
    root: 'system/skills',
    directory: skillDirectory,
    entryPath: `${skillDirectory}/SKILL.md`,
    linkedPaths: [],
    fullyReadPaths: [scriptVaultPath],
    readThroughByPath: { [scriptVaultPath]: 1_000 },
  }

  const outputPath = 'AI霖子输出/smoke.txt'
  const proposal = {
    label: '生成冒烟文件',
    program: 'node',
    args: ['$SKILL/scripts/write.mjs', '$OUTPUT/smoke.txt'],
    cwd: '$VAULT',
    timeoutSeconds: 5,
    writes: ['$OUTPUT/smoke.txt'],
    usesNetwork: false,
    shareOutputWithAi: false,
  }
  const executed = await executor.run('smoke', proposal, context)
  assert.equal(executed.record.status, 'success')
  assert.deepEqual(executed.record.declaredOutputs, [outputPath])
  assert.deepEqual(executed.record.createdOutputs.map((item) => item.path), [outputPath])
  assert.equal(await readFile(join(fixture, outputPath), 'utf8'), 'safe output')
  assert.doesNotMatch(JSON.stringify(executed.record), new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(executed.output, /safe output/)

  await fakeVault.refreshFile(outputPath)
  await executor.undoCreatedOutputs(executed.record)
  assert.deepEqual(trashCalls, [{ path: outputPath }])
  await assert.rejects(readFile(join(fixture, outputPath)), { code: 'ENOENT' })

  await writeFile(join(fixture, outputPath), 'existing', 'utf8')
  await assert.rejects(executor.run('smoke', proposal, context), /拒绝覆盖/)
  await rm(join(fixture, outputPath))

  await assert.rejects(
    executor.run('smoke', proposal, { ...context, fullyReadPaths: [] }),
    /尚未完整读取/,
  )

  const missingOutputProposal = {
    ...proposal,
    label: '声明但不生成',
    args: ['$SKILL/scripts/write.mjs', '$TEMP/not-in-vault.txt'],
    writes: ['$OUTPUT/missing.txt'],
  }
  const missing = await executor.run('smoke', missingOutputProposal, context)
  assert.equal(missing.record.status, 'failed')
  assert.deepEqual(missing.record.createdOutputs, [])
  assert.match(missing.output, /missingDeclaredOutputs/)

  if (process.platform !== 'win32') {
    const outside = await mkdtemp(join(tmpdir(), 'ai-linzi-outside-script-'))
    try {
      const outsideScript = join(outside, 'outside.mjs')
      const linkedVaultPath = `${skillDirectory}/scripts/linked.mjs`
      await writeFile(outsideScript, 'console.log("outside")\n', 'utf8')
      await symlink(outsideScript, join(fixture, linkedVaultPath))
      await assert.rejects(
        executor.run(
          'smoke',
          { ...proposal, args: ['$SKILL/scripts/linked.mjs'], writes: [] },
          { ...context, fullyReadPaths: [linkedVaultPath] },
        ),
        /符号链接离开/,
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  }
} finally {
  await rm(fixture, { recursive: true, force: true })
}

console.log('local Skill executor integration tests passed')

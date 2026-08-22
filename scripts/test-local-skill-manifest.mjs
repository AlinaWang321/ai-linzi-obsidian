import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/local-skill-manifest.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const manifest = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

console.log('[test-local-skill-manifest]')

const wholeVault = manifest.parseLocalSkillManifest(JSON.stringify({
  schemaVersion: 2,
  skillVersion: '1.0.0',
  createdWith: 'AI霖子 Skill Studio',
  permissions: ['允许先查用户指定文件夹，没找到再搜索整个 Vault'],
  vaultRead: {
    scope: 'whole-vault',
    preferUserScope: true,
    fallbackToWholeVault: true,
    maxFiles: 120,
  },
  vaultWrite: {
    mode: 'create-note',
    confirmation: 'single-atomic-plan',
    overwrite: false,
  },
  network: 'ai-linzi-only',
  programs: [],
}), 'create-note')
assert.equal(wholeVault.kind, 'valid')
assert.equal(wholeVault.policy.vaultRead.scope, 'whole-vault')
assert.equal(wholeVault.policy.vaultRead.fallbackToWholeVault, true)

const invalidCurrent = manifest.parseLocalSkillManifest(JSON.stringify({
  schemaVersion: 2,
  permissions: ['当前笔记'],
  vaultRead: {
    scope: 'current-note',
    preferUserScope: false,
    fallbackToWholeVault: true,
    maxFiles: 1,
  },
  vaultWrite: { mode: 'chat', confirmation: 'single-atomic-plan', overwrite: false },
  network: 'ai-linzi-only',
  programs: [],
}), 'chat')
assert.equal(invalidCurrent.kind, 'invalid')

const invalidFolderFallback = manifest.parseLocalSkillManifest(JSON.stringify({
  schemaVersion: 2,
  permissions: ['只读用户指定的文件夹'],
  vaultRead: {
    scope: 'user-specified-folder',
    preferUserScope: true,
    fallbackToWholeVault: true,
    maxFiles: 80,
  },
  vaultWrite: { mode: 'chat', confirmation: 'single-atomic-plan', overwrite: false },
  network: 'ai-linzi-only',
  programs: [],
}), 'chat')
assert.equal(invalidFolderFallback.kind, 'invalid')

const legacyWhole = manifest.parseLocalSkillManifest(JSON.stringify({
  schemaVersion: 1,
  permissions: ['允许按 Skill 规则搜索整个 Vault，优先使用用户指定的文件夹'],
}), 'create-note')
assert.equal(legacyWhole.kind, 'valid')
assert.equal(legacyWhole.policy.source, 'legacy-v1')
assert.equal(legacyWhole.policy.vaultRead.scope, 'whole-vault')

const legacyCurrent = manifest.parseLocalSkillManifest(JSON.stringify({
  schemaVersion: 1,
  permissions: ['只读取你当前明确打开的一份咨询逐字稿'],
}), 'create-note')
assert.equal(legacyCurrent.kind, 'valid')
assert.equal(legacyCurrent.policy.vaultRead.scope, 'current-note')

assert.equal(manifest.parseLocalSkillManifest(undefined, 'chat').kind, 'missing')
assert.equal(manifest.parseLocalSkillManifest('{', 'chat').kind, 'invalid')

console.log('[test-local-skill-manifest] 全部通过')

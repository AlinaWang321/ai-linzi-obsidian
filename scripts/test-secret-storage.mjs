import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.doesNotMatch(source, /\bSecretComponent\b/, '设置页不得暴露 SecretStorage 条目 ID')
assert.match(source, /setName\('AI霖子连接密钥'\)/, '连接设置必须直接描述用户要粘贴的密钥')
assert.match(source, /无需填写密钥名称或 ID/, '设置页必须明确不需要额外的密钥 ID')
assert.match(source, /input\.inputEl\.type = 'password'/, '敏感值必须使用密码输入框')
assert.match(
  source,
  /setSecret\(DEFAULT_TOKEN_SECRET_ID, value\.trim\(\)\)/,
  'AI霖子连接密钥必须写入固定的内部安全条目',
)
assert.match(
  source,
  /setSecret\(DEFAULT_WECHAT_SECRET_ID, value\.trim\(\)\)/,
  '公众号 AppSecret 必须写入固定的内部安全条目',
)
assert.match(
  source,
  /const tokenToKeep = fixedToken \|\| legacyToken\?\.trim\(\) \|\| previousToken/,
  '升级时必须保留并迁移已有连接密钥',
)
assert.match(
  source,
  /const wechatToKeep = fixedWechat \|\| legacyWechatSecret\?\.trim\(\) \|\| previousWechat/,
  '升级时必须保留并迁移已有公众号 AppSecret',
)

console.log('secret storage settings tests: ok')

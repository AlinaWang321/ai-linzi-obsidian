import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')

assert.doesNotMatch(source, /\bSecretComponent\b/, '设置页不得暴露 SecretStorage 条目 ID')
assert.match(source, /setName\('AI霖子连接密钥'\)/, '连接设置必须直接描述用户要粘贴的密钥')
assert.match(source, /无需填写密钥名称或 ID/, '设置页必须明确不需要额外的密钥 ID')
assert.match(source, /input\.inputEl\.type = 'password'/, '敏感值必须使用密码输入框')
// 0.7.51 起写入必须走带回读自检的助手（Obsidian 1.13 setSecret 对不合规条目名
// 抛错；2026-08-18 AppSecret「填了也存不上、一直提示」事故——失败绝不能静默）。
assert.match(
  source,
  /writeSecretOrExplain\(DEFAULT_TOKEN_SECRET_ID, value\.trim\(\), 'AI霖子账号连接凭证'\)/,
  'AI霖子连接密钥必须经带自检的写入助手存入固定内部条目',
)
assert.match(
  source,
  /writeSecretOrExplain\(DEFAULT_WECHAT_SECRET_ID, value\.trim\(\), '公众号 AppSecret'\)/,
  '公众号 AppSecret 必须经带自检的写入助手存入固定内部条目',
)
assert.match(
  source,
  /writeSecretOrExplain\(DEFAULT_FISH_AUDIO_SECRET_ID, value\.trim\(\), 'Fish Audio API Key'\)/,
  'Fish Audio API Key 必须经带自检的写入助手存入固定内部条目',
)
assert.match(source, /setName\('Fish Audio API Key'\)/, '设置页必须提供 Fish Audio API Key 密码输入')
assert.match(source, /setName\('Fish Audio 音色 ID'\)/, '设置页必须提供 Fish Audio 音色 ID')
assert.match(source, /articleVideoFishModel: 's2\.1-pro-free'/, 'Fish Audio 课堂默认模型必须为免费开发模型')
assert.match(source, /setName\('Fish Audio 模型'\)/, '设置页必须允许在 Fish 免费与付费模型之间切换')
assert.match(source, /保存后校验失败/, '密钥写入必须回读自检，失败必须可见')
assert.match(source, /safeGetSecret/, '迁移段读取必须兜底 Obsidian 1.13 的条目名校验异常')
assert.match(source, /safeSetSecret/, '迁移段写入必须兜底，绝不能炸掉 loadSettings')
assert.match(source, /不是大模型 API Key/, '设置页必须说清账号连接凭证不是模型厂商 API Key')
assert.match(source, /不用该功能可留空/, '公众号 AppSecret 必须明确是选填项')
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

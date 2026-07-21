# AI霖子插件数据存储边界

## 跟 AI霖子账号走（云端）

- 学员账号、身份、套餐、积分与连接密钥的哈希
- AI霖子知识库与长期记忆
- 主对话消息（使用同一个 `sessionId` 写入 AI霖子服务端；插件历史云端优先、本机缓存兜底）
- Seedream 生成记录与扣费记录

这些数据不依赖 Alina 的个人电脑。更换电脑后，学员重新安装插件并生成新的连接密钥即可继续使用账号。

## 跟学员 Vault 走（由学员自行同步或备份）

- 学员自己的 Markdown 笔记
- 插入文章的配图
- 内容发布状态 frontmatter
- 插件产出的选题、公众号文章和分发稿

插件不得把整个 Vault 自动上传到 AI霖子服务器。需要跨设备时，由学员选择 Obsidian Sync、iCloud、OneDrive 或其他 Vault 备份方案。

## 只属于当前设备（不跨设备同步）

- AI霖子连接密钥明文
- 公众号 AppSecret
- 本地插件设置与会话缓存（不是主对话唯一副本）

敏感凭证使用 Obsidian `SecretStorage`，`data.json` 只保存 SecretStorage 条目名。设备损坏或更换后，AI霖子 Token 应在连接中心撤销旧密钥并生成新密钥；公众号 AppSecret 应从公众号后台重新填写或重置。

## GitHub 只保存什么

GitHub 仓库只保存插件源码、测试、文档和正式发布包。任何真实学员 Token、公众号密钥、对话、笔记或配图都不得提交到 GitHub。

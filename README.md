# AI霖子 Obsidian 插件

把 AI霖子（Alina 方法论 + 学员长期记忆的商业军师）接进用户的 Obsidian 数字大脑。

## 功能路线

- **M1（已完成骨架）**：设置页（服务器地址/Token/测试连接）+ 侧边栏对话面板（可带当前笔记上下文，非流式）
- **M2**：一键喂库（选中笔记 → AI霖子知识库章节，AI 建议章节）+ 四技能笔记即输入（选题雷达/公众号写作/多平台分发/谈单复盘），产出落盘「对外输出」+ frontmatter 落标
- **M3**：对话流式输出（fetch + SSE，服务端已支持）
- **v1.5**：内容看板视图（扫 vault frontmatter，Obsidian 内直接渲染看板+图表）

## 当前笔记局部修改（v0.4.5）

- 在侧边栏明确要求修改当前文章时，AI 只返回发生变化的“原文 → 改为”卡片，不再重复整篇文章。
- 点击「一键应用」后只精确替换这些位置；找不到原文或原文不唯一时会停止写入，避免误覆盖全文。
- 「存为笔记」「更新当前笔记」等操作统一放在每条 AI 回复的最底部。

## 公众号一条龙工作流（v0.4.5）

1. 用「公众号写作」或「原创访谈写作」生成文章。
2. 保存时自动把候选标题和摘要收进 frontmatter，只把可发布正文留在正文区。
3. 历史写法会自动归一为：`**PART 01**` 黄胶囊 + `## 金句小标题` 亮蓝大标题。
4. 配图先给出放置位置、核心意思和画面大字，用户确认后才生图扣积分。
5. 图片始终插在 frontmatter 之后；发布前若有图片缺失会停止发送，不会静默丢图。
6. 一键排版与一键发草稿箱共用同一份文章结构解析规则。

配图使用学员通用的极简小清新手绘人偶，不使用 Alina / AI霖子个人卡通手绘 IP。

## 本地开发

```bash
npm install
npm run dev        # watch 构建 main.js
npm run build      # tsc 类型检查 + 产线构建
npm test           # 写作结构 → 配图回写 → 公众号 HTML 回归测试
```

### 联调步骤

1. webapp 切到 `feature/obsidian-plugin` 分支，`.env.local` 加：
   ```
   PLUGIN_DEV_TOKEN=<随便一串长随机字符串>
   PLUGIN_DEV_STUDENT_NO=No.000
   ```
   起 dev server（localhost:3000）。
2. 把本目录的 `manifest.json` / `main.js` / `styles.css` 拷进测试 vault 的
   `.obsidian/plugins/ai-linzi/`，在 Obsidian 设置 → 第三方插件里启用。
3. 插件设置：服务器地址 `http://localhost:3000`，Token 填 `PLUGIN_DEV_TOKEN` 的值，点「测试连接」。

## 发布形态

- 训练营模板 vault 的 `.obsidian/plugins/ai-linzi/` 预装本插件（学员零安装）
- 更新走插件内自检下载（GitHub release），官方插件市场上架营后申请

## 安全约定

- Token 只存插件设置（vault 本地），服务端只存哈希；网页端可随时吊销
- AI 只写白名单文件夹（对外输出/收件箱），只新建不覆盖
- 服务端真相源：webapp `feature/obsidian-plugin` 分支 `/api/plugin/*`
- 产品方案真相源：Obsidian `04_Output/方案文档/㊙️2026.07.19_8月数字大脑训练营与AI霖子Obsidian插件_整合定稿方案.md`

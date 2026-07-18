# AI霖子 Obsidian 插件

把 AI霖子（Alina 方法论 + 学员长期记忆的商业军师）接进用户的 Obsidian 数字大脑。

## 功能路线

- **M1（已完成骨架）**：设置页（服务器地址/Token/测试连接）+ 侧边栏对话面板（可带当前笔记上下文，非流式）
- **M2**：一键喂库（选中笔记 → AI霖子知识库章节，AI 建议章节）+ 四技能笔记即输入（选题雷达/公众号写作/多平台分发/谈单复盘），产出落盘「对外输出」+ frontmatter 落标
- **M3**：对话流式输出（fetch + SSE，服务端已支持）
- **v1.5**：内容看板视图（扫 vault frontmatter，Obsidian 内直接渲染看板+图表）

## 本地开发

```bash
npm install
npm run dev        # watch 构建 main.js
npm run build      # tsc 类型检查 + 产线构建
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

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
const workflows = await readFile(new URL('../src/workflows.ts', import.meta.url), 'utf8')
const developmentContext = await readFile(new URL('../docs/开发上下文.md', import.meta.url), 'utf8')

assert.match(main, /workflowFolder: string/)
assert.match(main, /workflowFolder: 'AI霖子工作流'/)
assert.match(main, /我的工作流：创建、运行和管理/)
assert.match(main, /🔁 保存为工作流/)
assert.match(main, /🔁 保存这套工作流/)
assert.match(main, /isWorkflowDesignIntent\(previousUserText\)/)
assert.match(main, /initialInstruction: useDesignedWorkflow \? assistantText : previousUserText/)
assert.match(main, /buildWorkflowRunPrompt\(workflow, extraInstruction\)/)
assert.match(main, /this\.authorizedContentPaths\.length/)

assert.match(workflows, /ai_linzi_type: \$\{WORKFLOW_TYPE\}/)
assert.match(workflows, /AI_LINZI_WORKFLOW_INSTRUCTION/)
assert.match(workflows, /await app\.vault\.create\(path, markdown\)/)
assert.match(workflows, /await app\.vault\.modify\(file, markdown\)/)
assert.match(workflows, /await this\.app\.fileManager\.trashFile\(workflow\.file\)/)
assert.match(workflows, /只有你点击运行时才会连同本轮授权内容发送给 AI霖子/)
assert.match(workflows, /开始运行/)
assert.doesNotMatch(workflows, /api\/plugin|api\/skills|openai|deepseek|seedream/i)

assert.match(developmentContext, /学员自建工作流属于用户资产/)
assert.match(developmentContext, /创建、浏览、编辑和删除均为本地操作，不调用模型/)
assert.match(developmentContext, /多文件能力继续受 Pro\/Business 服务端门禁约束/)

console.log('personal workflow tests: ok')

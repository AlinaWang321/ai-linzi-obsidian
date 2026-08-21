// Skill 确认卡的**行为**测试（0.7.72 步 1）。
//
// 这是本仓库第一个真跑 DOM 的渲染测试：此前同类逻辑只能靠「在 main.ts 里 grep
// 字符串」断言，证明不了分支行为。Codex 对步 1 的验收条件明确要求覆盖
// 非法包 / 已创建 / 目录设置变化 / 创建成功 / 创建失败 / 立即试运行 /
// ZIP 导出成功 / ZIP 导出失败 八个分支，因此在这里逐个跑通。
//
// 做法：用最小 Obsidian 元素桩替换 createDiv/createEl/createSpan，
// 把 obsidian 与两个重依赖模块（skill-studio-core / create-local-skill-vault）
// 用 esbuild 插件换成可控替身，从而在 node 里直接调用渲染函数并点按钮。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// ── 最小 DOM 桩：只实现渲染函数用到的那几个 Obsidian 扩展方法 ──────────
function makeEl(tag = 'div') {
  const el = {
    tag,
    cls: '',
    text: '',
    children: [],
    disabled: false,
    onclick: null,
    attrs: {},
  }
  const child = (t, o = {}) => {
    const c = makeEl(t)
    if (o.cls) c.cls = o.cls
    if (o.text != null) c.text = o.text
    if (o.attr) c.attrs = { ...o.attr }
    el.children.push(c)
    return c
  }
  el.createEl = (t, o) => child(t, o)
  el.createDiv = (o) => child('div', o)
  el.createSpan = (o) => child('span', o)
  return el
}
/** 深度遍历取全部后代，便于按类名/文本查找。 */
function all(el, out = []) {
  for (const c of el.children) {
    out.push(c)
    all(c, out)
  }
  return out
}
const byText = (root, text) => all(root).find((e) => e.text === text)
const byCls = (root, cls) => all(root).filter((e) => (e.cls || '').split(/\s+/).includes(cls))

// ── 用替身模块打包被测文件 ────────────────────────────────────────────
const STUBS = {
  obsidian: `
    export class App {}
    export function normalizePath(p) { return String(p).replace(/\\/+/g, '/').replace(/\\/$/, '') }
  `,
  './skill-studio-core': `
    export function normalizeGeneratedSkillManifest(block) {
      return globalThis.__stub.normalizeGeneratedSkillManifest(block)
    }
    export function skillBlockManifest(block) {
      return globalThis.__stub.skillBlockManifest(block)
    }
  `,
  './create-local-skill-vault': `
    export function createLocalSkillBundleAtomically(app, root, block) {
      return globalThis.__stub.createLocalSkillBundleAtomically(app, root, block)
    }
  `,
}
const stubPlugin = {
  name: 'stub',
  setup(b) {
    for (const [name, contents] of Object.entries(STUBS)) {
      const filter = new RegExp(`^${name.replace(/[.\/]/g, '\\$&')}$`)
      b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: STUBS[a.path],
        loader: 'js',
      }))
    }
  },
}
const bundled = await build({
  entryPoints: ['src/create-local-skill-card.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [stubPlugin],
})
const { renderCreateLocalSkillOffers } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

// ── 默认替身与宿主 ────────────────────────────────────────────────────
const VALID_MANIFEST = {
  version: '1.0.0',
  permissions: ['只读取你点名的一份文件', '确认后才新建'],
  valid: true,
  problems: [],
}
function setup(over = {}) {
  const calls = {
    notices: [],
    filled: [],
    persisted: 0,
    rerendered: 0,
    opened: [],
    created: [],
    exported: [],
  }
  globalThis.__stub = {
    normalizeGeneratedSkillManifest: over.normalizeGeneratedSkillManifest
      ?? ((block) => ({ block, repairs: [] })),
    skillBlockManifest: over.skillBlockManifest ?? (() => VALID_MANIFEST),
    createLocalSkillBundleAtomically:
      over.createLocalSkillBundleAtomically
      ?? (async (_app, root, block) => {
        calls.created.push(block.name)
        return { root: `${root}/${block.name}`, files: [{ path: `${root}/${block.name}/SKILL.md` }] }
      }),
  }
  let currentRoot = over.rootSequence ? over.rootSequence.shift() : '05_System/Skills'
  const host = {
    app: { workspace: { openLinkText: (p) => calls.opened.push(p) } },
    skillsRoot: () => {
      const v = currentRoot
      if (over.rootSequence && over.rootSequence.length) currentRoot = over.rootSequence.shift()
      return v
    },
    outputFolder: () => '04_Output',
    fillInput: (t) => calls.filled.push(t),
    persist: async () => { calls.persisted += 1 },
    rerender: () => { calls.rerendered += 1 },
    notify: (t) => calls.notices.push(t),
    exportBundle: over.exportBundle
      ?? (async (_a, _o, block) => {
        calls.exported.push(block.name)
        return { path: '04_Output/demo.zip' }
      }),
  }
  return { host, calls, row: makeEl() }
}
const BLOCK = {
  name: 'demo-skill',
  description: '演示用 Skill',
  content: '# demo',
  files: [
    { path: 'SKILL.md', content: '# demo' },
    { path: 'references/spec.md', content: 'spec' },
  ],
}

console.log('第1组 待创建形态：标题、保存位置、权限清单、文件折叠、创建按钮')
{
  const { host, row } = setup()
  renderCreateLocalSkillOffers(host, row, [BLOCK], {})
  assert.ok(byText(row, '🧩 待创建 AI 工作流:demo-skill'), '缺标题')
  assert.ok(byText(row, '保存位置:05_System/Skills/demo-skill/（版本 1.0.0 · 共 2 个文件）'), '缺保存位置行')
  assert.equal(byCls(row, 'ai-linzi-skill-permissions').length, 1, '缺权限清单')
  assert.equal(all(row).filter((e) => e.tag === 'details').length, 2, '每个文件应有一个折叠预览')
  assert.ok(byText(row, '创建完整 Skill（2 个文件）'), '多文件应显示完整 Skill 按钮')
}

console.log('第2组 单文件时按钮文案不同')
{
  const { host, row } = setup()
  renderCreateLocalSkillOffers(host, row, [{ ...BLOCK, files: [BLOCK.files[0]] }], {})
  assert.ok(byText(row, '创建 SKILL.md'), '单文件应显示「创建 SKILL.md」')
}

console.log('第3组 非法包：不给创建按钮，只给拒绝说明')
{
  const { host, row } = setup({
    skillBlockManifest: () => ({ ...VALID_MANIFEST, valid: false, problems: ['缺少 manifest'] }),
  })
  renderCreateLocalSkillOffers(host, row, [BLOCK], { skillCreatorResult: true })
  assert.ok(byText(row, '本次不允许安装，请让 AI霖子重新生成完整 Skill 包。'), '缺拒绝说明')
  assert.equal(
    all(row).filter((e) => e.tag === 'button').length,
    0,
    '非法包不得出现任何按钮（含创建、试运行、导出）',
  )
  assert.ok(byText(row, '⚠️ Skill 包未通过本机校验'), '缺校验失败标题')
}

console.log('第4组 自动修正提示只在有 repairs 时出现')
{
  const { host, row } = setup({
    normalizeGeneratedSkillManifest: (block) => ({ block, repairs: ['补齐 skillVersion'] }),
  })
  renderCreateLocalSkillOffers(host, row, [BLOCK], { skillCreatorResult: true })
  assert.ok(byText(row, '✅ 本机已自动修正：补齐 skillVersion'))

  const plain = setup()
  renderCreateLocalSkillOffers(plain.host, plain.row, [BLOCK], {})
  assert.ok(
    !all(plain.row).some((e) => (e.text || '').startsWith('✅ 本机已自动修正')),
    '无 repairs 时不得出现修正提示',
  )
}

console.log('第5组 创建成功：回填 createdLocalSkill、落盘、重绘、提示')
{
  const { host, calls, row } = setup()
  const message = {}
  renderCreateLocalSkillOffers(host, row, [BLOCK], message)
  const btn = byText(row, '创建完整 Skill（2 个文件）')
  btn.onclick()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(btn.disabled, true, '点击后按钮应禁用，防重复提交')
  assert.deepEqual(message.createdLocalSkill, {
    root: '05_System/Skills/demo-skill',
    entry: '05_System/Skills/demo-skill/SKILL.md',
  })
  assert.equal(calls.persisted, 1, '创建成功必须落盘一次')
  assert.equal(calls.rerendered, 1, '创建成功必须重绘一次')
  assert.ok(calls.notices.some((n) => n.includes('已创建到“我的 Skills”')), '缺成功提示')
}

console.log('第6组 创建失败：按钮恢复可点、不落盘、不回填')
{
  const { host, calls, row } = setup({
    createLocalSkillBundleAtomically: async () => {
      throw new Error('已存在 05_System/Skills/demo-skill/')
    },
  })
  const message = {}
  renderCreateLocalSkillOffers(host, row, [BLOCK], message)
  const btn = byText(row, '创建完整 Skill（2 个文件）')
  btn.onclick()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(btn.disabled, false, '失败后必须恢复可点，否则用户卡死')
  assert.equal(message.createdLocalSkill, undefined, '失败不得回填 createdLocalSkill')
  assert.equal(calls.persisted, 0, '失败不得落盘')
  assert.ok(calls.notices.some((n) => n.startsWith('创建失败:')), '缺失败提示')
}

console.log('第7组 目录设置中途变化：不写入、提示并重绘，等用户按新路径重新确认')
{
  // 第 1 次取根目录（渲染时）= 旧值；第 2 次（点击时）= 新值
  const { host, calls, row } = setup({ rootSequence: ['05_System/Skills', '99_New/Skills'] })
  const message = {}
  renderCreateLocalSkillOffers(host, row, [BLOCK], message)
  const btn = byText(row, '创建完整 Skill（2 个文件）')
  btn.onclick()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(btn.disabled, false, '目录变化时不得禁用按钮')
  assert.equal(calls.created.length, 0, '⚠️ 目录变化时绝不能写入')
  assert.equal(calls.persisted, 0)
  assert.equal(calls.rerendered, 1, '应重绘以显示新路径')
  assert.ok(
    calls.notices.some((n) => n.includes('“我的 Skills”文件夹已改为 99_New/Skills/')),
    '缺目录变化提示',
  )
}

console.log('第8组 已创建形态：打开 / 立即试运行 / 导出 ZIP')
{
  const created = { root: '05_System/Skills/demo-skill', entry: '05_System/Skills/demo-skill/SKILL.md' }
  {
    const { host, calls, row } = setup()
    renderCreateLocalSkillOffers(host, row, [BLOCK], { createdLocalSkill: created })
    assert.ok(byText(row, '✅ 已创建'))
    assert.ok(!byText(row, '创建完整 Skill（2 个文件）'), '已创建后不得再显示创建按钮')
    byText(row, '打开 SKILL.md').onclick()
    assert.deepEqual(calls.opened, ['05_System/Skills/demo-skill/SKILL.md'])
  }
  {
    // 有 skillStudioTestInput 时用它
    const { host, calls, row } = setup()
    renderCreateLocalSkillOffers(host, row, [BLOCK], {
      createdLocalSkill: created,
      skillStudioTestInput: '  用 demo 处理今天的逐字稿  ',
    })
    byText(row, '立即试运行').onclick()
    assert.deepEqual(calls.filled, ['用 demo 处理今天的逐字稿'], '应 trim 后填入')
  }
  {
    // 无 skillStudioTestInput 时退回默认句
    const { host, calls, row } = setup()
    renderCreateLocalSkillOffers(host, row, [BLOCK], { createdLocalSkill: created })
    byText(row, '立即试运行').onclick()
    assert.deepEqual(calls.filled, ['用 demo-skill Skill 处理当前笔记'])
  }
}

console.log('第9组 导出 ZIP：成功与失败都要把按钮恢复可点')
{
  {
    const { host, calls, row } = setup()
    renderCreateLocalSkillOffers(host, row, [BLOCK], {
      createdLocalSkill: { root: '05_System/Skills/demo-skill', entry: 'x' },
    })
    const share = byText(row, '导出分享 ZIP')
    share.onclick()
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(calls.exported, ['demo-skill'])
    assert.equal(share.disabled, false, '导出成功后必须恢复可点')
    assert.ok(calls.notices.some((n) => n.includes('已导出可分享 Skill')))
  }
  {
    const { host, calls, row } = setup({
      exportBundle: async () => { throw new Error('磁盘已满') },
    })
    renderCreateLocalSkillOffers(host, row, [BLOCK], {
      createdLocalSkill: { root: '05_System/Skills/demo-skill', entry: 'x' },
    })
    const share = byText(row, '导出分享 ZIP')
    share.onclick()
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(share.disabled, false, '⚠️ 导出失败也必须恢复可点，否则再也导不了')
    assert.ok(calls.notices.some((n) => n === '导出失败：磁盘已满'))
  }
}

console.log('第10组 已创建判定按 skillRoot 精确比对，不同 Skill 不串卡')
{
  const { host, row } = setup()
  renderCreateLocalSkillOffers(host, row, [BLOCK], {
    createdLocalSkill: { root: '05_System/Skills/另一个技能', entry: 'x' },
  })
  assert.ok(!byText(row, '✅ 已创建'), '别的 Skill 的创建结果不得让本卡显示已创建')
  assert.ok(byText(row, '创建完整 Skill（2 个文件）'))
}

console.log('第11组 多个 block 各自独立成卡')
{
  const { host, row } = setup()
  renderCreateLocalSkillOffers(host, row, [BLOCK, { ...BLOCK, name: 'second-skill' }], {})
  assert.equal(byCls(row, 'ai-linzi-create-note-card').length, 2)
  assert.ok(byText(row, '🧩 待创建 AI 工作流:second-skill'))
}

console.log('create local skill card behavior tests: ok')

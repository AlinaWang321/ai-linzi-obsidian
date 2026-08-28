import esbuild from 'esbuild'
import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const prod = process.argv[2] === 'production'
const root = path.dirname(fileURLToPath(import.meta.url))

// docx 的 dist 产物内联了 jszip → lie/immediate/setimmediate 整条依赖链，
// 其中 IE 时代的动态 <script> 调度兜底无法用模块 alias 拦截。这里在加载
// docx dist 时把 createElement("script") 改写为 createElement("span")：
// 该分支只有在既无 MutationObserver 又无 MessageChannel 的上古环境才会
// 执行（Electron 永远不会），改写后特性探测直接落到 setTimeout 兜底，
// 运行行为不变，而发布产物中不再包含动态 <script> 注入代码。
// 背景：Obsidian 社区审核 2026-08-16 对 0.7.33 判 CODE OBFUSCATION Error。
const stripUnsafeThirdPartyRuntimeCode = {
  name: 'strip-unsafe-third-party-runtime-code',
  setup(build) {
    build.onLoad(
      { filter: /node_modules[\\/]docx[\\/]dist[\\/]index\.(mjs|cjs)$/ },
      async (args) => {
        const { readFile } = await import('node:fs/promises')
        const source = await readFile(args.path, 'utf8')
        const transformed = source
          .replaceAll('createElement("script")', 'createElement("span")')
          .replaceAll("createElement('script')", "createElement('span')")
          // setImmediate 的字符串回调是浏览器早期兼容面；插件与依赖只传函数。
          // 拒绝字符串回调比在用户 Vault 里动态编译任意文本更安全。
          .replaceAll(
            '"function" != typeof e && (e = new Function("" + e));',
            '"function" != typeof e && (() => { throw new TypeError("setImmediate callback must be a function"); })();',
          )
        if (/createElement\(\s*(["'])script\1\s*\)|\b(?:eval|new Function)\(/u.test(transformed)) {
          throw new Error(`docx 构建转换未清除动态脚本或动态代码：${args.path}`)
        }
        return {
          contents: transformed,
          loader: 'js',
        }
      },
    )
    build.onLoad(
      { filter: /node_modules[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf(?:\.worker)?\.mjs$/ },
      async (args) => {
        const { readFile } = await import('node:fs/promises')
        const source = await readFile(args.path, 'utf8')
        const transformed = source
          // Electron 不需要用动态代码探测 CSP；固定关闭后 PDF.js 自动使用解释器路径。
          .replaceAll(
            'function isEvalSupported() {\n  try {\n    new Function("");\n    return true;\n  } catch {\n    return false;\n  }\n}',
            'function isEvalSupported() {\n  return false;\n}',
          )
          // PostScript 函数仍走 PDF.js 自带解释器，功能保留，只关闭运行时编译优化。
          .replaceAll(
            'return new Function("src", "srcOffset", "dest", "destOffset", compiled);',
            'info("PostScript runtime compilation disabled; using interpreter.");',
          )
        if (/\b(?:eval|new Function)\(/u.test(transformed)) {
          throw new Error(`PDF.js 构建转换未清除动态代码：${args.path}`)
        }
        return { contents: transformed, loader: 'js' }
      },
    )
  },
}

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  // docx → jszip 依赖链里的 lie/immediate/setimmediate 是 IE 时代 polyfill，
  // 内含动态 <script> 调度兜底；Obsidian 审核按字面量判 CODE OBFUSCATION
  // Error（0.7.33 因此下架）。桌面端 Electron/Node 原生能力完全覆盖，
  // 构建期整体替换为 shims/ 下的原生实现，运行行为不变。
  alias: {
    lie: path.join(root, 'shims/lie.js'),
    immediate: path.join(root, 'shims/immediate.js'),
    setimmediate: path.join(root, 'shims/setimmediate.js'),
  },
  plugins: [stripUnsafeThirdPartyRuntimeCode],
  external: [
    'obsidian',
    'electron',
    'fs',
    'os',
    'path',
    'child_process',
    'crypto',
    '@codemirror/*',
    '@lezer/*',
  ],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  outfile: 'main.js',
})

if (prod) {
  await ctx.rebuild()
  process.exit(0)
} else {
  await ctx.watch()
}

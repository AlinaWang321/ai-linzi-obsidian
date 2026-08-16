// 构建期替身：setimmediate polyfill（jszip 副作用引入）。原包在旧浏览器里
// 用动态 <script> 调度任务，触发 Obsidian 审核 dynamic <script> Error。
// Obsidian 桌面端的 Electron/Node 自带 setImmediate，这里只在缺失时用
// setTimeout 兜底，不覆盖任何已有实现。
if (typeof globalThis.setImmediate !== 'function') {
  globalThis.setImmediate = function setImmediate(fn) {
    const args = Array.prototype.slice.call(arguments, 1)
    return setTimeout(() => fn.apply(null, args), 0)
  }
  globalThis.clearImmediate = (id) => clearTimeout(id)
}

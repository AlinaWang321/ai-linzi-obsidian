// 构建期替身：immediate 包（lie 的调度器）。原包在无 MutationObserver 的
// 上古浏览器里用动态 <script> onreadystatechange 调度微任务——在 Obsidian
// 桌面端是永远不会执行的死代码，但审核扫描器按字面量计数直接判 Error。
// lie 已整体替换为原生 Promise，本文件只兜底其他依赖直接 require 的情况。
module.exports = function immediate(task) {
  const args = Array.prototype.slice.call(arguments, 1)
  queueMicrotask(() => task.apply(null, args))
}

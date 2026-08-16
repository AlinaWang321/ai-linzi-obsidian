// 构建期替身：jszip 依赖的 lie（ES6 Promise polyfill）直接用原生 Promise。
// lie 的调度器 immediate 包含 IE 时代 <script> onreadystatechange 兜底，
// 会触发 Obsidian 审核 CODE OBFUSCATION 的 dynamic <script> Error（0.7.33 下架主因）。
// Obsidian 桌面端跑在 Electron/Node，原生 Promise 完全满足 jszip 的用法。
module.exports = Promise

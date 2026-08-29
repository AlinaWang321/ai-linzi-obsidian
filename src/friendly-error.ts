/**
 * 把底层网络/服务错误翻成用户能照着做的一句话（0.7.58）。
 *
 * 起因：木木在打卡营 D3 用 1 小时 28 分钟的长逐字稿跑销售复盘，右上角弹出
 * `谈单复盘失败：net::ERR_CONNECTION_CLOSED`。服务端 usage_log 里没有任何记录
 * ——请求在传输途中就断了，多半是长内容上传期间网络抖动。这种技术错误码对用户
 * 毫无意义，还会在课堂上把人吓住。
 *
 * 铁律（2026-08-18 Alina 拍板，全产品通用）：报错文案只给操作建议，
 * 绝不提计费、积分、扣分，也不外露内部机制与错误码。
 */
export function friendlyErrorMessage(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return '这次没有完成，请稍后重试'

  if (/Failed to fetch|Load failed|NetworkError when attempting to fetch resource/i.test(text)) {
    return '网络连接短暂中断了。系统已经尝试恢复；如果仍未完成，请换个网络后重试'
  }

  // 传输中断：长内容上传/下载途中连接被切断
  if (/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|socket hang up|ECONNRESET|Connection closed/i.test(text)) {
    return '网络中断了，内容没能传完。换个网络环境或稍后再试；逐字稿很长时，可以先拆成两段分别处理'
  }
  // 连不上
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return '连不上服务器，请检查网络后重试'
  }
  // 超时
  if (/timeout|timed out|ETIMEDOUT|FUNCTION_INVOCATION_TIMEOUT/i.test(text)) {
    return '这次处理时间太长被中断了。逐字稿很长时建议拆成两段分别处理'
  }
  // 证书/代理拦截（大陆网络下常见）
  if (/ERR_CERT|ERR_SSL|ERR_PROXY|certificate/i.test(text)) {
    return '网络连接被拦截了。如果开着加速器或代理，换一个节点或关掉后重试'
  }
  // 其余带 net:: 前缀的原始错误码一律不外露
  if (/^net::/i.test(text) || /^ERR_[A-Z_]+$/i.test(text)) {
    return '网络出了点问题，请稍后重试'
  }
  return text
}

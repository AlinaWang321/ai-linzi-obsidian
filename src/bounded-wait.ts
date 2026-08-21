/**
 * 给只影响辅助 UI 的远端读取加等待上限。
 *
 * 底层请求不会被强行取消；这里始终给原 Promise 挂上 resolve/reject 处理器，
 * 即使它稍后才结束也不会产生未处理异常。调用方超时后可立即回退本机数据。
 */
export function boundedWait<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    void promise.then(
      (value) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

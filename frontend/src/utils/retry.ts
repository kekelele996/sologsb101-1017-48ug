/**
 * 异步操作重试封装
 * 工序台保存失败后按本侧重试（只重试工序侧的写操作），检验室那份不动。
 * 纯前端应用：IndexedDB 偶发写入失败（如事务冲突、配额瞬时占用）时，退避重试可恢复。
 */

export interface RetryOptions {
  /** 最大重试次数（不含首次执行），默认 3 */
  retries?: number
  /** 首次重试前的基础等待毫秒数，默认 300 */
  delayMs?: number
  /** 退避倍数（每次重试等待 = delayMs * backoff^n），默认 2 */
  backoff?: number
  /** 每次重试前的回调（记录日志 / 提示） */
  onRetry?: (attempt: number, error: unknown) => void
}

/** 休眠指定毫秒数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 执行一个异步操作，失败时按退避策略重试。
 * 只重试传入的 fn —— 调用方应保证 fn 内只包含本侧（工序侧）的写操作，
 * 不要把检验室的写操作放进同一个 fn，避免重试时把检验记录也连带重写。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, delayMs = 300, backoff = 2, onRetry } = options
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < retries) {
        onRetry?.(attempt + 1, err)
        await sleep(delayMs * Math.pow(backoff, attempt))
      }
    }
  }
  throw lastError
}

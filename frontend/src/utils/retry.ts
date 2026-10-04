/**
 * 本侧重试工具
 * 工序台保存失败时只重试工序台这一侧（steps 表）的写入，
 * 不触碰检验室那份（inspects 表）——两边记录分开保存、互不连坐。
 */

export interface RetryOptions {
  /** 最多尝试次数（含首次），默认 3 */
  attempts?: number
  /** 两次尝试之间的退避毫秒数，默认 60ms */
  delayMs?: number
  /** 判定某个错误是否值得重试；默认 IndexedDB 瞬时错误一律重试 */
  shouldRetry?: (error: unknown, attempt: number) => boolean
}

const TRANSIENT_ERROR_PATTERN = /(QuotaExceeded|TransactionInactive|DataClone|ReadOnly|Database|AbortError|Timeout|blocked|Internal)/i

/**
 * 对一个只操作本地存储的异步动作做有限次指数退避重试。
 * 仅用于「本侧」落库：调用方必须保证 fn 内部不写对侧的表。
 */
export async function retryLocal<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delayMs = 60, shouldRetry } = options
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const retryable = shouldRetry ? shouldRetry(error, attempt) : TRANSIENT_ERROR_PATTERN.test(errorMessage(error))
      if (!retryable || attempt === attempts) break
      await sleep(delayMs * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError) || '本地保存失败')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

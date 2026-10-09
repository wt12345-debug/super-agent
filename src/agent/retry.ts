/**
 * 重试与退避策略模块
 * 提供对 LLM 调用、网络请求及工具执行异常的识别、退避时间计算及自动重试辅助工具
 */

export interface RetryOptions {
  /** 最大重试次数，默认为 3 */
  maxRetries?: number;
  /** 基础重试间隔（毫秒），默认为 500ms */
  baseMs?: number;
  /** 最大重试间隔上限（毫秒），默认为 30000ms (30s) */
  maxMs?: number;
  /** 自定义判断是否重试的策略函数，缺省使用 isRetryable */
  shouldRetry?: (error: unknown) => boolean;
  /** 重试触发时的回调钩子（可用于记录日志或上报监控） */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * 判断当前异常是否属于可重试的暂时性错误
 *
 * 识别范围包括：
 * 1. AI SDK 内置的 APICallError.isRetryable 标记
 * 2. HTTP 状态码：
 *    - 429 (Too Many Requests), 529 (Site Overloaded), 408 (Request Timeout)
 *    - 5xx (500~599 服务端瞬时故障或网关错误)
 *    - 4xx 客户端错误（如 400 参数错误、401/403 鉴权失败）默认不可重试
 * 3. 常见网络与 Socket 级瞬时异常（ECONNRESET, ETIMEDOUT, EPIPE, fetch failed 等）
 * 4. 大模型流式输出中断（No output generated 等）
 */
export function isRetryable(error: unknown): boolean {
  if (!error) return false;

  // 1. 优先检查 AI SDK 或第三方库显式声明的 isRetryable 属性
  if (typeof error === 'object' && error !== null) {
    const customRetryable = (error as { isRetryable?: unknown }).isRetryable;
    if (typeof customRetryable === 'boolean') {
      return customRetryable;
    }
  }

  // 提取错误对象中的信息
  const errObj = error as Record<string, unknown>;
  const message = error instanceof Error ? error.message : String(errObj.message || error);
  const code = typeof errObj.code === 'string' ? errObj.code : '';
  const name = error instanceof Error ? error.name : String(errObj.name || '');

  // 2. 提取 HTTP 状态码（优先从 status / statusCode 属性获取，防止误匹配普通文本中的三位数字）
  let status: number | null = null;

  if (typeof errObj.status === 'number') {
    status = errObj.status;
  } else if (typeof errObj.statusCode === 'number') {
    status = errObj.statusCode;
  } else if (errObj.response && typeof (errObj.response as Record<string, unknown>).status === 'number') {
    status = (errObj.response as Record<string, unknown>).status as number;
  } else {
    // 仅在明确带有 HTTP / Status / Code 前缀时才从 message 中提取状态码，避免误判端口号或普通数字
    const statusMatch = message.match(/(?:status(?:\s*code)?|http|code)\s*[:= ]?\s*(\d{3})\b/i);
    if (statusMatch) {
      status = parseInt(statusMatch[1], 10);
    }
  }

  if (status !== null) {
    // 限流、过载、超时错误，必然可重试
    if ([408, 429, 529].includes(status)) return true;
    // 5xx 服务端或模型供应商暂时性故障，可重试
    if (status >= 500 && status < 600) return true;
    // 4xx 客户端请求错误（如提示词过长被拒、API Key 无效），不可重试
    if (status >= 400 && status < 500) return false;
  }

  // 3. 系统级与网络级连接错误检测（优先比对标准 error.code）
  const networkCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ];
  if (code && networkCodes.includes(code.toUpperCase())) {
    return true;
  }

  // 4. 常见网络故障与流式中断的特征关键字匹配
  const lowerMsg = message.toLowerCase();
  if (
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('epipe') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('socket hang up') ||
    lowerMsg.includes('connection reset')
  ) {
    return true;
  }

  // 5. AI SDK 流式中断包装错误 (例如 NoOutputGeneratedError)
  if (name === 'NoOutputGeneratedError' || message.includes('No output generated')) {
    return true;
  }

  return false;
}

/**
 * 计算带随机抖动的指数退避延迟时间（Full Jitter / Symmetrical Jitter）
 *
 * 公式：
 *   delay = min(baseMs * 2^(attempt - 1), maxMs)
 *   jitter = delay ± 25%
 *
 * @param attempt 当前重试轮次（从 1 开始）
 * @param baseMs 初始退避基础时间（毫秒），默认为 500ms
 * @param maxMs 最大退避时间封顶（毫秒），默认为 30000ms
 * @returns 经过抖动计算后的延迟毫秒数
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBaseMs = Math.max(0, baseMs);
  const safeMaxMs = Math.max(safeBaseMs, maxMs);

  // 计算指数级增长时长
  const exponential = safeBaseMs * Math.pow(2, safeAttempt - 1);
  const capped = Math.min(exponential, safeMaxMs);

  // 施加 ±25% 的随机抖动，避免多个并发请求同步重试形成惊群效应 (Thundering Herd)
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(jittered));
}

/**
 * 异步等待函数
 * @param ms 等待的毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 带有自动退避重试执行的高阶函数包装器
 *
 * @param fn 需要执行的异步操作函数
 * @param options 重试配置选项
 * @returns 执行成功的结果 Promise
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseMs = 500,
    maxMs = 30000,
    shouldRetry = isRetryable,
    onRetry,
  } = options;

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt > maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseMs, maxMs);
      if (onRetry) {
        onRetry(error, attempt, delay);
      }

      await sleep(delay);
    }
  }
}

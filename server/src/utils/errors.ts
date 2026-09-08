export type ErrorType =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'server_error'
  | 'auth'
  | 'bad_request'
  | 'no_channel'
  | 'stream_aborted'
  | 'unknown';

export class GatewayError extends Error {
  status: number;
  type: ErrorType;
  retryable: boolean;
  upstreamBody?: string;

  constructor(status: number, message: string, type: ErrorType = 'unknown', retryable = false, upstreamBody?: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.upstreamBody = upstreamBody;
  }
}

/** 按上游 HTTP 状态码判定错误类型与是否可切换渠道重试 */
export function classifyStatus(status: number, body: string): { type: ErrorType; retryable: boolean; message: string } {
  const snippet = (body || '').slice(0, 500);
  if (status === 401 || status === 403) {
    return { type: 'auth', retryable: true, message: `上游鉴权失败 (${status}): ${snippet}` };
  }
  if (status === 429) {
    return { type: 'rate_limit', retryable: true, message: `上游限流 (429): ${snippet}` };
  }
  if (status === 408 || status === 409) {
    return { type: 'timeout', retryable: true, message: `上游请求超时/冲突 (${status}): ${snippet}` };
  }
  if (status >= 500) {
    return { type: 'server_error', retryable: true, message: `上游服务错误 (${status}): ${snippet}` };
  }
  // 400/404/413/422 等属于请求本身的问题，换渠道也大概率同样失败
  return { type: 'bad_request', retryable: false, message: `请求被上游拒绝 (${status}): ${snippet}` };
}

export function classifyFetchError(err: unknown): { type: ErrorType; retryable: boolean; message: string } {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return { type: 'timeout', retryable: true, message: '请求上游超时' };
  }
  if (e?.name === 'TypeError' || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(e?.message || '')) {
    return { type: 'network', retryable: true, message: `网络错误: ${e?.message || 'unknown'}` };
  }
  return { type: 'unknown', retryable: true, message: e?.message || '未知错误' };
}

/** 统一的带超时 fetch */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new GatewayError(502, c.message, c.type, c.retryable);
  } finally {
    clearTimeout(timer);
  }
}

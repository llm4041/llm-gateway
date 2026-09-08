const TOKEN_KEY = 'gw_admin_token';
const BASE = (import.meta as any).env?.VITE_API_BASE ?? '';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  // 仅在有请求体时设置 Content-Type，避免无 body 的 POST/DELETE 被 Fastify 拒绝
  // （Body cannot be empty when content-type is set to 'application/json'）
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: options.body != null ? { 'Content-Type': 'application/json', ...headers } : headers,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `请求失败 (${res.status})`;
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      clearToken();
      window.location.href = '/login';
    }
    throw new ApiError(res.status, msg);
  }
  return (json?.data ?? json) as T;
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
  put: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: body == null ? undefined : JSON.stringify(body) }),
  del: <T,>(p: string) => request<T>(p, { method: 'DELETE' }),
};

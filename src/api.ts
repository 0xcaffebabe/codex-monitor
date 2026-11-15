import type { User } from './types';
import { workspaceUrl } from './workspace-scope';
const KEY = 'codex-monitor.auth.v1';
export function getToken() {
  return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || '';
}
export function saveToken(token: string, remember = true) {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
  (remember ? localStorage : sessionStorage).setItem(KEY, token);
}
export function clearToken() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
  window.dispatchEvent(new Event('monitor:logout'));
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public state?: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(workspaceUrl(url), {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    let error = '请求失败，请稍后重试';
    let state: string | undefined;
    try {
      const result = await response.json();
      error = result.error || error;
      state = result.state;
    } catch {}
    if (response.status === 401 && !url.includes('/login')) clearToken();
    throw new ApiError(error, response.status, state);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const post = <T = any>(url: string, body?: unknown) =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
export async function currentUser() {
  return (await api<{ user: User }>('/api/auth/me')).user;
}
export async function stream(
  session: string | undefined,
  onEvent: (event: string) => void,
  signal: AbortSignal,
) {
  const response = await fetch(
    workspaceUrl(`/api/stream${session ? '?session=' + encodeURIComponent(session) : ''}`),
    { headers: { Authorization: `Bearer ${getToken()}` }, signal, cache: 'no-store' },
  );
  if (response.status === 401) {
    clearToken();
    return;
  }
  if (!response.ok) throw new Error('实时连接失败');
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let index;
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, index);
        pending = pending.slice(index + 2);
        const event = block
          .split('\n')
          .find((l) => l.startsWith('event: '))
          ?.slice(7);
        if (event === 'unauthorized') {
          clearToken();
          return;
        }
        if (event) onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!signal.aborted) throw new Error('连接已断开');
}

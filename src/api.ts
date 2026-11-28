import type { User } from './types';
import { workspaceSignal, workspaceUrl } from './workspace-scope';
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
async function request(url: string, options: RequestInit, fallbackError = '请求失败，请稍后重试') {
  const signal = workspaceSignal(url, options.signal);
  const response = await fetch(workspaceUrl(url), {
    ...options,
    signal,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  signal?.throwIfAborted();
  if (!response.ok) {
    let error = fallbackError;
    let state: string | undefined;
    try {
      const result = await response.json();
      error = result.error || error;
      state = result.state;
    } catch {}
    signal?.throwIfAborted();
    if (response.status === 401 && !url.includes('/login')) clearToken();
    throw new ApiError(error, response.status, state);
  }
  return { response, signal };
}
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const { response, signal } = await request(url, options);
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  signal?.throwIfAborted();
  return result;
}
export async function apiBlob(
  url: string,
  options: RequestInit = {},
  fallbackError?: string,
): Promise<Blob> {
  const { response, signal } = await request(url, options, fallbackError);
  const result = await response.blob();
  signal?.throwIfAborted();
  return result;
}
export const post = <T = any>(url: string, body?: unknown) =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
export async function currentUser() {
  return (await api<{ user: User }>('/api/auth/me')).user;
}
export async function stream(
  session: string | undefined,
  onEvent: (event: string, data: string | undefined) => void,
  signal: AbortSignal,
) {
  signal = workspaceSignal('/api/stream', signal)!;
  const response = await fetch(
    workspaceUrl(`/api/stream${session ? '?session=' + encodeURIComponent(session) : ''}`),
    { headers: { Authorization: `Bearer ${getToken()}` }, signal, cache: 'no-store' },
  );
  signal.throwIfAborted();
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
        const lines = block.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        if (event === 'unauthorized') {
          clearToken();
          return;
        }
        if (event) onEvent(event, lines.find((line) => line.startsWith('data: '))?.slice(6));
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!signal.aborted) throw new Error('连接已断开');
}

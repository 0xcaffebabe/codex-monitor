let active = '';
let requests = new AbortController();
const scopedRoute = /^\/api\/(?:overview|sessions|control|uploads|usage|stream)(?:[/?]|$)/;
const navigationEvent = 'monitor:navigate';
const navigationListeners = new Set<() => void>();
export const currentWorkspace = () => active;
const notifyNavigation = () => {
  // One browser listener keeps workspace and session updates in the same batch.
  for (const listener of navigationListeners) listener();
};

/** Cancel requests from the previous workspace before loading the next one. */
export function initializeWorkspace(id: string) {
  if (active === id) return;
  requests.abort();
  requests = new AbortController();
  active = id;
}
export function workspaceUrl(url: string, id = active) {
  return id && scopedRoute.test(url)
    ? `/api/workspaces/${encodeURIComponent(id)}${url.slice(4)}`
    : url;
}
export function workspaceSignal(url: string, signal?: AbortSignal | null) {
  if (!scopedRoute.test(url)) return signal ?? undefined;
  return signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
}
export function workspaceStorageKey(key: string, id = active) {
  return id && id !== 'local' ? `codex-monitor.workspace.${id}.${key}` : key;
}
export function subscribeNavigation(listener: () => void) {
  if (!navigationListeners.size) {
    window.addEventListener('popstate', notifyNavigation);
    window.addEventListener(navigationEvent, notifyNavigation);
  }
  navigationListeners.add(listener);
  return () => {
    navigationListeners.delete(listener);
    if (!navigationListeners.size) {
      window.removeEventListener('popstate', notifyNavigation);
      window.removeEventListener(navigationEvent, notifyNavigation);
    }
  };
}
export function navigateWorkspace(id: string, sessionId?: string, search?: URLSearchParams) {
  const params = new URLSearchParams(search);
  params.set('workspace', id);
  if (sessionId) {
    params.set('session', sessionId);
    if (params.get('view') === 'new') params.delete('view');
  } else params.delete('session');
  const url = location.pathname + '?' + params.toString();
  if (url !== location.pathname + location.search) history.pushState(null, '', url);
  window.dispatchEvent(new Event(navigationEvent));
}

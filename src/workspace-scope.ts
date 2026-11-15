let active = '';
/** A document has one immutable workspace. Navigation cancels all old in-flight work. */
export function initializeWorkspace(id: string) {
  if (active && active !== id) throw new Error('Workspace changes require navigation');
  active = id;
}
export function workspaceUrl(url: string) {
  return active && /^\/api\/(?:overview|sessions|control|uploads|usage|stream)(?:[/?]|$)/.test(url)
    ? `/api/workspaces/${encodeURIComponent(active)}${url.slice(4)}`
    : url;
}
export function workspaceStorageKey(key: string) {
  return active && active !== 'local' ? `codex-monitor.workspace.${active}.${key}` : key;
}
export function navigateWorkspace(id: string) {
  const params = new URLSearchParams();
  params.set('workspace', id);
  location.assign(location.pathname + '?' + params.toString());
}

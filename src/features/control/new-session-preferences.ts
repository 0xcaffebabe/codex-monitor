import type { ManagedWorkspace } from '../../workspaces';

type PreferenceScope =
  | [option: 'workspace', userId: string]
  | [option: 'project' | 'permission', userId: string, workspaceId: string];

export function readNewSessionPreference(...scope: PreferenceScope) {
  try {
    return localStorage.getItem(`codex-monitor.new-session-${scope.join('.')}`);
  } catch {
    return null;
  }
}

export function writeNewSessionPreference(value: string, ...scope: PreferenceScope) {
  try {
    localStorage.setItem(`codex-monitor.new-session-${scope.join('.')}`, value);
  } catch {}
}

export function preferredNewSessionWorkspace(
  userId: string,
  workspaces: ManagedWorkspace[],
  currentId?: string,
) {
  const saved = readNewSessionPreference('workspace', userId);
  return (
    workspaces.find((workspace) => workspace.online && workspace.id === saved) ??
    workspaces.find((workspace) => workspace.online && workspace.id === currentId) ??
    workspaces.find((workspace) => workspace.online)
  );
}

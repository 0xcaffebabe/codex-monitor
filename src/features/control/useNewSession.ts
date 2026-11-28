import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { User } from '../../types';
import type { Project } from '../../control-types';
import { useModelSettings } from './useModelSettings';
import { readNewSessionPreference, writeNewSessionPreference } from './new-session-preferences';
import { sessionPermissionModes, type SessionPermissionMode } from '../../approval-types';
import type { ManagedWorkspace } from '../../workspaces';
import { workspaceUrl } from '../../workspace-scope';

export type NewSessionProps = {
  user: User;
  workspaceId: string;
  workspaces: ManagedWorkspace[];
  onWorkspaceChange: (id: string) => void;
  initialPath?: string;
  onCreated: (id: string) => void;
};
export function useNewSession({
  initialPath,
  user,
  workspaceId,
}: Pick<NewSessionProps, 'initialPath' | 'user' | 'workspaceId'>) {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectChoice, setProjectChoice] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [creationPermissions, setCreationPermissions] = useState(false);
  const [savedProject] = useState(() => readNewSessionPreference('project', user.id, workspaceId));
  const preferredProject = projects.find((project) => project.id === (projectChoice || savedProject));
  const selected =
    (projectChoice && preferredProject?.id) ||
    projects.find((project) => project.path === initialPath)?.id ||
    preferredProject?.id ||
    projects[0]?.id ||
    '';
  const [permissionMode, setPermission] = useState<SessionPermissionMode>(() => {
    const saved = readNewSessionPreference('permission', user.id, workspaceId);
    return sessionPermissionModes.find((mode) => mode === saved) ?? 'inherit';
  });
  function selectProject(id: string) {
    setProjectChoice(id);
    writeNewSessionPreference(id, 'project', user.id, workspaceId);
    writeNewSessionPreference(workspaceId, 'workspace', user.id);
  }
  function setPermissionMode(mode: SessionPermissionMode) {
    setPermission(mode);
    writeNewSessionPreference(mode, 'permission', user.id, workspaceId);
    writeNewSessionPreference(workspaceId, 'workspace', user.id);
  }
  const modelSettings = useModelSettings(true, 'new', refresh, workspaceId);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{
      available: boolean;
      projects: Project[];
      reason?: string;
      creationPermissions?: boolean;
    }>(workspaceUrl('/api/control', workspaceId), { signal: controller.signal })
      .then((result) => {
        if (stopped) return;
        setProjects(result.projects);
        setCreationPermissions(!!result.creationPermissions);
        if (!result.available) setError(result.reason || 'Codex 暂不可用');
      })
      .catch((error) => {
        if (!stopped) setError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [refresh, workspaceId]);
  return {
    projects,
    selected,
    selectProject,
    error,
    loading,
    setRefresh,
    modelSettings,
    creationPermissions,
    permissionMode,
    setPermissionMode,
  };
}

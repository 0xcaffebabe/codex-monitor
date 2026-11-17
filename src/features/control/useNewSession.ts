import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { User } from '../../types';
import type { Project } from './types';
import { useModelSettings } from './useModelSettings';
import type { SessionPermissionMode } from '../../approval-types';
import type { ManagedWorkspace } from '../../workspaces';

export type NewSessionProps = {
  user: User;
  workspaceId: string;
  workspaces: ManagedWorkspace[];
  onWorkspaceChange: (id: string) => void;
  initialPath?: string;
  onCreated: (id: string) => void;
};
export function useNewSession({ initialPath }: Pick<NewSessionProps, 'initialPath'>) {
  const [projects, setProjects] = useState<Project[]>([]),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [creationPermissions, setCreationPermissions] = useState(false);
  const [supportsDesktopChannel, setSupportsDesktopChannel] = useState(false);
  const [desktopChannel, setDesktopChannel] = useState(false);
  const [permissionMode, setPermissionMode] = useState<SessionPermissionMode>('danger-full-access');
  const modelSettings = useModelSettings(true, 'new', refresh);
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError('');
    api<{
      available: boolean;
      projects: Project[];
      reason?: string;
      creationPermissions?: boolean;
      desktopChannel?: boolean;
    }>('/api/control')
      .then((result) => {
        if (stopped) return;
        setProjects(result.projects);
        setCreationPermissions(!!result.creationPermissions);
        setSupportsDesktopChannel(!!result.desktopChannel);
        if (!result.creationPermissions) setPermissionMode('danger-full-access');
        setSelected(
          result.projects.find((p) => p.path === initialPath)?.id || result.projects[0]?.id || '',
        );
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
    };
  }, [initialPath, refresh]);
  return {
    projects,
    selected,
    setSelected,
    error,
    loading,
    setRefresh,
    modelSettings,
    creationPermissions,
    supportsDesktopChannel,
    desktopChannel,
    setDesktopChannel,
    permissionMode,
    setPermissionMode,
  };
}

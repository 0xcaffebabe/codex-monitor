import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { User } from '../../types';
import type { Project } from './types';
import { useModelSettings } from './useModelSettings';
import type { SessionPermissionMode } from '../../approval-types';

export type NewSessionDialogProps = {
  user: User;
  initialPath?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
};
export function useNewSession({ initialPath }: NewSessionDialogProps) {
  const [projects, setProjects] = useState<Project[]>([]),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [creationPermissions, setCreationPermissions] = useState(false);
  const [permissionMode, setPermissionMode] = useState<SessionPermissionMode>('danger-full-access');
  const modelSettings = useModelSettings(true, 'new', refresh);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement;
    dialog.current?.focus();
    return () => focus?.focus();
  }, []);
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError('');
    api<{
      available: boolean;
      projects: Project[];
      reason?: string;
      creationPermissions?: boolean;
    }>('/api/control')
      .then((result) => {
        if (stopped) return;
        setProjects(result.projects);
        setCreationPermissions(!!result.creationPermissions);
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
    dialog,
    modelSettings,
    creationPermissions,
    permissionMode,
    setPermissionMode,
  };
}

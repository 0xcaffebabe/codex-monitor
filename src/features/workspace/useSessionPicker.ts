import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ManagedWorkspace } from '../../workspaces';
import { useSessionList } from './useSessionList';

export function useSessionPicker(includeArchived: boolean, providedWorkspaces?: ManagedWorkspace[]) {
  const [loadedWorkspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const workspaces = providedWorkspaces ?? loadedWorkspaces;
  const fetchWorkspaces = providedWorkspaces === undefined;
  const [workspaceId, setWorkspaceId] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!fetchWorkspaces) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api<{ workspaces: ManagedWorkspace[] }>('/api/workspaces', {
          signal: controller.signal,
        });
        setWorkspaces(result.workspaces);
        setError('');
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [fetchWorkspaces, refresh]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const list = useSessionList({
    query: search,
    project: '',
    tab: 'all',
    subagents: includeArchived,
    archived: includeArchived ? 'all' : 'false',
    sort: includeArchived ? 'running' : 'recent',
    workspaces: workspaceId
      ? workspaces.filter((workspace) => workspace.id === workspaceId)
      : workspaces,
  });
  return {
    ...list,
    workspaces,
    workspaceId,
    setWorkspaceId,
    query,
    setQuery,
    loading: (fetchWorkspaces && loading) || list.listBusy || query.trim() !== search,
    error: error || list.error,
    retry: () => {
      setRefresh((value) => value + 1);
      void list.loadList(false, true);
    },
  };
}

import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ManagedWorkspace } from '../../workspaces';
import { useSessionList } from '../workspace/useSessionList';

export function useSessionReference() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
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
  }, [refresh]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const list = useSessionList({
    query: search,
    project: '',
    tab: 'all',
    subagents: true,
    archived: 'all',
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
    loading: loading || list.listBusy || query.trim() !== search,
    error: error || list.error,
    retry: () => {
      setRefresh((value) => value + 1);
      void list.loadList(false, true);
    },
  };
}

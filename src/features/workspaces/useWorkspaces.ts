import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '../../api';
import type { ManagedWorkspace } from '../../workspaces';
import { initializeWorkspace, navigateWorkspace } from '../../workspace-scope';
import { copyText } from '../../shared/clipboard';

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const selected = useRef(new URLSearchParams(location.search).get('workspace') || '');
  const [activeId, setActiveId] = useState(selected.current);
  const [managing, setManaging] = useState(false),
    [name, setName] = useState(''),
    [pending, setPending] = useState('');
  const [connectionConfig, setConnectionConfig] = useState(''),
    [copied, setCopied] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<{ workspaces: ManagedWorkspace[] }>('/api/workspaces', { signal });
      if (signal?.aborted) return;
      if (!selected.current && result.workspaces.length) {
        selected.current = (
          result.workspaces.find((item) => item.online) || result.workspaces[0]
        ).id;
        const params = new URLSearchParams(location.search);
        params.set('workspace', selected.current);
        history.replaceState(null, '', location.pathname + '?' + params.toString());
        setActiveId(selected.current);
      }
      if (selected.current) initializeWorkspace(selected.current);
      setWorkspaces(result.workspaces);
      setError('');
    } catch (error) {
      if (!signal?.aborted) setError((error as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        await load(abort.signal);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const pop = () => {
      if (new URLSearchParams(location.search).get('workspace') !== selected.current)
        location.reload();
    };
    window.addEventListener('popstate', pop);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener('popstate', pop);
    };
  }, [load]);
  const showConfig = (id: string, key: string) => {
    const serverUrl = location.origin.replace(/^http/, 'ws');
    setConnectionConfig(
      `MONITOR_MODE=client\nMONITOR_SERVER_URL=${serverUrl}\nMONITOR_WORKSPACE_ID=${id}\nMONITOR_CLIENT_KEY=${key}\n`,
    );
    setCopied(false);
  };
  const action = async (id: string, operation: () => Promise<void>) => {
    setPending(id);
    setError('');
    try {
      await operation();
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending('');
    }
  };
  const create = () =>
    action('create', async () => {
      const result = await post<{ workspace: ManagedWorkspace; key: string }>('/api/workspaces', {
        name,
      });
      showConfig(result.workspace.id, result.key);
      setName('');
    });
  const rotate = (id: string) =>
    action(id, async () => {
      const result = await post<{ key: string }>(`/api/workspaces/${id}/rotate-key`);
      showConfig(id, result.key);
    });
  const remove = (id: string) =>
    action(id, async () => {
      await api(`/api/workspaces/${id}`, { method: 'DELETE' });
    });
  const rename = (id: string, name: string) =>
    action(id, async () => {
      await api(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    });
  const copy = async () => {
    try {
      await copyText(connectionConfig);
      setCopied(true);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return {
    workspaces,
    active: workspaces.find((item) => item.id === activeId),
    activeId,
    loading,
    error,
    managing,
    setManaging,
    name,
    setName,
    pending,
    connectionConfig,
    copied,
    create,
    rotate,
    remove,
    rename,
    copy,
    close: () => {
      setManaging(false);
      setConnectionConfig('');
    },
    select: navigateWorkspace,
  };
}
export type WorkspacesModel = ReturnType<typeof useWorkspaces>;

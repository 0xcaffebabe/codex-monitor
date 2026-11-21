import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '../../api';
import type { ManagedWorkspace } from '../../workspaces';
import { initializeWorkspace, navigateWorkspace, subscribeNavigation } from '../../workspace-scope';
import { copyText } from '../../shared/clipboard';
import { preferredNewSessionWorkspace } from '../control/new-session-preferences';

type ConnectionCopy =
  | { id: string; status: 'copying' | 'copied' }
  | { id: string; status: 'error'; message: string };

function clientCommand(id: string, key: string) {
  const serverUrl = location.origin.replace(/^http/, 'ws');
  return `npm run client -- --server-url "${serverUrl}" --workspace-id "${id}" --client-key "${key}"`;
}

export function useWorkspaces(userId: string) {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const selected = useRef(new URLSearchParams(location.search).get('workspace') || '');
  const [activeId, setActiveId] = useState(selected.current);
  const [managing, setManaging] = useState(false),
    [name, setName] = useState(''),
    [pending, setPending] = useState('');
  const [connectionCommand, setConnectionCommand] = useState(''),
    [copied, setCopied] = useState(false);
  const [connectionCopy, setConnectionCopy] = useState<ConnectionCopy | null>(null);
  const copyRequest = useRef<AbortController | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<{ workspaces: ManagedWorkspace[] }>('/api/workspaces', { signal });
      if (signal?.aborted) return;
      if (!selected.current && result.workspaces.length) {
        const params = new URLSearchParams(location.search);
        const defaultWorkspace =
          params.get('view') === 'new' && !params.get('session') && !params.get('project')
            ? preferredNewSessionWorkspace(userId, result.workspaces)
            : result.workspaces.find((item) => item.online);
        selected.current = (defaultWorkspace ?? result.workspaces[0]).id;
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
  }, [userId]);
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
    const unsubscribe = subscribeNavigation(() => {
      const id = new URLSearchParams(location.search).get('workspace') || '';
      selected.current = id;
      initializeWorkspace(id);
      setActiveId(id);
      if (!id) void refresh();
    });
    return () => {
      abort.abort();
      copyRequest.current?.abort();
      clearInterval(timer);
      unsubscribe();
    };
  }, [load]);
  const showCommand = (id: string, key: string) => {
    setConnectionCommand(clientCommand(id, key));
    setCopied(false);
  };
  const action = async (id: string, operation: () => Promise<void>) => {
    setPending(id);
    setError('');
    setConnectionCopy(null);
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
      showCommand(result.workspace.id, result.key);
      setName('');
    });
  const rotate = (id: string) =>
    action(id, async () => {
      const result = await post<{ key: string }>(`/api/workspaces/${id}/rotate-key`);
      showCommand(id, result.key);
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
    setConnectionCopy(null);
    try {
      await copyText(connectionCommand);
      setCopied(true);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const copyWorkspaceCommand = async (id: string) => {
    const request = new AbortController();
    copyRequest.current = request;
    setPending(id);
    setCopied(false);
    setConnectionCopy({ id, status: 'copying' });
    try {
      const command = api<{ key: string }>(
        `/api/workspaces/${encodeURIComponent(id)}/connection-key`,
        { signal: request.signal },
      ).then(({ key }) => clientCommand(id, key));
      await copyText(command);
      if (!request.signal.aborted) setConnectionCopy({ id, status: 'copied' });
    } catch (error) {
      if (!request.signal.aborted) {
        setConnectionCopy({
          id,
          status: 'error',
          message: (error as Error).message || '无法复制连接命令，请重试',
        });
      }
    } finally {
      copyRequest.current = null;
      setPending('');
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
    connectionCommand,
    copied,
    connectionCopy,
    create,
    rotate,
    remove,
    rename,
    copy,
    copyWorkspaceCommand,
    close: () => {
      copyRequest.current?.abort();
      setManaging(false);
      setConnectionCommand('');
      setConnectionCopy(null);
    },
    select: navigateWorkspace,
  };
}
export type WorkspacesModel = ReturnType<typeof useWorkspaces>;

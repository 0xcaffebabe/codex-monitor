import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { Overview } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';

type WorkspaceOverview = { summary?: Overview; failed?: boolean };

export function useOverview(workspaces: ManagedWorkspace[]) {
  const [overviews, setOverviews] = useState<Record<string, WorkspaceOverview | undefined>>({});
  const refresh = useRef<(id?: string) => void>(() => {});
  const loadOverviews = useCallback((id?: string) => refresh.current(id), []);
  const onlineKey = JSON.stringify(
    workspaces
      .filter((workspace) => workspace.online)
      .map(({ id }) => id)
      .sort(),
  );

  useEffect(() => {
    const onlineIds: string[] = JSON.parse(onlineKey);
    const requests = new Map<string, AbortController>();
    const load = async (id: string) => {
      if (requests.has(id)) return;
      const controller = new AbortController();
      requests.set(id, controller);
      try {
        const summary = await api<Overview>(`/api/workspaces/${encodeURIComponent(id)}/overview`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        setOverviews((current) => ({ ...current, [id]: { summary } }));
      } catch {
        if (!controller.signal.aborted)
          setOverviews((current) => ({ ...current, [id]: { ...current[id], failed: true } }));
      } finally {
        requests.delete(id);
      }
    };
    refresh.current = (id) => {
      if (id) {
        if (onlineIds.includes(id)) void load(id);
      } else {
        onlineIds.forEach((workspaceId) => void load(workspaceId));
      }
    };
    refresh.current();
    return () => {
      refresh.current = () => {};
      for (const request of requests.values()) request.abort();
    };
  }, [onlineKey]);

  return { overviews, loadOverviews };
}

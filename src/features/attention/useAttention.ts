import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { AttentionSnapshot } from '../../attention-types';
import type { ManagedWorkspace } from '../../workspaces';

type Observation = { snapshot?: AttentionSnapshot; error?: boolean };
export type AttentionWorkspace = Observation & { workspace: ManagedWorkspace; fresh: boolean };

function readCache(key: string): Record<string, Observation> {
  try {
    return JSON.parse(sessionStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}

export function useAttention(workspaces: ManagedWorkspace[], userId: string) {
  const key = `codex-monitor.attention.${userId}`;
  const [observations, setObservations] = useState(() => readCache(key));
  const current = useRef(observations);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const workspaceKey = JSON.stringify(workspaces.map(({ id, online }) => [id, online]).sort());
  useEffect(() => {
    const workspaces: [string, boolean][] = JSON.parse(workspaceKey);
    if (!workspaces.length) return;
    const controllers = new Map<string, AbortController>();
    const online = workspaces.filter(([, connected]) => connected);
    const commit = (next: Record<string, Observation>) => {
      current.current = next;
      setObservations(next);
    };
    commit(
      Object.fromEntries(workspaces.map(([id]) => [id, { ...current.current[id], error: true }])),
    );
    const save = () => {
      const entries = Object.entries(current.current).flatMap(([id, { snapshot }]) => {
        if (!snapshot || snapshot.observedAt < Date.now() - 86400000) return [];
        return [
          [
            id,
            {
              error: true,
              snapshot: {
                ...snapshot,
                approvals: { supported: false, requests: [] },
                questions: null,
                receipts: [],
                ended: [],
                stale: [],
              },
            },
          ],
        ];
      });
      try {
        sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
      } catch {}
    };
    const load = async (id: string) => {
      if (controllers.has(id)) return;
      const controller = new AbortController();
      controllers.set(id, controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
      try {
        const snapshot = await api<AttentionSnapshot>(
          `/api/workspaces/${encodeURIComponent(id)}/sessions/attention`,
          { signal },
        );
        if (!controller.signal.aborted) {
          commit({
            ...current.current,
            [id]: snapshot.available
              ? { snapshot }
              : { snapshot: current.current[id]?.snapshot, error: true },
          });
          save();
        }
      } catch {
        if (!controller.signal.aborted)
          commit({ ...current.current, [id]: { ...current.current[id], error: true } });
      } finally {
        controllers.delete(id);
      }
    };
    const update = () => online.forEach(([id]) => void load(id));
    refreshRef.current = update;
    update();
    const timer = setInterval(() => {
      if (!document.hidden) update();
    }, 5000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      controllers.forEach((controller) => controller.abort());
    };
  }, [workspaceKey, key]);
  const groups: AttentionWorkspace[] = workspaces.map((workspace) => {
    const observation = observations[workspace.id];
    return {
      workspace,
      ...observation,
      fresh: workspace.online && !!observation?.snapshot && !observation.error,
    };
  });
  return { groups, refresh };
}

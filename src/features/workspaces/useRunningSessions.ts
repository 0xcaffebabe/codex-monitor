import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Session } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';

type RunningSnapshot = { sessions: Session[]; error: string };
export type RunningWorkspace = RunningSnapshot & {
  workspace: ManagedWorkspace;
  loading: boolean;
};

export function useRunningSessions(workspaces: ManagedWorkspace[]): RunningWorkspace[] {
  const [snapshots, setSnapshots] = useState<Record<string, RunningSnapshot>>({});
  // Resource samples and workspace names change without changing which clients we poll.
  const onlineIds = JSON.stringify(
    workspaces
      .filter((workspace) => workspace.online)
      .map((workspace) => workspace.id)
      .sort(),
  );
  useEffect(() => {
    const ids: string[] = JSON.parse(onlineIds);
    let disposed = false;
    const requests = new Map<string, AbortController>();
    setSnapshots((previous) =>
      Object.fromEntries(ids.filter((id) => previous[id]).map((id) => [id, previous[id]])),
    );
    const load = async (id: string) => {
      if (requests.has(id)) return;
      const controller = new AbortController();
      requests.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const sessions: Session[] = [];
        let offset = 0;
        while (true) {
          const page = await api<{ sessions: Session[]; hasMore: boolean }>(
            `/api/workspaces/${encodeURIComponent(id)}/sessions?status=running&limit=100&offset=${offset}`,
            { signal: controller.signal },
          );
          sessions.push(...page.sessions);
          if (!page.hasMore || !page.sessions.length) break;
          offset += page.sessions.length;
        }
        if (!disposed) setSnapshots((previous) => ({ ...previous, [id]: { sessions, error: '' } }));
      } catch {
        if (!disposed)
          setSnapshots((previous) => ({
            ...previous,
            [id]: { sessions: [], error: '暂时无法加载，正在重试…' },
          }));
      } finally {
        clearTimeout(timeout);
        requests.delete(id);
      }
    };
    const refresh = () => {
      for (const id of ids) void load(id);
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const controller of requests.values()) controller.abort();
    };
  }, [onlineIds]);

  return workspaces.map((workspace) => ({
    workspace,
    sessions: workspace.online ? (snapshots[workspace.id]?.sessions ?? []) : [],
    error: workspace.online ? (snapshots[workspace.id]?.error ?? '') : '',
    loading: workspace.online && !snapshots[workspace.id],
  }));
}

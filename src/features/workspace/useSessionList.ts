import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { Session } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import { mergeWorkspaceSessions, type WorkspaceSession } from './session-list-model';

type SessionListPage = { sessions: Session[]; total: number };
type ListRequest = { key: string; controller: AbortController; promise: Promise<void> };

export function useSessionList({
  query,
  project,
  tab,
  subagents,
  workspaces,
  archived,
  sort = 'running',
  pageSize = 60,
  enabled = true,
}: {
  query: string;
  project: string;
  tab: string;
  subagents: boolean;
  workspaces: ManagedWorkspace[];
  archived?: 'true' | 'false' | 'all';
  sort?: 'recent' | 'running';
  pageSize?: number;
  enabled?: boolean;
}) {
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState(''),
    [listWarningLabels, setListWarningLabels] = useState<string[]>([]),
    [listBusy, setListBusy] = useState(true);
  const workspaceRef = useRef(workspaces);
  workspaceRef.current = workspaces;
  const workspaceKey = JSON.stringify(workspaces.map(({ id, online }) => [id, online]).sort());
  const loadedLimit = useRef(pageSize);
  const activeRequest = useRef<ListRequest | null>(null);
  const fetchList = useCallback(
    (append = false, preserveLoaded = false): Promise<void> => {
      if (!enabled) return Promise.resolve();
      const key = JSON.stringify([query, project, tab, subagents, workspaceKey, archived, sort]);
      if (preserveLoaded && activeRequest.current?.key === key)
        return activeRequest.current.promise;
      activeRequest.current?.controller.abort();
      if (append) loadedLimit.current += pageSize;
      else if (!preserveLoaded) loadedLimit.current = pageSize;
      const target = loadedLimit.current;
      const request: ListRequest = {
        key,
        controller: new AbortController(),
        promise: Promise.resolve(),
      };
      activeRequest.current = request;
      setListBusy(true);
      const timeout = setTimeout(() => request.controller.abort(), 10000);
      request.promise = (async () => {
        try {
          const configured = workspaceRef.current;
          const online = configured.filter((workspace) => workspace.online);
          const results = await Promise.allSettled(
            online.map(async (workspace) => {
              const params = new URLSearchParams({
                q: query,
                project,
                status: tab === 'running' ? 'running' : 'all',
                archived: archived ?? (tab === 'archived' ? 'true' : 'false'),
                subagents: String(subagents),
              });
              if (sort === 'recent') params.set('sort', sort);
              const page = (offset: number, limit: number) => {
                const search = new URLSearchParams(params);
                search.set('limit', String(limit));
                search.set('offset', String(offset));
                return api<SessionListPage>(
                  `/api/workspaces/${encodeURIComponent(workspace.id)}/sessions?${search}`,
                  { signal: request.controller.signal },
                );
              };
              const first = await page(0, Math.min(100, target));
              const rest: Promise<SessionListPage>[] = [];
              for (let offset = 100; offset < Math.min(target, first.total); offset += 100)
                rest.push(page(offset, Math.min(100, target - offset)));
              const pages = [first, ...(await Promise.all(rest))];
              return {
                sessions: pages.flatMap((page) =>
                  page.sessions.map((session) => ({
                    ...session,
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                  })),
                ),
                total: first.total,
              };
            }),
          );
          if (activeRequest.current !== request) return;
          const available: WorkspaceSession[] = [];
          let count = 0;
          const unavailable = configured
            .filter((workspace) => !workspace.online)
            .map((workspace) => `${workspace.name}（离线）`);
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              available.push(...result.value.sessions);
              count += result.value.total;
            } else unavailable.push(`${online[index].name}（加载失败）`);
          });
          // Each workspace's first N rows contain every candidate for the global first N rows.
          setSessions(mergeWorkspaceSessions(available, sort).slice(0, target));
          setTotal(count);
          setListWarningLabels(unavailable);
          setError(
            results.length && results.every((result) => result.status === 'rejected')
              ? '暂时无法查询工作空间中的会话，请重试。'
              : '',
          );
        } finally {
          clearTimeout(timeout);
          if (activeRequest.current === request) {
            activeRequest.current = null;
            setListBusy(false);
          }
        }
      })();
      return request.promise;
    },
    [query, project, tab, subagents, workspaceKey, archived, sort, pageSize, enabled],
  );

  const loadListRef = useRef(fetchList);
  loadListRef.current = fetchList;
  const loadList = useCallback(
    (append = false, preserveLoaded = false) => loadListRef.current(append, preserveLoaded),
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    setSessions([]);
    setTotal(0);
    setError('');
    setListWarningLabels([]);
    void loadList();
    const timer = setInterval(() => void loadList(false, true), 3000);
    return () => {
      clearInterval(timer);
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
    };
  }, [query, project, tab, subagents, workspaceKey, archived, sort, pageSize, enabled, loadList]);
  const listWarning = listWarningLabels.length
    ? `暂不可查询：${listWarningLabels.join('、')}。将自动重试。`
    : '';
  return { sessions, total, error, listWarning, listWarningLabels, listBusy, loadList };
}

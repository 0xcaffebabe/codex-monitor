import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import type { Session } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import { mergeWorkspaceSessions, type WorkspaceSession } from './session-list-model';

type SessionListPage = { sessions: Session[]; total: number };
type WorkspaceResult = (SessionListPage & { limit: number }) | 'failed';
type WorkspaceRequest = { limit: number; controller: AbortController; promise: Promise<void> };
type ListState = {
  query: string;
  pageSize: number;
  limit: number;
  results: ReadonlyMap<string, WorkspaceResult>;
};

async function fetchWorkspaceSessions(
  id: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SessionListPage> {
  const page = (offset: number, size: number) => {
    const params = new URLSearchParams(query);
    params.set('offset', String(offset));
    params.set('limit', String(size));
    return api<SessionListPage>(`/api/workspaces/${encodeURIComponent(id)}/sessions?${params}`, {
      signal,
    });
  };
  const first = await page(0, Math.min(100, limit));
  const rest: Promise<SessionListPage>[] = [];
  for (let offset = 100; offset < Math.min(limit, first.total); offset += 100)
    rest.push(page(offset, Math.min(100, limit - offset)));
  const pages = [first, ...(await Promise.all(rest))];
  return { sessions: pages.flatMap((page) => page.sessions), total: first.total };
}

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
  const [state, setState] = useState<ListState>();
  const workspaceRef = useRef(workspaces);
  workspaceRef.current = workspaces;
  const workspaceKey = JSON.stringify(workspaces.map(({ id, online }) => [id, online]).sort());
  const params = new URLSearchParams({
    q: query,
    project,
    status: tab === 'running' ? 'running' : 'all',
    archived: archived ?? (tab === 'archived' ? 'true' : 'false'),
    subagents: String(subagents),
  });
  if (sort === 'recent') params.set('sort', sort);
  const search = params.toString();

  const refresh = useRef<(append?: boolean, preserveLoaded?: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const loadList = useCallback(
    (append = false, preserveLoaded = false) => refresh.current(append, preserveLoaded),
    [],
  );
  useEffect(() => {
    setState(undefined);
    if (!enabled) return;
    const requests = new Map<string, WorkspaceRequest>();
    const results = new Map<string, WorkspaceResult>();
    let limit = pageSize;
    const publish = () => setState({ query: search, pageSize, limit, results: new Map(results) });

    const load = (id: string) => {
      const previous = requests.get(id);
      if (previous?.limit === limit) return previous.promise;
      previous?.controller.abort();
      const controller = new AbortController();
      const requestedLimit = limit;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
      const commit = (result: WorkspaceResult) => {
        if (controller.signal.aborted) return;
        results.set(id, result);
        publish();
      };
      const promise = fetchWorkspaceSessions(id, search, requestedLimit, signal)
        .then(
          (page) => commit({ ...page, limit: requestedLimit }),
          () => commit('failed'),
        )
        .finally(() => {
          if (requests.get(id)?.controller === controller) requests.delete(id);
          controller.abort();
        });
      requests.set(id, { limit: requestedLimit, controller, promise });
      return promise;
    };

    refresh.current = (append = false, preserveLoaded = false) => {
      const nextLimit = append ? limit + pageSize : preserveLoaded ? limit : pageSize;
      let changed = nextLimit !== limit;
      limit = nextLimit;
      const online = new Set(
        workspaceRef.current.filter(({ online }) => online).map(({ id }) => id),
      );
      for (const [id, request] of requests) {
        if (online.has(id)) continue;
        request.controller.abort();
        requests.delete(id);
      }
      for (const id of results.keys()) {
        if (online.has(id)) continue;
        results.delete(id);
        changed = true;
      }
      if (changed) publish();
      return Promise.all([...online].map(load)).then(() => {});
    };
    const timer = setInterval(() => void refresh.current(false, true), 3000);
    return () => {
      clearInterval(timer);
      refresh.current = () => Promise.resolve();
      for (const request of requests.values()) request.controller.abort();
    };
  }, [search, pageSize, enabled]);

  useEffect(() => {
    if (enabled) void loadList(false, true);
  }, [search, pageSize, enabled, workspaceKey, loadList]);

  return useMemo(() => {
    const current = state?.query === search && state.pageSize === pageSize ? state : undefined;
    const limit = current?.limit ?? pageSize;
    const available: WorkspaceSession[] = [];
    const online = workspaces.filter((workspace) => workspace.online);
    const listWarningLabels = workspaces
      .filter((workspace) => !workspace.online)
      .map((workspace) => `${workspace.name}（离线）`);
    let total = 0;
    let failed = 0;
    let waitingForFirst = false;
    let waitingForMore = false;
    for (const { id, name } of online) {
      const result = current?.results.get(id);
      if (!result) {
        waitingForFirst = true;
      } else if (result === 'failed') {
        failed++;
        listWarningLabels.push(`${name}（加载失败）`);
      } else {
        for (const session of result.sessions) {
          available.push({ ...session, workspaceId: id, workspaceName: name });
        }
        total += result.total;
        waitingForMore ||= result.limit < limit && result.sessions.length < result.total;
      }
    }
    // Each workspace's first N rows contain every candidate for the global first N rows.
    const sessions = mergeWorkspaceSessions(available, sort).slice(0, limit);
    return {
      sessions,
      total,
      error: failed > 0 && failed === online.length ? '暂时无法查询工作空间中的会话，请重试。' : '',
      listWarning: listWarningLabels.length
        ? `暂不可查询：${listWarningLabels.join('、')}。将自动重试。`
        : '',
      listWarningLabels,
      listBusy:
        enabled &&
        ((!sessions.length && waitingForFirst) || (sessions.length < limit && waitingForMore)),
      loadList,
    };
  }, [state, search, pageSize, workspaces, enabled, sort, loadList]);
}

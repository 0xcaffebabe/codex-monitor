import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { Session } from '../../types';

export function useSessionList({
  query,
  project,
  tab,
  subagents,
}: {
  query: string;
  project: string;
  tab: string;
  subagents: boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState(''),
    [listBusy, setListBusy] = useState(true);
  const listGeneration = useRef(0);
  const fetchList = useCallback(
    async (append = false, preserveLoaded = false) => {
      const generation = ++listGeneration.current;
      try {
        const params = new URLSearchParams({
          q: query,
          project,
          status: tab === 'running' ? 'running' : 'all',
          archived: tab === 'archived' ? 'true' : 'false',
          subagents: String(subagents),
        });
        const target = !append && preserveLoaded ? Math.max(60, sessions.length) : 60;
        const requests: Promise<{ sessions: Session[]; total: number }>[] = [];
        for (let offset = 0; offset < target; offset += 100) {
          const page = new URLSearchParams(params);
          page.set('limit', String(Math.min(100, target - offset)));
          page.set('offset', String(append ? sessions.length : offset));
          requests.push(api('/api/sessions?' + page));
        }
        const pages = await Promise.all(requests);
        const result = { sessions: pages.flatMap((page) => page.sessions), total: pages[0].total };
        if (generation !== listGeneration.current) return;
        setSessions((old) => [
          ...new Map(
            (append ? [...old, ...result.sessions] : result.sessions).map((s) => [s.id, s]),
          ).values(),
        ]);
        setTotal(result.total);
        setError('');
      } catch (e) {
        if (generation === listGeneration.current) setError((e as Error).message);
      } finally {
        if (generation === listGeneration.current) setListBusy(false);
      }
    },
    [query, project, tab, subagents, sessions.length],
  );

  const loadListRef = useRef(fetchList);
  loadListRef.current = fetchList;
  const loadList = useCallback(
    (append = false, preserveLoaded = false) => loadListRef.current(append, preserveLoaded),
    [],
  );
  useEffect(() => {
    setListBusy(true);
    void loadList();
    return () => {
      listGeneration.current++;
    };
  }, [query, project, tab, subagents, loadList]);
  return { sessions, total, error, listBusy, loadList };
}

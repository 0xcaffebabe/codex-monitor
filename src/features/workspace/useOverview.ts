import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { Overview, Session } from '../../types';

export function useOverview(workspaceId: string) {
  const controller = useMemo(() => new AbortController(), [workspaceId]);
  const [loadedWorkspace, setLoadedWorkspace] = useState('');
  const [overview, setOverview] = useState<Overview>(),
    [recentSessions, setRecentSessions] = useState<Session[]>([]),
    [recentLoaded, setRecentLoaded] = useState(false),
    [recentError, setRecentError] = useState(''),
    [overviewError, setError] = useState('');
  const loadRecentSessions = useCallback(async () => {
    try {
      const data = await api<{ sessions: Session[] }>(
        '/api/sessions?sort=recent&status=all&archived=all&limit=40',
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setRecentSessions(data.sessions);
      setRecentError('');
    } catch (error) {
      if (!controller.signal.aborted) setRecentError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setRecentLoaded(true);
    }
  }, [controller]);
  const loadOverview = useCallback(async () => {
    try {
      const [summary] = await Promise.all([
        api<Overview>('/api/overview', { signal: controller.signal }),
        loadRecentSessions(),
      ]);
      if (controller.signal.aborted) return;
      setOverview(summary);
      setError('');
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    }
  }, [controller, loadRecentSessions]);

  useEffect(() => {
    setLoadedWorkspace(workspaceId);
    setOverview(undefined);
    setRecentSessions([]);
    setRecentLoaded(false);
    setRecentError('');
    setError('');
    void loadOverview();
    return () => controller.abort();
  }, [workspaceId, controller, loadOverview]);
  const current = loadedWorkspace === workspaceId;
  return {
    overview: current ? overview : undefined,
    recentSessions: current ? recentSessions : [],
    recentLoaded: current && recentLoaded,
    recentError: current ? recentError : '',
    overviewError: current ? overviewError : '',
    loadOverview,
    loadRecentSessions,
  };
}

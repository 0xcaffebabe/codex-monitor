import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Overview, Session } from '../../types';

export function useOverview() {
  const [overview, setOverview] = useState<Overview>(),
    [runningSessions, setRunningSessions] = useState<Session[]>([]),
    [recentSessions, setRecentSessions] = useState<Session[]>([]),
    [recentLoaded, setRecentLoaded] = useState(false),
    [recentError, setRecentError] = useState(''),
    [overviewError, setError] = useState('');
  const loadRecentSessions = useCallback(async () => {
    try {
      const data = await api<{ sessions: Session[] }>(
        '/api/sessions?sort=recent&status=all&archived=all&limit=40',
      );
      setRecentSessions(data.sessions);
      setRecentError('');
    } catch (error) {
      setRecentError((error as Error).message);
    } finally {
      setRecentLoaded(true);
    }
  }, []);
  const loadOverview = useCallback(async () => {
    try {
      const [summary, running] = await Promise.all([
        api<Overview>('/api/overview'),
        api<{ sessions: Session[] }>('/api/sessions?status=running&limit=100'),
        loadRecentSessions(),
      ]);
      setOverview(summary);
      setRunningSessions(running.sessions);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [loadRecentSessions]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);
  return {
    overview,
    runningSessions,
    recentSessions,
    recentLoaded,
    recentError,
    overviewError,
    loadOverview,
    loadRecentSessions,
  };
}

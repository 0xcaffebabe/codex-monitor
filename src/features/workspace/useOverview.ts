import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Overview, Session } from '../../types';

export function useOverview() {
  const [overview, setOverview] = useState<Overview>(),
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
      const [summary] = await Promise.all([api<Overview>('/api/overview'), loadRecentSessions()]);
      setOverview(summary);
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
    recentSessions,
    recentLoaded,
    recentError,
    overviewError,
    loadOverview,
    loadRecentSessions,
  };
}

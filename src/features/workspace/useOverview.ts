import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { Overview } from '../../types';

export function useOverview(workspaceId: string) {
  const controller = useMemo(() => new AbortController(), [workspaceId]);
  const [loadedWorkspace, setLoadedWorkspace] = useState('');
  const [overview, setOverview] = useState<Overview>();
  const loadOverview = useCallback(async () => {
    try {
      const summary = await api<Overview>('/api/overview', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setOverview(summary);
    } catch {}
  }, [controller]);

  useEffect(() => {
    setLoadedWorkspace(workspaceId);
    setOverview(undefined);
    void loadOverview();
    return () => controller.abort();
  }, [workspaceId, controller, loadOverview]);
  const current = loadedWorkspace === workspaceId;
  return {
    overview: current ? overview : undefined,
    loadOverview,
  };
}

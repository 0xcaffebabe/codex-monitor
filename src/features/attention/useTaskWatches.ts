import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';

type Watch = { workspaceId: string; sessionId: string };

export function useTaskWatches(enabled: boolean) {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api<{ watches: Watch[] }>('/api/notifications/watches', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (!controller.signal.aborted) {
          setWatches(result.watches);
          setAvailable(true);
        }
      } catch {
        if (!controller.signal.aborted) setAvailable(false);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled]);
  const toggle = useCallback(async (workspaceId: string, sessionId: string, watched: boolean) => {
    const result = await api<{ watches: Watch[] }>('/api/notifications/watches', {
      method: 'PUT',
      body: JSON.stringify({ workspaceId, sessionId, watched }),
      signal: AbortSignal.timeout(10000),
    });
    setWatches(result.watches);
  }, []);
  return { available: available && enabled, watches, toggle };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { UsageData } from '../../types';

export function useUsage(params: string, revision?: string | number) {
  const [data, setData] = useState<UsageData>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  const running = useRef(false),
    controller = useRef<AbortController | null>(null),
    current = useRef(params);
  const load = useCallback(
    async (force = false) => {
      if (running.current) return;
      running.current = true;
      const request = new AbortController();
      controller.current = request;
      try {
        const result = await api<UsageData>(
          '/api/usage?' + params + (force ? '&refresh=true' : ''),
          { signal: request.signal },
        );
        if (!request.signal.aborted && current.current === params) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (!request.signal.aborted) setError((e as Error).message);
      } finally {
        if (controller.current === request) {
          running.current = false;
          setBusy(false);
        }
      }
    },
    [params],
  );
  useEffect(() => {
    controller.current?.abort();
    running.current = false;
    current.current = params;
    setData(undefined);
    setBusy(true);
    void load();
    return () => {
      controller.current?.abort();
      running.current = false;
    };
  }, [params, load]);
  useEffect(() => {
    if (revision) void load();
  }, [revision, load]);
  const scanning = data?.scan.running;
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!document.hidden) void load();
      },
      scanning ? 2000 : 15000,
    );
    return () => clearInterval(timer);
  }, [load, scanning]);
  return { data, error, busy, reload: () => void load(true) };
}

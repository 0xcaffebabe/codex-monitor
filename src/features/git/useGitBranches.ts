import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { GitBranches } from '../../git-types';

export function useGitBranches(base: string) {
  const [data, setData] = useState<GitBranches>();
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [switchError, setSwitchError] = useState('');
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (read.current || mutation.current) return;
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    try {
      const result = await api<GitBranches>(`${base}/branches`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setData(result);
        setError('');
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setData(undefined);
        setError((reason as Error).message);
      }
    } finally {
      if (read.current === controller) {
        read.current = null;
        setLoading(false);
      }
    }
  }, [base]);

  useEffect(() => {
    const update = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
      read.current?.abort();
      read.current = null;
      mutation.current?.abort();
      mutation.current = null;
    };
  }, [refresh]);

  const switchBranch = async (branch: string) => {
    if (mutation.current) return false;
    read.current?.abort();
    read.current = null;
    setLoading(false);
    const controller = new AbortController();
    mutation.current = controller;
    setSwitching(true);
    setSwitchError('');
    let succeeded = false;
    try {
      const result = await api<GitBranches>(`${base}/branch`, {
        method: 'POST',
        body: JSON.stringify({ branch }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setData(result);
        setError('');
        succeeded = true;
      }
    } catch (reason) {
      if (!controller.signal.aborted) setSwitchError((reason as Error).message);
    } finally {
      if (mutation.current === controller) {
        mutation.current = null;
        setSwitching(false);
      }
    }
    // A failed or timed-out checkout may still have changed HEAD. Read the actual state.
    if (!succeeded && !controller.signal.aborted) void refresh();
    return succeeded;
  };

  return { data, loading, switching, error, switchError, refresh, switchBranch };
}

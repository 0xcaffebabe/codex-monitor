import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { CompletionNotificationSnapshot } from '../../types';

export function useCompletionNotifications() {
  const [snapshot, setSnapshot] = useState<CompletionNotificationSnapshot>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dismissRequest = useRef<((ids?: number[]) => Promise<boolean>) | null>(null);

  useEffect(() => {
    let stopped = false;
    let current: CompletionNotificationSnapshot | undefined;
    let failed: { generation: string; ids: number[] } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let read: AbortController | undefined;
    let mutation: AbortController | undefined;

    const apply = (next: CompletionNotificationSnapshot) => {
      if (current?.generation === next.generation && next.revision < current.revision) return;
      const previousFailure = failed;
      if (
        previousFailure &&
        (previousFailure.generation !== next.generation ||
          !next.notifications.some((item) => previousFailure.ids.includes(item.id)))
      ) {
        failed = undefined;
        setError('');
      }
      current = next;
      setSnapshot(next);
    };
    const cancelRead = () => {
      read?.abort();
      read = undefined;
      clearTimeout(timer);
    };
    const refresh = async () => {
      if (stopped || read || mutation) return;
      const request = new AbortController();
      read = request;
      clearTimeout(timer);
      const timeout = setTimeout(() => request.abort(), 15000);
      try {
        const next = await api<CompletionNotificationSnapshot>('/api/notifications/completions', {
          signal: request.signal,
        });
        if (!stopped && read === request) apply(next);
      } catch {
        return;
      } finally {
        clearTimeout(timeout);
        if (read === request) {
          read = undefined;
          if (!stopped && !mutation) timer = setTimeout(refresh, 3000);
        }
      }
    };
    const dismiss = async (ids?: number[]) => {
      if (stopped || mutation || !current) return false;
      const observed = current;
      const targets = ids ?? observed.notifications.map((item) => item.id);
      if (!targets.length) return true;
      cancelRead();
      const request = new AbortController();
      mutation = request;
      const timeout = setTimeout(() => request.abort(), 15000);
      setPending(true);
      failed = undefined;
      setError('');
      try {
        const next = await api<CompletionNotificationSnapshot>(
          '/api/notifications/completions/dismiss',
          {
            method: 'POST',
            signal: request.signal,
            body: JSON.stringify({ generation: observed.generation, ids: targets }),
          },
        );
        if (stopped) return false;
        apply(next);
        return true;
      } catch (error) {
        if (!stopped) {
          failed = { generation: observed.generation, ids: targets };
          setError(
            `关闭通知失败：${error instanceof ApiError ? error.message : '网络暂时不可用'}，请重试。`,
          );
        }
        return false;
      } finally {
        clearTimeout(timeout);
        mutation = undefined;
        if (!stopped) {
          setPending(false);
          void refresh();
        }
      }
    };
    dismissRequest.current = dismiss;
    const resume = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      cancelRead();
      mutation?.abort();
      dismissRequest.current = null;
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  return {
    notifications: snapshot?.notifications ?? [],
    pending,
    error,
    dismiss: (id: number) => dismissRequest.current?.([id]) ?? Promise.resolve(false),
    dismissAll: () => dismissRequest.current?.() ?? Promise.resolve(false),
  };
}

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, stream } from '../../api';
import type { CompletionNotificationSnapshot } from '../../types';

export function useCompletionNotifications() {
  const [snapshot, setSnapshot] = useState<CompletionNotificationSnapshot>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dismissRequest = useRef<((ids?: number[]) => Promise<boolean>) | null>(null);

  useEffect(() => {
    const connection = new AbortController();
    let current: CompletionNotificationSnapshot | undefined;
    let failed: { generation: string; ids: number[] } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
    let delay = 1000;
    const connect = async () => {
      try {
        await stream('/api/notifications/completions/stream', (event, data) => {
          if (connection.signal.aborted || event !== 'snapshot' || data === undefined) return;
          apply(JSON.parse(data) as CompletionNotificationSnapshot);
          delay = 1000;
        }, connection.signal);
      } catch (error) {
        if (connection.signal.aborted || (error instanceof ApiError && error.status === 401)) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      }
    };
    const dismiss = async (ids?: number[]) => {
      if (connection.signal.aborted || mutation || !current) return false;
      const observed = current;
      const targets = ids ?? observed.notifications.map((item) => item.id);
      if (!targets.length) return true;
      const request = new AbortController();
      mutation = request;
      const timeout = setTimeout(() => request.abort(), 15000);
      setPending(true);
      failed = undefined;
      setError('');
      try {
        await api<CompletionNotificationSnapshot>(
          '/api/notifications/completions/dismiss',
          {
            method: 'POST',
            signal: request.signal,
            body: JSON.stringify({
              generation: observed.generation,
              ids: targets,
              ...(ids && { markRead: true }),
            }),
          },
        );
        return !connection.signal.aborted;
      } catch (error) {
        if (!connection.signal.aborted && current.generation === observed.generation &&
            current.notifications.some((item) => targets.includes(item.id))) {
          failed = { generation: observed.generation, ids: targets };
          setError(
            `关闭通知失败：${error instanceof ApiError ? error.message : '网络暂时不可用'}，请重试。`,
          );
        }
        return false;
      } finally {
        clearTimeout(timeout);
        mutation = undefined;
        if (!connection.signal.aborted) setPending(false);
      }
    };
    dismissRequest.current = dismiss;
    void connect();
    return () => {
      connection.abort();
      clearTimeout(timer);
      mutation?.abort();
      dismissRequest.current = null;
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

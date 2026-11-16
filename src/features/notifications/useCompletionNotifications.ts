import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { CompletionNotificationSnapshot } from '../../types';

type Actions = { dismiss: (ids?: number[]) => Promise<boolean> };

export function useCompletionNotifications(userId: string) {
  const [snapshot, setSnapshot] = useState<CompletionNotificationSnapshot>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const actions = useRef<Actions | null>(null);

  useEffect(() => {
    // Retire the former per-tab inbox; only Server decides which notices still exist.
    try {
      sessionStorage.removeItem(`codex-monitor.completion-notifications.v1.${userId}`);
    } catch {
      /* Optional cleanup. */
    }
    let stopped = false;
    let version = 0;
    let current: CompletionNotificationSnapshot | undefined;
    let failed: { generation: string; ids: number[] } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let read: AbortController | undefined;
    let mutation: AbortController | undefined;
    setSnapshot(undefined);
    setError('');
    setPending(false);

    const apply = (next: CompletionNotificationSnapshot) => {
      if (current?.generation === next.generation && next.revision < current.revision) return;
      if (
        failed &&
        (failed.generation !== next.generation ||
          !next.notifications.some((item) => failed!.ids.includes(item.id)))
      ) {
        failed = undefined;
        setError('');
      }
      current = next;
      setSnapshot(next);
    };
    const cancelRead = () => {
      version++;
      read?.abort();
      read = undefined;
      clearTimeout(timer);
    };
    const refresh = async () => {
      if (stopped || read || mutation) return;
      const request = new AbortController();
      read = request;
      const token = ++version;
      clearTimeout(timer);
      const timeout = setTimeout(() => request.abort(), 15000);
      try {
        const next = await api<CompletionNotificationSnapshot>('/api/notifications/completions', {
          signal: request.signal,
        });
        if (!stopped && token === version) apply(next);
      } catch {
        /* Keep the last confirmed snapshot and retry temporary failures. */
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
      // Invalidate reads already in flight, including responses whose bodies arrive after deletion.
      cancelRead();
      const request = new AbortController();
      mutation = request;
      const token = ++version;
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
        if (stopped || token !== version) return false;
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
        if (mutation === request) {
          mutation = undefined;
          if (!stopped) {
            setPending(false);
            void refresh();
          }
        }
      }
    };
    actions.current = { dismiss };
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
      actions.current = null;
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [userId]);

  return {
    notifications: snapshot?.notifications ?? [],
    pending,
    error,
    dismiss: (id: number) => actions.current?.dismiss([id]) ?? Promise.resolve(false),
    dismissAll: () => actions.current?.dismiss() ?? Promise.resolve(false),
  };
}

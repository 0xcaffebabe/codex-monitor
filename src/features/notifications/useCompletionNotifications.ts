import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { CompletionNotification, CompletionNotificationPage } from '../../types';

type Inbox = { cursor?: number; notifications: CompletionNotification[] };
function restore(key: string): Inbox {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (
      saved &&
      Number.isSafeInteger(saved.cursor) &&
      saved.cursor >= 0 &&
      Array.isArray(saved.notifications)
    )
      return saved;
  } catch {
    /* Storage may be disabled or full. Polling still works in memory. */
  }
  return { notifications: [] };
}

export function useCompletionNotifications(userId: string) {
  const key = `codex-monitor.completion-notifications.v1.${userId}`;
  const [inbox, setInbox] = useState<Inbox>(() => restore(key));
  const current = useRef(inbox);
  const update = useCallback(
    (next: Inbox) => {
      current.current = next;
      setInbox(next);
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Optional. */
      }
    },
    [key],
  );

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let busy = false;
    const poll = async () => {
      if (abort.signal.aborted || busy) return;
      busy = true;
      clearTimeout(timer);
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 15000);
      let hasMore = false;
      try {
        const cursor = current.current.cursor;
        const page = await api<CompletionNotificationPage>(
          '/api/notifications/completions' + (cursor === undefined ? '' : `?after=${cursor}`),
          { signal: request.signal },
        );
        if (abort.signal.aborted) return;
        const seen = new Set(current.current.notifications.map((item) => item.id));
        update({
          cursor: page.cursor,
          notifications: [
            ...current.current.notifications,
            ...page.notifications.filter((item) => !seen.has(item.id)),
          ].slice(-50),
        });
        hasMore = page.hasMore;
      } catch {
        /* Keep the cursor and retry after a temporary network/server failure. */
      } finally {
        clearTimeout(timeout);
        busy = false;
        if (!abort.signal.aborted) timer = setTimeout(poll, hasMore ? 0 : 3000);
      }
    };
    const resume = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    void poll();
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      abort.abort();
      request?.abort();
      clearTimeout(timer);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [update]);

  const dismiss = (id: number) =>
    update({
      ...current.current,
      notifications: current.current.notifications.filter((item) => item.id !== id),
    });
  const dismissAll = () => update({ ...current.current, notifications: [] });
  return { notifications: inbox.notifications, dismiss, dismissAll };
}

import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { SessionPermissionMode } from '../../approval-types';
import type { SessionStatus } from '../../types';

type SessionControlState = {
  available: boolean;
  owner?: 'monitor' | 'desktop';
  desktopChannel?: boolean;
  messagePermissions?: boolean;
  permissionMode?: Exclude<SessionPermissionMode, 'inherit'>;
  running?: boolean;
  compacting?: boolean;
  turnId?: string;
  reason?: string;
};

export function useSessionControl(threadId: string | undefined, sessionStatus?: SessionStatus) {
  const [snapshot, setSnapshot] = useState<{ threadId: string; state: SessionControlState }>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const state = await api<SessionControlState>(`/api/sessions/${threadId}/control`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSnapshot({ threadId, state });
      } catch (error) {
        if (!controller.signal.aborted)
          setSnapshot({ threadId, state: { available: false, reason: (error as Error).message } });
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [threadId, refresh, sessionStatus]);

  return {
    state: snapshot && snapshot.threadId === threadId ? snapshot.state : undefined,
    refresh,
    setRefresh,
    markStopped: () =>
      setSnapshot((previous) =>
        previous && previous.threadId === threadId
          ? { ...previous, state: { ...previous.state, running: false, compacting: false } }
          : previous,
      ),
  };
}

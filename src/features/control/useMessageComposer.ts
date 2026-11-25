import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import type { SessionContext, User } from '../../types';
import type { Receipt, SessionGoal } from './types';
import { useModelSettings } from './useModelSettings';
import type { useSessionControl } from './useSessionControl';
import { workspaceUrl } from '../../workspace-scope';

export type MessageComposerProps = {
  user: User;
  threadId: string;
  workspaceId?: string;
  control: ReturnType<typeof useSessionControl>;
  context?: SessionContext;
  contextControls?: ReactNode;
  onAccepted: () => void;
};
export function useMessageComposer({
  user,
  threadId,
  workspaceId,
  control: { state, refresh, setRefresh, markStopped },
  onAccepted,
}: MessageComposerProps, full: boolean) {
  const [goalOpen, setGoalOpen] = useState(false);
  const [controlNotice, setControlNotice] = useState('');
  const canChangeModel =
    user.role === 'admin' && !!state?.available && !state.running && !state.compacting;
  const modelSettings = useModelSettings(full && canChangeModel, threadId, refresh, workspaceId);
  const [goal, setGoal] = useState<SessionGoal | null>(),
    [goalError, setGoalError] = useState(''),
    [goalNotice, setGoalNotice] = useState('');
  useEffect(() => {
    if (user.role !== 'admin' || !full) return;
    const controller = new AbortController();
    let stopped = false,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const route = `/api/sessions/${encodeURIComponent(threadId)}/goal`;
        const data = await api<{ goal: SessionGoal | null }>(
          workspaceId ? workspaceUrl(route, workspaceId) : route,
          { signal: controller.signal },
        );
        if (!stopped) {
          setGoal(data.goal);
          setGoalError('');
          if (data.goal?.status === 'complete') setGoalNotice('');
        }
      } catch (error) {
        if (!stopped) setGoalError((error as Error).message);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [threadId, user.role, refresh, workspaceId, full]);
  const goalDone = (receipt: Receipt) => {
    if ('goal' in receipt) setGoal(receipt.goal);
    setGoalNotice(receipt.message || '目标已更新。');
    setRefresh((value) => value + 1);
    onAccepted();
  };
  const stopDone = () => {
    markStopped();
    setRefresh((value) => value + 1);
    onAccepted();
  };
  return {
    canChangeModel,
    modelSettings,
    state,
    setRefresh,
    goalOpen,
    setGoalOpen,
    goal,
    goalError,
    goalNotice,
    setGoalNotice,
    goalDone,
    controlNotice,
    setControlNotice,
    stopDone,
  };
}

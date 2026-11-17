import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import type { SessionStatus, User } from '../../types';
import type { Receipt, SessionGoal } from './types';
import { useModelSettings } from './useModelSettings';

export type MessageComposerProps = {
  user: User;
  threadId: string;
  sessionStatus?: SessionStatus;
  contextControls?: ReactNode;
  onAccepted: () => void;
};
export function useMessageComposer({
  user,
  threadId,
  sessionStatus,
  onAccepted,
}: MessageComposerProps) {
  const [state, setState] = useState<{
    available: boolean;
    desktopChannel?: boolean;
    running?: boolean;
    compacting?: boolean;
    turnId?: string;
    reason?: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const [goalOpen, setGoalOpen] = useState(false);
  const [controlNotice, setControlNotice] = useState('');
  const canChangeModel =
    user.role === 'admin' && !!state?.available && !state.running && !state.compacting;
  const modelSettings = useModelSettings(canChangeModel, threadId, refresh);
  const [goal, setGoal] = useState<SessionGoal | null>(),
    [goalError, setGoalError] = useState(''),
    [goalNotice, setGoalNotice] = useState('');
  useEffect(() => {
    if (user.role !== 'admin') return;
    const controller = new AbortController();
    let stopped = false,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await api<{ goal: SessionGoal | null }>(`/api/sessions/${threadId}/goal`, {
          signal: controller.signal,
        });
        if (!stopped) {
          setGoal(data.goal);
          setGoalError('');
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
  }, [threadId, user.role, refresh]);
  const goalDone = (receipt: Receipt) => {
    if ('goal' in receipt) setGoal(receipt.goal);
    setGoalNotice(receipt.message || '目标已更新。');
    setRefresh((value) => value + 1);
    onAccepted();
  };
  const stopDone = () => {
    setState((previous) => previous && { ...previous, running: false, compacting: false });
    setRefresh((value) => value + 1);
    onAccepted();
  };
  useEffect(() => {
    if (user.role !== 'admin') return;
    let stopped = false,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api<any>(`/api/sessions/${threadId}/control`);
        if (!stopped) setState(result);
      } catch (error) {
        if (!stopped) setState({ available: false, reason: (error as Error).message });
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [threadId, user.role, refresh, sessionStatus]);

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

import React, { useRef, useState } from 'react';
import { api, ApiError, post } from '../../api';
import type { User } from '../../types';
import { newRequestId } from './request-id';
import type { Receipt } from './types';
import { workspaceStorageKey } from '../../workspace-scope';

export type CommandButtonProps = {
  user: User;
  threadId: string;
  command: string;
  label: string;
  disabled?: boolean;
  onDone: (receipt: Receipt) => void;
  children?: React.ReactNode;
  iconOnly?: boolean;
  onFeedback?: (message: string) => void;
  className?: string;
  turnId?: string;
};
export function useCommand({
  user,
  threadId,
  command,
  turnId,
  onDone,
  onFeedback,
}: CommandButtonProps) {
  const key = workspaceStorageKey(`codex-monitor.command.${user.id}.${threadId}.${command}`);
  const [requestId, setRequestId] = useState(() => sessionStorage.getItem(key) || '');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const locked = useRef(false);
  const report = (text: string) => {
    setMessage(text);
    onFeedback?.(text);
  };
  function receive(result: Receipt) {
    if (result.state === 'succeeded' || result.state === 'failed') {
      sessionStorage.removeItem(key);
      setRequestId('');
    }
    report(result.message || result.error || '操作仍在处理，请稍后查询。');
    if (result.state === 'succeeded') onDone(result);
  }
  async function run() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    report('');
    try {
      if (requestId) receive(await api<Receipt>('/api/control/requests/' + requestId));
      else {
        const id = newRequestId();
        sessionStorage.setItem(key, id);
        setRequestId(id);
        receive(
          await post<Receipt>(`/api/sessions/${threadId}/commands`, {
            requestId: id,
            command,
            ...(turnId ? { turnId } : {}),
          }),
        );
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.state === 'failed' || [400, 401, 403, 404].includes(error.status))
      ) {
        sessionStorage.removeItem(key);
        setRequestId('');
      }
      report((error as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  const reset = () => {
    sessionStorage.removeItem(key);
    setRequestId('');
    report('');
  };
  return { requestId, busy, message, run, reset };
}

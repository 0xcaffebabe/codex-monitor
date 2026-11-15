import { Target, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { User } from '../../types';
import { CommandButton } from './CommandButton';
import { goalDuration, goalStatuses } from './goal';
import { PromptForm } from './PromptForm';
import type { Receipt, SessionGoal } from './types';

export function GoalDialog({
  user,
  threadId,
  goal,
  error,
  onRefresh,
  onClose,
  onDone,
}: {
  user: User;
  threadId: string;
  goal: SessionGoal | null | undefined;
  error: string;
  onRefresh: () => void;
  onClose: () => void;
  onDone: (receipt: Receipt) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="control-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-title"
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Tab') {
            const nodes = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),textarea:not(:disabled)',
            );
            if (!nodes?.length) return;
            if (event.shiftKey && document.activeElement === nodes[0]) {
              event.preventDefault();
              nodes[nodes.length - 1].focus();
            } else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
              event.preventDefault();
              nodes[0].focus();
            }
          }
        }}
      >
        <header>
          <Target size={22} />
          <h2 id="goal-title">目标管理</h2>
          <button className="icon-button" title="关闭目标管理" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p className="control-hint">设置目标后，Codex 会持续执行，直到完成、暂停或遇到阻碍。</p>
        {error && (
          <p className="control-error" role="alert">
            {error}{' '}
            <button className="secondary" onClick={onRefresh}>
              重试
            </button>
          </p>
        )}
        <div className="current-goal" aria-label="当前目标">
          {goal === undefined ? (
            '正在读取目标…'
          ) : goal === null ? (
            '此会话尚未设置目标。'
          ) : (
            <>
              <strong>{goalStatuses[goal.status] || goal.status}</strong>
              <p>{goal.objective}</p>
              <small>
                {Number(goal.tokensUsed || 0).toLocaleString()} tokens · 已执行{' '}
                {goalDuration(goal.timeUsedSeconds)}
              </small>
            </>
          )}
        </div>
        {goal && (
          <div className="goal-actions">
            {goal.status === 'active' && (
              <CommandButton
                user={user}
                threadId={threadId}
                command="goal.pause"
                label="暂停目标"
                onDone={onDone}
              />
            )}
            {['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status) && (
              <CommandButton
                user={user}
                threadId={threadId}
                command="goal.resume"
                label="继续目标"
                onDone={onDone}
              />
            )}
            <CommandButton
              user={user}
              threadId={threadId}
              command="goal.clear"
              label="清除目标"
              onDone={onDone}
            />
          </div>
        )}
        {goal !== undefined && (
          <PromptForm
            storageKey={`codex-monitor.draft.${user.id}.${threadId}.goal`}
            url={`/api/sessions/${threadId}/commands`}
            extra={{ command: 'goal.set' }}
            inputLabel="目标内容"
            initialPrompt={goal?.objective || ''}
            maxLength={4000}
            label={goal ? '保存修改并执行' : '设置目标并执行'}
            enabled={!error && goal !== undefined}
            onAccepted={onDone}
          />
        )}
      </div>
    </div>
  );
}

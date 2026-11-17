import { Minimize2, Pause, Pencil, Play, RefreshCw, Square, Target } from 'lucide-react';
import { CommandButton } from './CommandButton';
import { goalDuration, goalStatuses } from './goal';
import { GoalDialog } from './GoalDialog';
import { PromptForm } from './PromptForm';
import { MessageComposerProps, useMessageComposer } from './useMessageComposer';
import { ModelSettings } from './ModelSettings';
import { ApprovalPanel } from './ApprovalPanel';
import { promptShortcuts } from './prompt-shortcuts';

export function MessageComposer(props: MessageComposerProps) {
  const { user, threadId, onAccepted, contextControls } = props;
  const {
    state,
    canChangeModel,
    modelSettings,
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
  } = useMessageComposer(props);
  if (user.role !== 'admin') return null;
  return (
    <div
      className={'message-composer' + (!state?.available ? ' unavailable' : '')}
      aria-label="向会话发送消息"
    >
      <div className="composer-heading">
        {contextControls}
        <strong>{state?.running ? '向当前执行追加消息' : '继续此会话'}</strong>
        <button
          type="button"
          className="icon-button"
          title="刷新发送状态"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <ApprovalPanel key={threadId} threadId={threadId} />
      {(!state?.available || state.compacting) && (
        <p className="control-hint">{state?.reason || '正在连接 Codex…'}</p>
      )}
      {goal && (
        <div className="session-goal-strip" aria-label="会话目标" data-status={goal.status}>
          <button
            type="button"
            className="goal-summary"
            title={`${goalStatuses[goal.status] || goal.status}：${goal.objective}`}
            aria-label={`查看目标：${goal.objective}`}
            onClick={() => setGoalOpen(true)}
          >
            <Target size={16} />
            <span
              className="goal-status-dot"
              aria-label={goalStatuses[goal.status] || goal.status}
            />
            <span className="goal-objective">{goal.objective}</span>
          </button>
          <span
            className="goal-duration"
            aria-label={`目标已执行 ${goalDuration(goal.timeUsedSeconds)}`}
            title="Codex 记录的累计执行时长"
          >
            已执行 {goalDuration(goal.timeUsedSeconds)}
          </span>
          <div className="goal-strip-actions">
            <button
              type="button"
              className="icon-button"
              title="修改目标"
              aria-label="修改目标"
              onClick={() => setGoalOpen(true)}
            >
              <Pencil size={15} />
            </button>
            {goal.status === 'active' ? (
              <CommandButton
                key="pause"
                user={user}
                threadId={threadId}
                command="goal.pause"
                label="暂停目标"
                iconOnly
                onFeedback={setGoalNotice}
                onDone={goalDone}
              >
                <Pause size={16} />
              </CommandButton>
            ) : ['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status) ? (
              <CommandButton
                key="resume"
                user={user}
                threadId={threadId}
                command="goal.resume"
                label="继续目标"
                disabled={!state?.available || !!state?.compacting}
                iconOnly
                onFeedback={setGoalNotice}
                onDone={goalDone}
              >
                <Play size={16} />
              </CommandButton>
            ) : null}
            <CommandButton
              user={user}
              threadId={threadId}
              command="goal.clear"
              label="停止目标"
              iconOnly
              onFeedback={setGoalNotice}
              onDone={goalDone}
            >
              <Square size={14} />
            </CommandButton>
          </div>
        </div>
      )}
      {goalNotice && (
        <p className="goal-strip-notice" role="status">
          {goalNotice}
        </p>
      )}
      {goalError && !goalOpen && (
        <p className="goal-strip-error" role="status">
          {goalError}
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            重试目标
          </button>
        </p>
      )}
      <PromptForm
        storageKey={`codex-monitor.draft.${user.id}.${threadId}`}
        submitOnEnter
        allowAttachments
        projectFilesUrl={`/api/sessions/${threadId}/files`}
        allowDesktopChannel={!!state?.desktopChannel}
        promptShortcuts={promptShortcuts}
        shortcutActions={[
          {
            id: 'compact',
            label: '压缩上下文',
            description: '本轮结束后整理上下文',
            render: (close) => (
              <CommandButton
                user={user}
                threadId={threadId}
                command="compact"
                disabled={!state?.available || !!state?.running || !!state?.compacting}
                label="压缩上下文"
                onFeedback={setControlNotice}
                onDone={() => {
                  close();
                  setRefresh((value) => value + 1);
                  onAccepted();
                }}
              >
                <Minimize2 size={17} />
              </CommandButton>
            ),
          },
          {
            id: 'goal',
            label: '目标',
            description: '设置、查看或调整目标',
            render: (close) => (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  close();
                  setGoalOpen(true);
                }}
              >
                <Target size={17} />
                目标
              </button>
            ),
          },
        ]}
        submitActions={
          <CommandButton
            user={user}
            threadId={threadId}
            command="interrupt"
            turnId={state?.turnId}
            label="停止当前执行"
            iconOnly
            className="stop-turn-action"
            disabled={!state?.available || !(state.running || state.compacting) || !state.turnId}
            onFeedback={setControlNotice}
            onDone={stopDone}
          >
            <Square size={15} />
          </CommandButton>
        }
        attachmentControls={
          canChangeModel ? (
            <ModelSettings
              continuing
              settings={modelSettings}
              prefix="继续会话"
              onRetry={() => setRefresh((value) => value + 1)}
            />
          ) : undefined
        }
        url={`/api/sessions/${threadId}/messages`}
        extra={canChangeModel ? modelSettings.overrides : undefined}
        enabled={!!state?.available}
        onSubmitStart={() => setControlNotice('')}
        label={state?.compacting ? '加入队列' : state?.running ? '追加消息' : '发送消息'}
        onAccepted={() => {
          modelSettings.reset();
          setRefresh((value) => value + 1);
          onAccepted();
        }}
      />
      {controlNotice && (
        <p className="control-notice" role="status">
          {controlNotice}
        </p>
      )}
      {goalOpen && (
        <GoalDialog
          user={user}
          threadId={threadId}
          goal={goal}
          error={goalError}
          onRefresh={() => setRefresh((value) => value + 1)}
          onClose={() => setGoalOpen(false)}
          onDone={goalDone}
        />
      )}
    </div>
  );
}

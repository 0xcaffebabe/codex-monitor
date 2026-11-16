import { Minimize2, Pause, Pencil, Play, Plus, RefreshCw, Square, Target } from 'lucide-react';
import { CommandButton } from './CommandButton';
import { goalDuration, goalStatuses } from './goal';
import { GoalDialog } from './GoalDialog';
import { PromptForm } from './PromptForm';
import { MessageComposerProps, useMessageComposer } from './useMessageComposer';
import { ModelSettings } from './ModelSettings';
import { ApprovalPanel } from './ApprovalPanel';

export function MessageComposer(props: MessageComposerProps) {
  const { user, threadId, onAccepted } = props;
  const {
    state,
    canChangeModel,
    modelSettings,
    setRefresh,
    toolsExpanded,
    setToolsExpanded,
    goalOpen,
    setGoalOpen,
    goal,
    goalError,
    goalNotice,
    setGoalNotice,
    goalDone,
    stopNotice,
    setStopNotice,
    stopDone,
  } = useMessageComposer(props);
  if (user.role !== 'admin') return null;
  return (
    <div
      className={'message-composer' + (!state?.available ? ' unavailable' : '')}
      aria-label="向会话发送消息"
    >
      <div className="composer-heading">
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
      <div
        id={`session-tools-${threadId}`}
        className={'common-commands' + (toolsExpanded ? ' expanded' : '')}
      >
        <CommandButton
          user={user}
          threadId={threadId}
          command="compact"
          disabled={!state?.available || !!state?.running || !!state?.compacting}
          label="压缩上下文"
          onDone={() => {
            setRefresh((value) => value + 1);
            onAccepted();
          }}
        >
          <Minimize2 size={13} />
        </CommandButton>
        <button className="secondary" onClick={() => setGoalOpen(true)}>
          <Target size={13} />
          目标
        </button>
        <span className="muted">/compact · /goal · /help</span>
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
            onFeedback={setStopNotice}
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
        label={state?.compacting ? '加入队列' : state?.running ? '追加消息' : '发送消息'}
        onAccepted={() => {
          modelSettings.reset();
          setRefresh((value) => value + 1);
          onAccepted();
        }}
      >
        <button
          type="button"
          className="composer-tools-toggle"
          aria-label="更多会话操作"
          aria-expanded={toolsExpanded}
          aria-controls={`session-tools-${threadId}`}
          title={toolsExpanded ? '收起会话操作' : '更多会话操作'}
          onClick={() => setToolsExpanded(!toolsExpanded)}
        >
          <Plus size={18} />
        </button>
      </PromptForm>
      {stopNotice && (
        <p className="control-notice" role="status">
          {stopNotice}
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

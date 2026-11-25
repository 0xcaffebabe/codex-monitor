import { Minimize2, Pause, Pencil, Play, RefreshCw, Square, Target, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { CommandButton } from './CommandButton';
import { goalDuration, goalStatuses } from './goal';
import { GoalDialog } from './GoalDialog';
import { PromptFormFields } from './PromptForm';
import { usePromptForm, type PromptFormProps } from './usePromptForm';
import { MessageComposerProps, useMessageComposer } from './useMessageComposer';
import { ModelSettings, modelSettingsSummary } from './ModelSettings';
import { ApprovalPanel } from './ApprovalPanel';
import { currentWorkspace, workspaceUrl } from '../../workspace-scope';
import { promptShortcuts } from './prompt-shortcuts';
import { ContextUsageRing } from './ContextUsageRing';

type ComposerProps = MessageComposerProps & {
  overview?: {
    title: string;
    inputLabel: string;
    online: boolean;
    hidden: boolean;
    anchor: RefObject<HTMLElement | null>;
  };
};

export function MessageComposer(props: ComposerProps) {
  return props.user.role === 'admin' ? <SessionMessageComposer {...props} /> : null;
}

function SessionMessageComposer(props: ComposerProps) {
  const { user, threadId, workspaceId, onAccepted, context, contextControls, overview } = props;
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const titleId = useId();
  const anchorRef = overview?.anchor;
  const full = !overview || expanded;
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
  } = useMessageComposer(props, full);
  const sessionUrl = `/api/sessions/${encodeURIComponent(threadId)}`;
  const modelSummary = canChangeModel ? modelSettingsSummary(modelSettings) : undefined;
  const formProps: PromptFormProps = {
    workspaceId,
    storageKey: `codex-monitor.${overview ? 'overview-draft' : 'draft'}.${user.id}.${threadId}`,
    url: sessionUrl + '/messages',
    enabled: !!state?.available && (!overview || (overview.online && !overview.hidden)),
    label: state?.compacting ? '加入队列' : state?.running ? '追加消息' : '发送消息',
    submitOnEnter: true,
    allowAttachments: true,
    allowDesktopChannel: !!state?.desktopChannel,
    desktopOwned: state?.owner === 'desktop',
    allowPermissionChanges: canChangeModel && !!state?.messagePermissions,
    extra: canChangeModel ? modelSettings.overrides : undefined,
    onSubmitStart: () => setControlNotice(''),
    onAccepted: () => {
      setExpanded(false);
      modelSettings.reset();
      setRefresh((value) => value + 1);
      onAccepted();
    },
  };
  const form = usePromptForm(formProps);
  useLayoutEffect(() => {
    const element = dialog.current;
    const anchor = anchorRef?.current;
    if (!element || !anchor) {
      if (restoreFocus.current) expandButton.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
      return;
    }
    const position = () => {
      const pane = anchor.getBoundingClientRect();
      const { offsetWidth, offsetHeight } = element;
      const gutter = 12;
      const left = pane.left + (pane.width - offsetWidth) / 2;
      const top = pane.bottom - offsetHeight - 8;
      element.style.left = `${Math.max(gutter, Math.min(left, innerWidth - offsetWidth - gutter))}px`;
      element.style.top = `${Math.max(gutter, Math.min(top, innerHeight - offsetHeight - gutter))}px`;
    };
    element.showModal();
    position();
    restoreFocus.current = true;
    element
      .querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
      ?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    observer.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      element.close();
    };
  }, [anchorRef, expanded]);

  const controlHint = state?.reason || '正在连接 Codex…';
  const expandedSettings = [
    form.attachments.length > 0 && `${form.attachments.length} 个附件`,
    form.draft.desktopChannel && '桌面通道',
    form.draft.permissionMode && '会话权限',
    modelSummary,
  ]
    .filter(Boolean)
    .join(' · ');
  const compactComposer = overview && (
    <div className="running-overview-composer" inert={expanded}>
      {overview.online && !overview.hidden && (!state?.available || state.compacting) && (
        <p className="running-overview-control-note" role="status" title={state?.reason}>
          {controlHint}
        </p>
      )}
      <PromptFormFields
        {...formProps}
        form={form}
        allowAttachments={false}
        inputLabel={overview.inputLabel}
        leadingActions={<ContextUsageRing context={context} />}
      >
        <button
          ref={expandButton}
          type="button"
          className="icon-button overview-compose-expand"
          aria-label="展开消息编辑器"
          aria-description={expandedSettings || undefined}
          aria-haspopup="dialog"
          aria-expanded={expanded}
          title={expandedSettings ? `展开消息编辑器（${expandedSettings}）` : '展开消息编辑器'}
          onClick={() => setExpanded(true)}
        >
          <Pencil size={16} aria-hidden="true" />
          {expandedSettings && <span className="composer-tool-dot" />}
        </button>
      </PromptFormFields>
    </div>
  );

  const composer = (
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
      <ApprovalPanel key={threadId} threadId={threadId} userId={user.id} workspaceId={workspaceId ?? currentWorkspace()} />
      {(!state?.available || state.compacting) && (
        <p className="control-hint">{controlHint}</p>
      )}
      {goal && goal.status !== 'complete' && (
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
                workspaceId={workspaceId}
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
                workspaceId={workspaceId}
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
              workspaceId={workspaceId}
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
      <PromptFormFields
        {...formProps}
        form={form}
        projectFilesUrl={workspaceId ? workspaceUrl(sessionUrl + '/files', workspaceId) : sessionUrl + '/files'}
        currentPermissionMode={state?.permissionMode}
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
                workspaceId={workspaceId}
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
        leadingActions={<ContextUsageRing context={context} />}
        submitActions={
          <CommandButton
            user={user}
            threadId={threadId}
            workspaceId={workspaceId}
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
        modelSummary={modelSummary}
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
          workspaceId={workspaceId}
          goal={goal}
          error={goalError}
          onRefresh={() => setRefresh((value) => value + 1)}
          onClose={() => setGoalOpen(false)}
          onDone={goalDone}
        />
      )}
    </div>
  );
  if (!overview) return composer;

  return (
    <>
      {compactComposer}
      {expanded && (
        <dialog
          className="overview-compose-dialog"
          ref={dialog}
          closedby="any"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation();
          }}
          onCancel={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
          }}
        >
          <header className="overview-compose-header">
            <h2 id={titleId}>{overview.title}</h2>
            <button
              type="button"
              autoFocus
              className="icon-button"
              title="收起消息编辑器"
              aria-label="收起消息编辑器"
              onClick={() => setExpanded(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          {composer}
        </dialog>
      )}
    </>
  );
}

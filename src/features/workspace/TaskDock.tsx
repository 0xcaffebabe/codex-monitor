import { ChevronRight, LayoutGrid, Layers3, ListTodo, Radio, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cx, relative } from '../../shared/format';
import { navigateWorkspace } from '../../workspace-scope';
import type { AttentionWorkspace } from '../attention/useAttention';
import type { User } from '../../types';
import { RunningOverview } from './RunningOverview';

export function TaskDock({
  mobile,
  user,
  groups,
  onRefresh,
  workspaceId,
  selected,
  onHome,
  home,
  onSessions,
  sessions,
}: {
  mobile: boolean;
  user: User;
  groups: AttentionWorkspace[];
  onRefresh: () => void;
  workspaceId: string;
  selected?: string;
  onHome: () => void;
  home: boolean;
  onSessions: () => void;
  sessions: boolean;
}) {
  const [view, setView] = useState<'list' | 'overview'>();
  const opened = view !== undefined;
  const overview = view === 'overview';
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const running = groups
    .flatMap(({ workspace, snapshot, fresh }) => {
      if (!fresh || !snapshot) return [];
      const pending = new Set([
        ...snapshot.approvals.requests.map((request) => request.threadId),
        ...(snapshot.questions ?? []).map((request) => request.session.id),
      ]);
      return snapshot.running
        .filter((session) => !pending.has(session.id))
        .map((session) => ({ workspace, session }));
    })
    .sort((left, right) => right.session.updatedAt - left.session.updatedAt);
  const unavailable = groups.filter(({ fresh }) => !fresh).map(({ workspace }) => workspace.name);
  const close = () => {
    dialog.current?.close();
    trigger.current?.focus({ preventScroll: true });
    setView(undefined);
  };
  useLayoutEffect(() => {
    if (mobile && overview) close();
  }, [mobile, overview]);
  useLayoutEffect(() => {
    if (!opened || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [opened]);

  const closeButton = (
    <button
      autoFocus
      className="icon-button running-sessions-close"
      type="button"
      title="关闭运行中列表"
      onClick={close}
    >
      <X size={20} />
    </button>
  );

  return (
    <>
      <nav
        className={mobile ? 'mobile-task-dock' : 'desktop-task-dock'}
        aria-label={mobile ? '任务导航' : '会话快捷入口'}
      >
        {mobile && (
          <>
            <button
              type="button"
              aria-label="返回任务动态"
              aria-current={home ? 'page' : undefined}
              onClick={onHome}
            >
              <ListTodo size={18} aria-hidden="true" />
              任务动态
            </button>
            <button type="button" aria-current={sessions ? 'page' : undefined} onClick={onSessions}>
              <Layers3 size={18} aria-hidden="true" />
              会话
            </button>
          </>
        )}
        <button
          ref={trigger}
          type="button"
          className="running-sessions-trigger"
          aria-label="查看运行中的会话"
          aria-description={mobile ? undefined : `${running.length} 个运行中的会话`}
          aria-haspopup="dialog"
          aria-expanded={opened}
          aria-controls={opened ? 'running-sessions' : undefined}
          title={mobile ? undefined : '运行中的会话'}
          onClick={() => setView('list')}
        >
          <Radio size={18} aria-hidden="true" />
          {mobile && '运行中'}
          {(!mobile || running.length > 0) && <span>{running.length}</span>}
        </button>
      </nav>
      {opened && (
        <dialog
          ref={dialog}
          className={overview ? 'running-overview-dialog' : 'running-sessions-dialog'}
          id="running-sessions"
          aria-labelledby={overview ? 'running-overview-heading' : 'running-sessions-heading'}
          onCancel={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          {overview ? (
            <RunningOverview
              user={user}
              running={running}
              groups={groups}
              workspaceId={workspaceId}
              unavailable={unavailable}
              onRefresh={onRefresh}
              onClose={close}
              onOpenSession={(taskWorkspaceId, sessionId) => {
                close();
                if (workspaceId !== taskWorkspaceId || selected !== sessionId)
                  navigateWorkspace(
                    taskWorkspaceId,
                    sessionId,
                    new URLSearchParams({ view: 'all' }),
                  );
              }}
            />
          ) : (
            <div className="running-sessions-inner">
              <header>
                <h2 id="running-sessions-heading">运行中的会话</h2>
                <span>全部工作空间</span>
                {!mobile && (
                  <button
                    type="button"
                    className="running-overview-trigger"
                    onClick={() => setView('overview')}
                  >
                    <LayoutGrid size={15} aria-hidden="true" />
                    全览
                  </button>
                )}
                {!mobile && closeButton}
              </header>
              <div className="running-sessions-list">
                {unavailable.length > 0 && <p role="status">未同步：{unavailable.join('、')}</p>}
                {!running.length && <p>已同步的工作空间中暂无运行中的会话。</p>}
                {running.map(({ workspace, session }) => {
                  const current = workspace.id === workspaceId && session.id === selected;
                  return (
                    <button
                      type="button"
                      key={`${workspace.id}:${session.id}`}
                      className={cx(current && 'active')}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => {
                        close();
                        if (!current)
                          navigateWorkspace(
                            workspace.id,
                            session.id,
                            new URLSearchParams({ view: 'all' }),
                          );
                      }}
                    >
                      <div>
                        <strong>{session.title || '未命名会话'}</strong>
                        <small>
                          {workspace.name} · {session.project} · {relative(session.updatedAt)}
                        </small>
                      </div>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              {mobile && <footer>{closeButton}</footer>}
            </div>
          )}
        </dialog>
      )}
    </>
  );
}

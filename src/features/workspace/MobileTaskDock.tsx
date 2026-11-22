import { ChevronRight, Layers3, ListTodo, Radio, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cx, relative } from '../../shared/format';
import { navigateWorkspace } from '../../workspace-scope';
import type { AttentionWorkspace } from '../attention/useAttention';

export function MobileTaskDock({
  groups,
  workspaceId,
  selected,
  onHome,
  home,
  onSessions,
  sessions,
}: {
  groups: AttentionWorkspace[];
  workspaceId: string;
  selected?: string;
  onHome: () => void;
  home: boolean;
  onSessions: () => void;
  sessions: boolean;
}) {
  const [opened, setOpened] = useState(false);
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
  const close = () => setOpened(false);
  useLayoutEffect(() => {
    if (!opened || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [opened]);

  return (
    <>
      <nav className="mobile-task-dock" aria-label="任务导航">
        <button
          type="button"
          aria-label="返回任务动态"
          aria-current={home ? 'page' : undefined}
          onClick={onHome}
        >
          <ListTodo size={18} aria-hidden="true" />
          任务动态
        </button>
        <button
          type="button"
          aria-current={sessions ? 'page' : undefined}
          onClick={onSessions}
        >
          <Layers3 size={18} aria-hidden="true" />
          会话
        </button>
        <button
          type="button"
          className="mobile-running-trigger"
          aria-label="查看运行中的会话"
          aria-haspopup="dialog"
          aria-expanded={opened}
          aria-controls={opened ? 'mobile-running-sessions' : undefined}
          onClick={() => setOpened(true)}
        >
          <Radio size={18} aria-hidden="true" />
          运行中{running.length > 0 && <span>{running.length}</span>}
        </button>
      </nav>
      {opened && (
        <dialog
          ref={dialog}
          className="mobile-running-sheet"
          id="mobile-running-sessions"
          aria-labelledby="mobile-running-heading"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div className="mobile-running-inner">
            <header>
              <h2 id="mobile-running-heading">运行中的会话</h2>
              <span>全部工作空间</span>
            </header>
            <div className="mobile-running-list">
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
            <footer>
              <button
                autoFocus
                className="icon-button"
                type="button"
                title="关闭运行中列表"
                onClick={close}
              >
                <X size={20} />
              </button>
            </footer>
          </div>
        </dialog>
      )}
    </>
  );
}

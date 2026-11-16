import { ChevronRight, Folder, Monitor, Radio, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cx, relative } from '../../shared/format';
import type { RunningWorkspace } from '../workspaces/useRunningSessions';

export function RunningSwitcher({
  workspaces,
  activeWorkspaceId,
  selected,
  onSelect,
}: {
  workspaces: RunningWorkspace[];
  activeWorkspaceId: string;
  selected?: string;
  onSelect: (workspaceId: string, sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!expanded) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expanded]);
  const total = workspaces.reduce((count, group) => count + group.sessions.length, 0);
  if (!total && !workspaces.some((group) => group.error)) return null;
  return (
    <>
      {expanded && (
        <button
          className="running-switcher-scrim"
          aria-label="关闭运行会话列表"
          onClick={() => setExpanded(false)}
        />
      )}
      <nav
        className={cx('running-switcher', !expanded && 'collapsed')}
        aria-label="正在进行的会话快捷切换"
      >
        {!expanded ? (
          <button
            className="running-launcher"
            title="展开正在进行的会话"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            <Radio size={17} />
            <span>{total}</span>
          </button>
        ) : (
          <>
            <header className="running-switcher-header">
              <strong>
                <Radio size={15} />
                正在进行的会话<span>{total}</span>
              </strong>
              <button
                className="icon-button"
                title="收起进行中会话快捷栏"
                onClick={() => setExpanded(false)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="running-switcher-list">
              {workspaces.map(({ workspace, sessions, error, loading }) => (
                <section
                  className="running-workspace"
                  key={workspace.id}
                  aria-label={`${workspace.name}的进行中会话`}
                >
                  <h2 className="running-workspace-header">
                    <Monitor size={12} />
                    <strong title={workspace.name}>{workspace.name}</strong>
                    <span>{sessions.length}</span>
                    {workspace.id === activeWorkspaceId && <small>当前空间</small>}
                  </h2>
                  <div className="running-workspace-sessions">
                    {sessions.map((session, index) => {
                      const current = workspace.id === activeWorkspaceId && selected === session.id;
                      const lastActive = relative(session.updatedAt, { now, seconds: true });
                      return (
                        <button
                          key={session.id}
                          className={cx('running-shortcut', current && 'active')}
                          aria-label={'切换到正在进行的会话：' + session.title}
                          aria-current={current ? 'page' : undefined}
                          onClick={() => {
                            onSelect(workspace.id, session.id);
                            setExpanded(false);
                          }}
                        >
                          <span className="running-index">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <span className="running-shortcut-body">
                            <strong>{session.title}</strong>
                            <small>
                              <Folder size={11} />
                              {session.project}
                              <span className="green-dot" />
                              {current ? '当前会话' : '进行中'}
                              <time
                                className="running-last-active"
                                dateTime={new Date(session.updatedAt).toISOString()}
                                title={`最后活跃：${new Date(session.updatedAt).toLocaleString('zh-CN')}`}
                                aria-label={`最后活跃：${lastActive}`}
                              >
                                {lastActive}
                              </time>
                            </small>
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      );
                    })}
                  </div>
                  {!sessions.length && (
                    <p className="running-workspace-message">
                      {!workspace.online
                        ? '空间已离线'
                        : error || (loading ? '正在加载…' : '暂无进行中的会话')}
                    </p>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </nav>
    </>
  );
}

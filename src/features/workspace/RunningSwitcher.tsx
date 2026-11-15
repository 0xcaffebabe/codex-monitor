import { ChevronRight, Folder, Radio, X } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../shared/format';
import type { Session } from '../../types';

export function RunningSwitcher({
  sessions,
  selected,
  onSelect,
}: {
  sessions: Session[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sessions.length) return null;
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
            <span>{sessions.length}</span>
          </button>
        ) : (
          <>
            <header className="running-switcher-header">
              <strong>
                <Radio size={15} />
                正在进行的会话<span>{sessions.length}</span>
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
              {sessions.map((session, index) => (
                <button
                  key={session.id}
                  className={cx('running-shortcut', selected === session.id && 'active')}
                  aria-label={'切换到正在进行的会话：' + session.title}
                  aria-current={selected === session.id ? 'page' : undefined}
                  onClick={() => {
                    onSelect(session.id);
                    setExpanded(false);
                  }}
                >
                  <span className="running-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="running-shortcut-body">
                    <strong>{session.title}</strong>
                    <small>
                      <Folder size={11} />
                      {session.project}
                      <span className="green-dot" />
                      {selected === session.id ? '当前会话' : '进行中'}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          </>
        )}
      </nav>
    </>
  );
}

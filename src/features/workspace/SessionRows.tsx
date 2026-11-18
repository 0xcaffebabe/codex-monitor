import { Activity, ChevronRight, Folder, MessageSquare, Monitor, Radio } from 'lucide-react';
import React from 'react';
import { cx, number, relative, time } from '../../shared/format';
import { Status } from '../../shared/ui/Status';
import type { WorkspaceModel } from './useWorkspace';
import { workspaceSessionKey } from './session-list-model';

export function SessionRows({
  rows,
  selected,
  workspaceId,
  selectSession,
  compact = !!selected,
  statusDot = false,
}: Pick<WorkspaceModel, 'rows' | 'selected' | 'workspaceId' | 'selectSession'> & {
  compact?: boolean;
  statusDot?: boolean;
}) {
  return (
    <>
      {rows.map(({ session: s, heading }) => {
        const current = s.workspaceId === workspaceId && selected === s.id;
        const relativeTime = relative(s.updatedAt);
        return (
          <React.Fragment key={workspaceSessionKey(s)}>
            {!!heading && (
              <div className="group-label">
                <span>{heading}</span>
                {heading === '正在进行' && <Radio size={11} />}
              </div>
            )}
            <button
              className={cx('session-row', current && 'selected')}
              aria-current={current ? 'page' : undefined}
              onClick={() => selectSession(s)}
              data-testid="session-row"
              data-workspace-id={s.workspaceId}
            >
              {statusDot ? (
                <Status status={s.status} dot />
              ) : (
                <span className={cx('session-glyph', s.status === 'running' && 'live')}>
                  {s.status === 'running' ? <Activity size={18} /> : <MessageSquare size={17} />}
                </span>
              )}
              <div className="session-info">
                <strong>{s.title}</strong>
                <div>
                  <span className="session-workspace-tag" title={`工作空间：${s.workspaceName}`}>
                    <Monitor size={11} />
                    <span>{s.workspaceName}</span>
                  </span>
                  <span className="project-tag" title={statusDot ? s.project : undefined}>
                    <Folder size={12} />
                    <span>{s.project}</span>
                  </span>
                  <span className="session-preview">
                    {s.preview || s.model || s.id.slice(0, 8)}
                  </span>
                  {statusDot && <span className="compact-session-time">{relativeTime}</span>}
                </div>
                {compact && !statusDot && (
                  <div className="compact-meta">
                    <Status status={s.status} />
                    <span>{relativeTime}</span>
                  </div>
                )}
              </div>
              {!compact && (
                <>
                  <Status status={s.status} />
                  <span className="tokens">
                    {s.tokens ? number(s.tokens) : '—'}
                    <small>tokens</small>
                  </span>
                  <span className="session-time">
                    {relativeTime}
                    <small>{time(s.updatedAt)}</small>
                  </span>
                  <ChevronRight size={16} className="row-arrow" />
                </>
              )}
            </button>
          </React.Fragment>
        );
      })}
    </>
  );
}

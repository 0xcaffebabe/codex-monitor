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
}: Pick<WorkspaceModel, 'rows' | 'selected' | 'workspaceId' | 'selectSession'> & {
  compact?: boolean;
}) {
  return (
    <>
      {rows.map(({ session: s, heading }) => {
        const current = s.workspaceId === workspaceId && selected === s.id;
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
              <span className={cx('session-glyph', s.status === 'running' && 'live')}>
                {s.status === 'running' ? <Activity size={18} /> : <MessageSquare size={17} />}
              </span>
              <div className="session-info">
                <strong>{s.title}</strong>
                <div>
                  <span className="session-workspace-tag" title={`工作空间：${s.workspaceName}`}>
                    <Monitor size={11} />
                    <span>{s.workspaceName}</span>
                  </span>
                  <span className="project-tag">
                    <Folder size={12} />
                    {s.project}
                  </span>
                  <span className="session-preview">
                    {s.preview || s.model || s.id.slice(0, 8)}
                  </span>
                </div>
                {compact && (
                  <div className="compact-meta">
                    <Status status={s.status} />
                    <span>{relative(s.updatedAt)}</span>
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
                    {relative(s.updatedAt)}
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

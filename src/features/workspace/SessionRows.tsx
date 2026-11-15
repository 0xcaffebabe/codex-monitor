import { Activity, ChevronRight, Folder, MessageSquare, Radio } from 'lucide-react';
import React from 'react';
import { cx, number, relative, time } from '../../shared/format';
import { Status } from '../../shared/ui/Status';
import type { WorkspaceModel } from './useWorkspace';

export function SessionRows({
  rows,
  selected,
  select,
}: Pick<WorkspaceModel, 'rows' | 'selected' | 'select'>) {
  return (
    <>
      {rows.map(({ session: s, heading }) => {
        return (
          <React.Fragment key={s.id}>
            {!!heading && (
              <div className="group-label">
                <span>{heading}</span>
                {heading === '正在进行' && <Radio size={11} />}
              </div>
            )}
            <button
              className={cx('session-row', selected === s.id && 'selected')}
              onClick={() => select(s.id)}
              data-testid="session-row"
            >
              <span className={cx('session-glyph', s.status === 'running' && 'live')}>
                {s.status === 'running' ? <Activity size={18} /> : <MessageSquare size={17} />}
              </span>
              <div className="session-info">
                <strong>{s.title}</strong>
                <div>
                  <span className="project-tag">
                    <Folder size={12} />
                    {s.project}
                  </span>
                  <span className="session-preview">
                    {s.preview || s.model || s.id.slice(0, 8)}
                  </span>
                </div>
                {selected && (
                  <div className="compact-meta">
                    <Status status={s.status} />
                    <span>{relative(s.updatedAt)}</span>
                  </div>
                )}
              </div>
              {!selected && (
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

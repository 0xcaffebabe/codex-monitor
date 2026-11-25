import { Folder, History, LoaderCircle, MessageSquareQuote, Monitor, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { relative } from '../../shared/format';
import { Status } from '../../shared/ui/Status';
import type { ManagedWorkspace } from '../../workspaces';
import { workspaceSessionKey, type WorkspaceSession } from './session-list-model';
import { useSessionPicker } from './useSessionPicker';

type ReferenceAction = 'reference' | 'takeover';

type SessionPickerProps = {
  onClose: () => void;
  portalContainer?: HTMLElement;
} & (
  | {
      mode: 'reference';
      disabled: boolean;
      progress: string;
      onReference: (session: WorkspaceSession, action: ReferenceAction) => Promise<string | undefined>;
    }
  | {
      mode: 'history';
      workspaces: ManagedWorkspace[];
      onSelect: (session: WorkspaceSession) => void;
    }
);

export function SessionPickerDialog(props: SessionPickerProps) {
  const { onClose, portalContainer = document.body } = props;
  const history = props.mode === 'history';
  const model = useSessionPicker(!history, history ? props.workspaces : undefined);
  const title = history ? '继续历史会话' : '引用会话';
  const Icon = history ? History : MessageSquareQuote;
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const titleId = useId();
  const [pending, setPending] = useState<{ key: string; action: ReferenceAction }>();
  const [error, setError] = useState('');
  const progress = history ? '' : props.progress;
  const disabled = !history && props.disabled;
  const busy = !!pending || !!progress;
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      mounted.current = false;
      previous?.focus();
    };
  }, []);
  async function reference(session: WorkspaceSession, action: ReferenceAction) {
    if (props.mode !== 'reference' || busy || disabled) return;
    setPending({ key: workspaceSessionKey(session), action });
    setError('');
    const failure = await props.onReference(session, action);
    if (!mounted.current) return;
    setPending(undefined);
    if (failure) setError(failure);
    else onClose();
  }
  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="control-dialog session-reference-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const nodes = dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled)',
          );
          if (!nodes?.length) return;
          if (event.shiftKey && document.activeElement === nodes[0]) {
            event.preventDefault();
            nodes[nodes.length - 1].focus();
          } else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
            event.preventDefault();
            nodes[0].focus();
          }
        }}
      >
        <header>
          <Icon size={21} aria-hidden="true" />
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {!history && (
          <p className="control-hint">选择会话，将完整记录作为 Markdown 附件添加到当前消息。</p>
        )}
        <div className="session-reference-filters">
          <div className="search-box">
            <Search size={16} />
            <input
              ref={search}
              aria-label={history ? '搜索历史会话' : '搜索要引用的会话'}
              placeholder="搜索标题、项目、首条消息或会话 ID…"
              maxLength={200}
              value={model.query}
              disabled={busy}
              onChange={(event) => model.setQuery(event.target.value)}
            />
          </div>
          <select
            aria-label={history ? '历史会话工作空间' : '引用会话工作空间'}
            value={model.workspaceId}
            disabled={busy}
            onChange={(event) => model.setWorkspaceId(event.target.value)}
          >
            <option value="">全部工作空间</option>
            {model.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id} disabled={!workspace.online}>
                {workspace.name}
                {!workspace.online ? '（离线）' : ''}
              </option>
            ))}
          </select>
        </div>
        {(error || model.error) && (
          <p className="control-error" role="alert">
            {error || model.error}{' '}
            {model.error && (
              <button type="button" className="secondary" onClick={model.retry} disabled={busy}>
                重试
              </button>
            )}
          </p>
        )}
        {model.listWarning && (
          <p className="control-hint" role="status">
            {model.listWarning}
          </p>
        )}
        <div className="session-reference-results" aria-busy={model.loading || busy}>
          {!model.sessions.length ? (
            <p className="session-reference-empty" role="status">
              {model.loading ? (
                <>
                  <LoaderCircle className="spin" size={16} />
                  正在读取会话…
                </>
              ) : history ? '没有找到可继续的会话' : '没有找到可引用的会话'}
            </p>
          ) : (
            <ul aria-label={history ? '可继续的会话' : '可引用的会话'}>
              {model.sessions.map((session) => {
                const key = workspaceSessionKey(session);
                const pendingAction = pending?.key === key ? pending.action : undefined;
                const rowDisabled = disabled || busy || model.loading;
                return (
                  <li className="session-reference-result" key={key}>
                    <button
                      type="button"
                      className="session-reference-row"
                      aria-label={`${history ? '继续会话' : '引用会话'} ${session.title}（${session.workspaceName}）`}
                      disabled={rowDisabled}
                      onClick={() => {
                        if (props.mode === 'history') props.onSelect(session);
                        else void reference(session, 'reference');
                      }}
                    >
                      {pendingAction === 'reference' ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : (
                        <Icon size={18} aria-hidden="true" />
                      )}
                      <span className="session-reference-info">
                        <strong title={session.title}>{session.title}</strong>
                        <span className="session-reference-meta">
                          <span title={session.workspaceName}>
                            <Monitor size={12} />
                            {session.workspaceName}
                          </span>
                          <span title={session.cwd}>
                            <Folder size={12} />
                            {session.project}
                          </span>
                          {session.archived && <span>已归档</span>}
                        </span>
                        <small>{session.preview || session.id}</small>
                      </span>
                    </button>
                    <div className="session-reference-state">
                      <div className="session-reference-actions">
                        {!history && (
                          <button
                            type="button"
                            className="secondary session-reference-takeover"
                            aria-label={`接手会话 ${session.title}（${session.workspaceName}）`}
                            disabled={rowDisabled}
                            onClick={() => void reference(session, 'takeover')}
                          >
                            {pendingAction === 'takeover' && (
                              <LoaderCircle className="spin" size={12} />
                            )}
                            接手
                          </button>
                        )}
                        <Status status={session.status} />
                      </div>
                      <small>{relative(session.updatedAt)}</small>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer>
          <span className="muted" role="status">
            {progress || `${model.total} 个会话${history ? '' : ' · 包含已归档会话'}`}
          </span>
          {model.sessions.length < model.total && (
            <button
              type="button"
              className="secondary"
              disabled={busy || model.loading}
              onClick={() => void model.loadList(true)}
            >
              {model.loading ? '正在加载…' : '加载更多'}
            </button>
          )}
        </footer>
      </div>
    </div>,
    portalContainer,
  );
}

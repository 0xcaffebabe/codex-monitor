import { X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { ContextMeter } from '../../context-meter';
import { number } from '../../shared/format';
import { Status } from '../../shared/ui/Status';
import type { SessionPage } from '../../types';
import { SessionUsage } from '../usage/SessionUsage';
import { SessionTurnTimer } from './SessionTurnTimer';

export function SessionInformation({
  page,
  workspaceName,
  onClose,
}: {
  page: SessionPage;
  workspaceName?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { session } = page;
  const compactions = page.context?.compactionCount;
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="session-information"
      aria-labelledby="session-information-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id="session-information-heading">会话信息</h2>
        <button className="icon-button" autoFocus title="关闭会话信息" onClick={onClose}>
          <X size={19} />
        </button>
      </header>
      <p className="detail-full-title">{session.title}</p>
      <dl className="detail-meta">
        {workspaceName && (
          <div>
            <dt>工作空间</dt>
            <dd>{workspaceName}</dd>
          </div>
        )}
        <div>
          <dt>项目目录</dt>
          <dd className="session-information-path">{session.cwd || '未知'}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>
            <Status status={session.status} />
          </dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{session.model || 'Codex'}</dd>
        </div>
        <div>
          <dt>Token 总量</dt>
          <dd>{number(session.tokens)}</dd>
        </div>
        <div>
          <dt>会话 ID</dt>
          <dd className="session-information-path">{session.id}</dd>
        </div>
        <div>
          <dt>上下文压缩</dt>
          <dd>{compactions == null ? '未知' : `${compactions.toLocaleString('zh-CN')} 次`}</dd>
        </div>
      </dl>
      {page.turnTiming?.finishedAt != null && <SessionTurnTimer timing={page.turnTiming} />}
      <ContextMeter context={page.context} />
      <SessionUsage sessionId={session.id} revision={page.version} />
    </dialog>
  );
}

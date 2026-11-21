import {
  Activity,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  LoaderCircle,
  SquareTerminal,
  XCircle,
} from 'lucide-react';
import React, { type ReactNode } from 'react';
import type { SessionFileLink } from '../../file-preview-types';
import { cx, time } from '../../shared/format';
import { Markdown } from '../../shared/ui/Markdown';
import type { TimelineEvent } from '../../types';
import { isToolRunning } from './session-model';
import { SessionImage } from './SessionImage';

export const EventCard = React.memo(function EventCard({
  event: e,
  sessionId,
  onCopy,
  onOpenFile,
}: {
  event: TimelineEvent;
  sessionId?: string;
  onCopy: (s: string) => void;
  onOpenFile?: (itemId: string, file: SessionFileLink) => void;
}) {
  const renderImage = (offset: number | undefined, alt: string) => {
    const image =
      offset === undefined ? undefined : e.images?.find((image) => image.offset === offset);
    return sessionId && image ? (
      <SessionImage sessionId={sessionId} image={{ ...image, name: alt || image.name }} inline />
    ) : null;
  };
  if (e.kind === 'tool')
    return (
      <details
        className={cx('tool-card', e.status === 'failed' && 'tool-error')}
        id={'event-' + e.id}
      >
        <summary>
          <span className="tool-icon">
            <SquareTerminal size={15} />
          </span>
          <strong className={e.title ? 'tool-title' : undefined} title={e.title ?? e.name}>
            {e.title ?? e.name}
          </strong>
          {!e.title && (
            <span className="tool-preview">{e.text.replace(/\s+/g, ' ').slice(0, 90)}</span>
          )}
          <span
            className="tool-result"
            aria-label={isToolRunning(e) ? '执行中' : e.status === 'failed' ? '执行失败' : '已执行'}
          >
            {isToolRunning(e) ? (
              <LoaderCircle size={13} className="spin" />
            ) : e.status === 'failed' ? (
              <XCircle size={13} />
            ) : (
              <Check size={13} />
            )}
          </span>
          {e.durationMs !== undefined && (
            <small>
              {e.durationMs >= 1000
                ? (e.durationMs / 1000).toFixed(1) + 's'
                : Math.round(e.durationMs) + 'ms'}
            </small>
          )}
          <ChevronRight size={14} />
        </summary>
        <div className="tool-body">
          <div className="code-label">
            <span>{e.title && e.name ? `${e.name} · 调用参数` : '调用参数'}</span>
            <button className="icon-button" title="复制工具调用" onClick={() => onCopy(e.text)}>
              <Copy size={13} />
            </button>
          </div>
          <pre>{e.text}</pre>
        </div>
      </details>
    );
  if (e.kind === 'system')
    return (
      <div className="system-event" id={'event-' + e.id}>
        <CheckCheck size={13} />
        {e.text}
        <small>{time(e.timestamp)}</small>
      </div>
    );
  const renderFile = (offset: number | undefined, children: ReactNode) => {
    const file = e.files?.find((link) => link.offset === offset);
    if (!file) return null;
    if (!onOpenFile)
      return <span title="文件预览需要管理员权限">{children || file.path}</span>;
    return (
      <button type="button" className="markdown-file-link" aria-haspopup="dialog" title={file.path}
        onClick={() => onOpenFile(e.id, file)}>
        {children || file.path}<FileText size={12} aria-hidden="true" />
      </button>
    );
  };
  const markdown = <Markdown text={e.text} renderImage={renderImage} renderFile={e.files ? renderFile : undefined} />;
  if (e.kind === 'reasoning')
    return (
      <details className="reasoning-card" id={'event-' + e.id}>
        <summary>
          <Activity size={14} />
          思考摘要
          <ChevronRight size={13} />
        </summary>
        {markdown}
      </details>
    );
  return (
    <article
      className={cx('message', e.kind === 'user' ? 'user-message' : 'assistant-message')}
      id={'event-' + e.id}
    >
      <div className="message-top">
        <span className={e.kind === 'user' ? 'user-avatar' : 'assistant-avatar'}>
          {e.kind === 'user' ? '你' : <Code2 size={17} />}
        </span>
        <strong>{e.kind === 'user' ? '你' : e.kind === 'plan' ? '执行计划' : 'Codex'}</strong>
        {e.phase === 'commentary' && <span className="phase">进展更新</span>}
        <time>{time(e.timestamp)}</time>
        <button
          className="icon-button copy-message"
          title="复制消息"
          onClick={() => onCopy(e.text)}
        >
          <Copy size={14} />
        </button>
      </div>
      <div className="message-content">
        {markdown}
      </div>
    </article>
  );
});

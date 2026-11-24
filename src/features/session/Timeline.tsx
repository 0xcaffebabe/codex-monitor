import { ArrowDown, Clock, Code2, LoaderCircle, MessageSquare, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SessionFileLink } from '../../file-preview-types';
import { date, time } from '../../shared/format';
import { ActivityGroup } from './ActivityGroup';
import { EventCard } from './EventCard';
import { SessionImages } from './SessionImages';
import type { TimelineModel } from './useTimeline';
import { DetailProps } from './useTimeline';

export function Timeline({
  page,
  loading,
  syncing,
  error,
  connected,
  reconnect,
  model,
  copied,
  onOpenFile,
  children,
}: Pick<DetailProps, 'page' | 'loading' | 'syncing' | 'error' | 'connected' | 'reconnect'> & {
  model: TimelineModel;
  copied: (text: string) => void;
  onOpenFile?: (itemId: string, file: SessionFileLink) => void;
  children?: ReactNode;
}) {
  const {
    follow,
    olderBusy,
    olderFailed,
    scrollRef,
    bottomRef,
    events,
    blocks,
    scrollHandlers,
    jumpToLatest,
    session,
    loadOlder,
  } = model;
  const retryCount = reconnect?.message.match(/^Reconnecting(?:\.{3}|…)?\s+(\d+\/\d+)$/i)?.[1];
  const retryDetail = typeof reconnect?.details === 'string' && reconnect.details
    ? reconnect.details
    : retryCount ? undefined : reconnect?.message;
  return (
    <div className="timeline-reader">
      <div
        className="timeline-scroll"
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="会话时间线"
        {...scrollHandlers}
      >
        <div className="timeline">
          {loading && !page ? (
            <div className="empty" role="status">
              <LoaderCircle className="spin" />
              <p>{syncing ? '新会话已创建，正在同步记录…' : '正在展开执行记录…'}</p>
            </div>
          ) : (
            <>
              {page?.before != null && (
                <button
                  className="load-earlier"
                  disabled={olderBusy}
                  aria-busy={olderBusy}
                  onClick={() => void loadOlder()}
                >
                  {olderBusy ? <LoaderCircle className="spin" size={14} /> : <Clock size={14} />}
                  {olderBusy
                    ? '正在加载更早的记录…'
                    : olderFailed || error
                      ? '重试加载更早的记录'
                      : '加载更早的记录'}
                  <span>{page.total} 条原始记录</span>
                </button>
              )}
              <div className="timeline-date">
                <span />
                {session ? `${date(session.createdAt)} · ${time(session.createdAt)} 开始` : ''}
                <span />
              </div>
              {!events.length && (
                <div className="empty">
                  <MessageSquare size={24} />
                  <p>本会话暂无记录</p>
                </div>
              )}
              {blocks.map((block) =>
                block.kind === 'activity' ? (
                  <ActivityGroup
                    key={block.id}
                    sessionId={session?.id}
                    events={block.events}
                    onCopy={copied}
                    onOpenFile={onOpenFile}
                  />
                ) : block.kind === 'images' && session ? (
                  <SessionImages key={block.id} sessionId={session.id} events={block.events} />
                ) : block.kind === 'event' ? (
                  <EventCard
                    key={block.id}
                    sessionId={session?.id}
                    event={block.event}
                    onCopy={copied}
                    onOpenFile={onOpenFile}
                  />
                ) : null,
              )}
              {reconnect ? (
                <div className="working-indicator turn-reconnect" role="status">
                  <WifiOff size={17} aria-hidden="true" />
                  <div>
                    <div>Codex 正在重新连接{retryCount && ` ${retryCount}`}</div>
                    {retryDetail && <div className="turn-reconnect-detail">{retryDetail}</div>}
                  </div>
                </div>
              ) : session?.status === 'running' && (
                <div className="working-indicator">
                  <span className="assistant-avatar">
                    <Code2 size={17} />
                  </span>
                  <span className="typing">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>Codex 正在工作{!connected ? ' · 等待重新连接' : ''}</span>
                </div>
              )}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      </div>
      {children}
      {!follow && (
        <button className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
    </div>
  );
}

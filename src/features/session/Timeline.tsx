import { ArrowDown, Clock, Code2, LoaderCircle, Search } from 'lucide-react';
import type { ReactNode } from 'react';
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
  model,
  copied,
  children,
}: Pick<DetailProps, 'page' | 'loading' | 'syncing' | 'error' | 'connected'> & {
  model: TimelineModel;
  copied: (text: string) => void;
  children?: ReactNode;
}) {
  const {
    find,
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
              {find && (
                <p className="timeline-search-status" role="status">
                  {events.length} 条匹配 · {page?.before == null ? '全部记录' : '已加载记录'}
                </p>
              )}
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
                      : find
                        ? '加载更早的记录并搜索'
                        : '加载更早的记录'}
                  <span>{page.total} 条原始记录</span>
                </button>
              )}
              {!find && (
                <div className="timeline-date">
                  <span />
                  {session ? `${date(session.createdAt)} · ${time(session.createdAt)} 开始` : ''}
                  <span />
                </div>
              )}
              {!events.length && (
                <div className="empty">
                  <Search size={24} />
                  <p>{find ? '没有匹配的内容' : '本会话暂无记录'}</p>
                </div>
              )}
              {blocks.map((block) =>
                block.kind === 'activity' ? (
                  <ActivityGroup
                    key={block.id}
                    sessionId={session?.id}
                    events={block.events}
                    searching={!!find}
                    onCopy={copied}
                  />
                ) : block.kind === 'images' && session ? (
                  <SessionImages key={block.id} sessionId={session.id} events={block.events} />
                ) : block.kind === 'event' ? (
                  <EventCard
                    key={block.id}
                    sessionId={session?.id}
                    event={block.event}
                    onCopy={copied}
                  />
                ) : null,
              )}
              {session?.status === 'running' && !find && (
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
      {!follow && !find && (
        <button className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
    </div>
  );
}

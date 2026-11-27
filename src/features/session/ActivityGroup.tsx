import { Activity, ChevronRight, LoaderCircle } from 'lucide-react';
import type { SessionFileLink } from '../../file-preview-types';
import type { TimelineEvent } from '../../types';
import { EventCard } from './EventCard';
import { isToolRunning } from './session-model';

const toolTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function ActivityGroup({
  events,
  onCopy,
  sessionId,
  onOpenFile,
  anchorEvents = true,
}: {
  events: TimelineEvent[];
  onCopy: (s: string) => void;
  sessionId?: string;
  onOpenFile?: (itemId: string, file: SessionFileLink) => void;
  anchorEvents?: boolean;
}) {
  const tools = events.filter((event) => event.kind === 'tool'),
    failed = tools.filter((event) => event.status === 'failed').length,
    running = tools.some(isToolRunning),
    latestTitle = tools.at(-1)?.title;
  let earliestToolAt = Infinity;
  let latestToolAt = 0;
  for (const { timestamp } of tools) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    earliestToolAt = Math.min(earliestToolAt, timestamp);
    latestToolAt = Math.max(latestToolAt, timestamp);
  }
  return (
    <details className="activity-group">
      <summary className="activity-summary">
        {running ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
        <span className="activity-label" title={latestTitle}>
          {latestTitle ?? (tools.length ? (running ? '正在执行' : '执行过程') : '思考摘要')}
        </span>
        <small>{tools.length ? `${tools.length} 次工具调用` : `${events.length} 条摘要`}</small>
        {failed > 0 && <span className="activity-failed">{failed} 项失败</span>}
        {latestToolAt > 0 && (
          <span className="activity-time">
            <time
              dateTime={new Date(earliestToolAt).toISOString()}
              title={`最早工具调用：${new Date(earliestToolAt).toLocaleString('zh-CN', { hourCycle: 'h23' })}`}
            >
              {toolTime.format(earliestToolAt)}
            </time>
            {' ~ '}
            <time
              dateTime={new Date(latestToolAt).toISOString()}
              title={`最新工具调用：${new Date(latestToolAt).toLocaleString('zh-CN', { hourCycle: 'h23' })}`}
            >
              {toolTime.format(latestToolAt)}
            </time>
          </span>
        )}
        <ChevronRight size={14} className="activity-chevron" />
      </summary>
      <div className="activity-items">
        {events.map((event) => (
          <EventCard
            key={event.id}
            sessionId={sessionId}
            event={event}
            anchor={anchorEvents}
            onCopy={onCopy}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </details>
  );
}

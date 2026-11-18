import { Activity, ChevronRight, LoaderCircle } from 'lucide-react';
import type { TimelineEvent } from '../../types';
import { EventCard } from './EventCard';
import { isToolRunning } from './session-model';

export function ActivityGroup({
  events,
  onCopy,
  sessionId,
}: {
  events: TimelineEvent[];
  onCopy: (s: string) => void;
  sessionId?: string;
}) {
  const tools = events.filter((event) => event.kind === 'tool'),
    failed = tools.filter((event) => event.status === 'failed').length,
    running = tools.some(isToolRunning),
    latestTitle = tools.at(-1)?.title,
    latestToolAt = tools.reduce(
      (latest, event) =>
        Number.isFinite(event.timestamp) ? Math.max(latest, event.timestamp) : latest,
      0,
    );
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
          <time
            className="activity-time"
            dateTime={new Date(latestToolAt).toISOString()}
            title={`最新工具调用：${new Date(latestToolAt).toLocaleString('zh-CN', { hour12: false })}`}
          >
            {new Intl.DateTimeFormat('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }).format(latestToolAt)}
          </time>
        )}
        <ChevronRight size={14} className="activity-chevron" />
      </summary>
      <div className="activity-items">
        {events.map((event) => (
          <EventCard
            key={event.id}
            sessionId={sessionId}
            event={event}
            onCopy={onCopy}
          />
        ))}
      </div>
    </details>
  );
}

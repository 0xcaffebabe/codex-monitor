import { ArrowUpRight, CheckCircle2, X } from 'lucide-react';
import { time } from '../../shared/format';
import { useCompletionNotifications } from './useCompletionNotifications';

export function CompletionNotifications({ userId }: { userId: string }) {
  const { notifications, dismiss, dismissAll } = useCompletionNotifications(userId);
  if (!notifications.length) return null;
  return (
    <section
      className="completion-notifications"
      aria-label="任务完成通知"
      aria-live="polite"
      aria-relevant="additions"
    >
      {notifications.length > 1 && (
        <div className="completion-notifications-header">
          <span>{notifications.length} 条任务完成通知</span>
          <button onClick={dismissAll}>全部关闭</button>
        </div>
      )}
      {notifications
        .slice(-3)
        .reverse()
        .map((item) => {
          const params = new URLSearchParams({
            workspace: item.workspaceId,
            session: item.sessionId,
          });
          return (
            <article className="completion-notification" key={item.id}>
              <CheckCircle2 className="completion-notification-icon" size={21} aria-hidden="true" />
              <a
                href={`${location.pathname}?${params}`}
                onClick={() => dismiss(item.id)}
                aria-label={`查看已完成会话：${item.title || '未命名会话'}`}
              >
                <span className="completion-notification-label">任务已完成</span>
                <strong>{item.title || '未命名会话'}</strong>
                <small>
                  {item.workspaceName} · {time(item.completedAt)}
                </small>
                <span className="completion-notification-open">
                  查看会话 <ArrowUpRight size={14} aria-hidden="true" />
                </span>
              </a>
              <button
                className="completion-notification-close"
                onClick={() => dismiss(item.id)}
                aria-label={`关闭通知：${item.title || '未命名会话'}`}
                title="关闭通知"
              >
                <X size={16} />
              </button>
            </article>
          );
        })}
      {notifications.length > 3 && (
        <div className="completion-notifications-more">
          另有 {notifications.length - 3} 条通知，关闭上方通知后可查看
        </div>
      )}
    </section>
  );
}

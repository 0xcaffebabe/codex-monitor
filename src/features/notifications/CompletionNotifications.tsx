import { ArrowUpRight, CheckCircle2, X } from 'lucide-react';
import { time } from '../../shared/format';
import { navigateWorkspace } from '../../workspace-scope';
import { useCompletionNotifications } from './useCompletionNotifications';

export function CompletionNotifications() {
  const { notifications, pending, error, dismiss, dismissAll } = useCompletionNotifications();
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
          <button disabled={pending} onClick={() => void dismissAll()}>
            全部关闭
          </button>
        </div>
      )}
      {error && (
        <div className="completion-notification-error" role="alert">
          {error}
        </div>
      )}
      {notifications
        .slice(-3)
        .reverse()
        .map((item) => {
          const title = item.title || '未命名会话';
          const params = new URLSearchParams({
            workspace: item.workspaceId,
            session: item.sessionId,
          });
          return (
            <article className="completion-notification" key={item.id}>
              <CheckCircle2 className="completion-notification-icon" size={21} aria-hidden="true" />
              <a
                href={`${location.pathname}?${params}`}
                aria-disabled={pending}
                onClick={async (event) => {
                  event.preventDefault();
                  if (await dismiss(item.id)) navigateWorkspace(item.workspaceId, item.sessionId);
                }}
                aria-label={`查看已完成会话：${title}`}
              >
                <span className="completion-notification-label">任务已完成</span>
                <strong>{title}</strong>
                <small>
                  {item.workspaceName} · {time(item.completedAt)}
                </small>
                <span className="completion-notification-open">
                  查看会话 <ArrowUpRight size={14} aria-hidden="true" />
                </span>
              </a>
              <button
                className="completion-notification-close"
                disabled={pending}
                onClick={() => void dismiss(item.id)}
                aria-label={`关闭通知：${title}`}
                title="关闭通知"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </article>
          );
        })}
      {notifications.length > 3 && (
        <div className="completion-notifications-more">另有 {notifications.length - 3} 条通知</div>
      )}
    </section>
  );
}

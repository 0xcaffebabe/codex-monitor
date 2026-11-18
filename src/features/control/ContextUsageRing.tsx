import { Popover } from '../../shared/ui/Popover';
import type { SessionContext } from '../../types';

export function ContextUsageRing({ context }: { context?: SessionContext }) {
  const percent = context?.percent;
  const used = context?.usedTokens;
  const limit = context?.limitTokens;
  const fill = percent == null ? 0 : Math.min(100, percent);
  const usage =
    used == null ? null : `${used.toLocaleString()} / ${limit?.toLocaleString() ?? '未知'} tokens`;
  const summary = percent == null ? null : `已用 ${percent.toFixed(1)}%`;
  const unavailable = used == null ? '暂无使用记录' : '上下文窗口上限未知';
  const status = summary ?? unavailable;
  const severity = fill >= 90 ? ' near-limit' : fill >= 70 ? ' elevated' : '';

  return (
    <Popover
      label="上下文用量"
      displayLabel=""
      description={usage ? `${status}，${usage}` : status}
      className={`context-ring-trigger${severity}`}
      icon={
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle
            className="context-ring-track"
            cx="10"
            cy="10"
            r="7.5"
            strokeWidth="2.5"
            strokeDasharray={percent == null ? '2 2' : undefined}
          />
          {fill > 0 && (
            <circle
              cx="10"
              cy="10"
              r="7.5"
              pathLength="100"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeDasharray={`${fill} 100`}
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
      }
    >
      {() => (
        <div className="context-ring-details">
          {summary ? (
            <strong
              className="context-ring-value"
              role="meter"
              aria-label="上下文使用率"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fill}
              aria-valuetext={summary}
            >
              {summary}
            </strong>
          ) : (
            <strong>{unavailable}</strong>
          )}
          {usage && <span>{usage}</span>}
        </div>
      )}
    </Popover>
  );
}

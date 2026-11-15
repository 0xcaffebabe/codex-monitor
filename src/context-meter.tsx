import { Gauge } from 'lucide-react';
import type { SessionContext } from './types';
const tokens = (value: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export function ContextMeter({ context }: { context?: SessionContext }) {
  const percent = context?.percent,
    used = context?.usedTokens,
    limit = context?.limitTokens;
  return (
    <div
      className={
        'context-meter ' +
        (percent != null && percent >= 90
          ? 'near-limit'
          : percent != null && percent >= 70
            ? 'elevated'
            : '')
      }
      title={
        context?.updatedAt
          ? '最近模型调用的上下文使用量 · ' +
            new Date(context.updatedAt).toLocaleTimeString('zh-CN')
          : '等待 Codex 写入上下文使用记录'
      }
    >
      <span className="context-label">
        <Gauge size={13} />
        上下文
      </span>
      {used != null ? (
        <>
          <span
            className="context-values"
            title={`${used.toLocaleString()} / ${limit?.toLocaleString() ?? '未知'} tokens`}
          >
            {tokens(used)} / {limit != null ? tokens(limit) : '未知'} <small>tokens</small>
          </span>
          {percent != null && (
            <>
              <span className="context-track" aria-hidden="true">
                <span style={{ width: Math.min(100, percent) + '%' }} />
              </span>
              <strong
                role="meter"
                aria-label="上下文使用率"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, percent)}
              >
                {percent.toFixed(1)}%
              </strong>
            </>
          )}
        </>
      ) : (
        <span className="context-unknown">暂无使用记录</span>
      )}
    </div>
  );
}

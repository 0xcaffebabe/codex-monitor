import { BarChart3, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { compact, integer, money, seconds, speed } from './format';
import { useSessionUsage } from './useSessionUsage';

export function SessionUsage({ sessionId, revision }: { sessionId: string; revision?: string }) {
  const { data, error, busy, reload } = useSessionUsage(sessionId, revision),
    [expanded, setExpanded] = useState(false);
  const s = data?.summary;
  return (
    <section className="session-usage" aria-label="会话用量">
      <button
        className="session-usage-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <BarChart3 size={14} />
        <strong>会话用量</strong>
        {busy ? (
          <span>读取中…</span>
        ) : (
          s && (
            <>
              <span>{compact(s.totalTokens)} tokens</span>
              <span>
                {money(s.costUsd)}
                {s.unpricedRequests ? '+' : ''}
              </span>
              <span className="usage-mini-speed">{speed(s.tps)}</span>
            </>
          )
        )}
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="session-usage-body">
          {error && (
            <div role="alert">
              {error}
              <button onClick={reload}>重试</button>
            </div>
          )}
          {s && (
            <>
              <div className="session-usage-metrics">
                <span>
                  模型请求<strong>{integer(s.requests)}</strong>
                </span>
                <span>
                  新增输入<strong>{compact(s.uncachedInputTokens)}</strong>
                </span>
                <span>
                  缓存读取<strong>{compact(s.cachedInputTokens)}</strong>
                </span>
                <span>
                  输出<strong>{compact(s.outputTokens)}</strong>
                </span>
                <span>
                  首字均值<strong>{seconds(s.firstTokenMs)}</strong>
                </span>
                <span>
                  平均速度<strong>{speed(s.tps)}</strong>
                </span>
              </div>
              <p className="usage-note">
                成本为配置价格估算 · 首字 {s.firstTokenSamples}/{s.requests} 个样本 · TPS{' '}
                {s.tpsSamples}/{s.requests} 个样本{data?.scan.running ? ' · 正在同步历史用量…' : ''}
                {s.unpricedRequests ? ` · ${s.unpricedRequests} 次请求未定价` : ''}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

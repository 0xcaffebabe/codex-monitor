import { BarChart3, Coins, Search, Zap } from 'lucide-react';
import { compact, integer, money, seconds, speed } from './format';
import { Help } from './Help';
import { Stat } from './Stat';
import { UsageDashboardModel } from './useUsageDashboard';

export function UsageMetrics({ s, busy }: Pick<UsageDashboardModel, 's' | 'busy'>) {
  return (
    <>
      {' '}
      <div className="usage-stat-grid" aria-busy={busy}>
        <Stat
          title="估算成本 · USD"
          value={s ? money(s.costUsd) + (s.unpricedRequests ? '+' : '') : '—'}
          note={
            s?.unpricedRequests
              ? `${integer(s.unpricedRequests)} 次请求未定价，仅汇总已定价部分`
              : '按模型配置价格估算'
          }
          icon={<Coins size={17} />}
        />
        <Stat
          title="模型请求"
          value={s ? integer(s.requests) : '—'}
          note={s ? `${integer(s.sessions)} 个会话 · 含归档记录` : '正在读取本地日志'}
          icon={<BarChart3 size={17} />}
        />
        <Stat
          title="消耗 Tokens"
          value={s ? compact(s.totalTokens) : '—'}
          note="输入 + 输出，包含缓存和思考"
          icon={<Zap size={17} />}
        />
        <Stat
          title="缓存命中率"
          value={s?.cacheHitRate != null ? (s.cacheHitRate * 100).toFixed(1) + '%' : '—'}
          note="缓存读取 / 全部输入"
          icon={<Search size={17} />}
        />
      </div>
      <div className="usage-performance">
        <div>
          <span>
            首字均值{' '}
            <Help text="按输出项 started_at_ms 减去本次请求起点估算；缺少生成开始时间时不计算。" />
          </span>
          <strong>{seconds(s?.firstTokenMs ?? null)}</strong>
          <small>{s?.firstTokenSamples ?? 0} 个有效样本</small>
        </div>
        <div>
          <span>
            平均输出速度{' '}
            <Help text="有效请求的输出 tokens 之和 / 生成耗时之和。优先扣除首字等待；缺少首字时使用完整请求耗时，包含等待。排除已完成工具的执行和轮次间空闲时间。" />
          </span>
          <strong>{speed(s?.tps ?? null)}</strong>
          <small>{s?.tpsSamples ?? 0} 个有效样本</small>
        </div>
        <div className="usage-token-detail">
          <span>
            新增输入 <b>{s ? compact(s.uncachedInputTokens) : '—'}</b>
          </span>
          <span>
            缓存读取 <b>{s ? compact(s.cachedInputTokens) : '—'}</b>
          </span>
          <span>
            缓存写入 <b>{s ? compact(s.cacheWriteTokens) : '—'}</b>
          </span>
          <span>
            输出 <b>{s ? compact(s.outputTokens) : '—'}</b>
          </span>
        </div>
      </div>
    </>
  );
}

import { BarChart3, RefreshCw } from 'lucide-react';
import { compact, integer, localDay, money } from './format';
import { Heatmap } from './Heatmap';
import { Trend } from './Trend';
import { UsageFilters } from './UsageFilters';
import { UsageMetrics } from './UsageMetrics';
import { UsageRequests } from './UsageRequests';
import { Sub2ApiUsage } from './Sub2ApiUsage';
import { UsageDashboardProps, useUsageDashboard } from './useUsageDashboard';

export function UsageDashboard(props: UsageDashboardProps) {
  const { onSession } = props;
  const modelState = useUsageDashboard(props);
  const {
    range,
    model,
    setModel,
    offset,
    setOffset,
    from,
    to,
    anchor,
    setAnchor,
    data,
    error,
    busy,
    reload,
    change,
    s,
  } = modelState;
  return (
    <section className="usage-dashboard" aria-label="用量统计">
      <div className="usage-page-heading">
        <h1>
          用量统计<span className="title-dot">.</span>
        </h1>
        <button
          className="secondary"
          onClick={() => {
            setAnchor(Date.now());
            reload();
          }}
          disabled={data?.scan.running || busy}
        >
          <RefreshCw size={15} className={data?.scan.running ? 'spin' : ''} />
          {data?.scan.running ? '正在同步' : '立即同步'}
        </button>
      </div>
      <UsageFilters model={modelState} />
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={reload}>重试</button>
        </div>
      )}
      {data?.warnings.map((w) => (
        <p className="usage-warning" key={w} role="status">
          {w}
        </p>
      ))}
      <div className="usage-hero">
        <UsageMetrics s={s} busy={busy} />
        {range === 'all' ? (
          <Heatmap days={data?.days ?? []} />
        ) : (
          <Trend
            data={data}
            hourly={range === '24h'}
            from={
              range === 'custom'
                ? localDay(from)
                : anchor - (range === '7d' ? 7 : range === '30d' ? 30 : 1) * 86400000
            }
            to={range === 'custom' ? localDay(to) : anchor}
          />
        )}
      </div>
      {data && !data.scan.running && data.total === 0 && (
        <div className="usage-empty">
          <BarChart3 size={30} />
          <strong>此范围内暂无用量</strong>
          <p>可切换时间、模型或项目查看历史记录。</p>
        </div>
      )}
      {!!data?.models.length && (
        <section className="usage-card usage-models" aria-label="模型用量分布">
          <div className="usage-section-heading">
            <h2>模型分布</h2>
            <span>{data.models.length} 个模型</span>
          </div>
          <div className="usage-model-list">
            {data.models.map((m) => (
              <button
                key={m.model}
                onClick={() => change(() => setModel(model === m.model ? '' : m.model))}
                title={`筛选 ${m.model}`}
              >
                <div>
                  <strong>{m.model}</strong>
                  <span>{compact(m.tokens)} tokens</span>
                  <b>
                    {money(m.costUsd)}
                    {m.unpricedRequests ? '+' : ''}
                  </b>
                </div>
                <div className="usage-model-track">
                  <span
                    style={{ width: `${Math.max(0.5, (m.tokens / (s?.totalTokens || 1)) * 100)}%` }}
                  />
                </div>
                <small>
                  {integer(m.requests)} 次请求{m.unpricedRequests ? ' · 未定价' : ''}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}
      {props.openSub2ApiSettings && (
        <Sub2ApiUsage openSettings={props.openSub2ApiSettings} revision={props.revision} />
      )}
      <UsageRequests
        data={data}
        busy={busy}
        offset={offset}
        setOffset={setOffset}
        onSession={onSession}
      />
      <p className="usage-footnote">
        Token 来自本地用量记录；缓存属于输入、思考属于输出，均只计一次。首字和 TPS
        为日志估算（≈）；成本按 USD 配置价格计算，不代表实际账单。时间按当前设备时区显示。
      </p>
    </section>
  );
}

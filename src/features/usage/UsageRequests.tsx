import { ArrowLeft, ArrowRight } from 'lucide-react';
import { compact, integer, money, seconds, speed } from './format';
import { Help } from './Help';
import { UsageDashboardModel } from './useUsageDashboard';

export function UsageRequests({
  data,
  busy,
  offset,
  setOffset,
  onSession,
}: Pick<UsageDashboardModel, 'data' | 'busy' | 'offset' | 'setOffset'> & {
  onSession: (id: string) => void;
}) {
  return (
    <section className="usage-card usage-log" aria-label="请求日志">
      <div className="usage-section-heading">
        <h2>
          请求日志 <span>{integer(data?.total ?? 0)}</span>
        </h2>
        <small>Codex · 本地会话日志</small>
      </div>
      <div className="usage-table-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>会话 / 模型</th>
              <th>成本</th>
              <th>新增输入</th>
              <th>输出</th>
              <th>缓存读取</th>
              <th>缓存写入</th>
              <th>
                速度 <Help text="由本地日志估算，单位 tok/s。— 表示缺少有效请求起止时间。" />
              </th>
              <th>
                首字 <Help text="由生成开始时间估算，单位秒。— 表示缺少可靠记录。" />
              </th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            {data?.requests.map((r) => (
              <tr key={r.id}>
                <td title={new Date(r.timestamp).toLocaleString()}>
                  {new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                  <small>
                    {new Date(r.timestamp).toLocaleDateString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </small>
                </td>
                <td>
                  <button
                    className="usage-session-link"
                    onClick={() => onSession(r.sessionId)}
                    title={r.sessionTitle}
                  >
                    {r.sessionTitle}
                  </button>
                  <small>{r.model}</small>
                </td>
                <td className="usage-cost">
                  {r.costUsd === null ? (
                    <span className="usage-unpriced">未定价</span>
                  ) : (
                    money(r.costUsd, 4)
                  )}
                </td>
                <td title={integer(r.uncachedInputTokens)}>{compact(r.uncachedInputTokens)}</td>
                <td title={`含思考 ${integer(r.reasoningTokens)} tokens`}>
                  {compact(r.outputTokens)}
                </td>
                <td title={integer(r.cachedInputTokens)}>{compact(r.cachedInputTokens)}</td>
                <td>{compact(r.cacheWriteTokens)}</td>
                <td>{speed(r.tps)}</td>
                <td>{seconds(r.firstTokenMs)}</td>
                <td>{seconds(r.durationMs)}</td>
              </tr>
            ))}
            {busy && (
              <tr>
                <td colSpan={10}>正在读取请求日志…</td>
              </tr>
            )}
            {!busy && !data?.requests.length && (
              <tr>
                <td colSpan={10}>暂无请求记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="usage-pagination">
        <span>
          {data?.total
            ? `${offset + 1}–${Math.min(offset + 50, data.total)} / ${integer(data.total)}`
            : '0 条记录'}
        </span>
        <button
          className="icon-button"
          title="上一页请求"
          disabled={!offset || busy}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="icon-button"
          title="下一页请求"
          disabled={!data || offset + 50 >= data.total || busy}
          onClick={() => setOffset(offset + 50)}
        >
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

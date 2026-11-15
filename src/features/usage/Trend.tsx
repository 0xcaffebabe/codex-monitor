import type { UsageData } from '../../types';
import { compact, dateKey, integer } from './format';

export function Trend({
  data,
  hourly,
  from,
  to,
}: {
  data?: UsageData;
  hourly: boolean;
  from: number;
  to: number;
}) {
  const bars: { label: string; value: number; requests: number }[] = [];
  if (hourly) {
    const start = new Date(from);
    start.setMinutes(0, 0, 0);
    const map = new Map(data?.hours.map((h) => [h.timestamp, h]));
    for (let t = +start; t <= to && bars.length < 25; t += 3600000) {
      const h = map.get(t);
      bars.push({
        label: dateKey(new Date(t)) + ' ' + String(new Date(t).getHours()).padStart(2, '0') + ':00',
        value: h?.tokens ?? 0,
        requests: h?.requests ?? 0,
      });
    }
  } else {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const map = new Map(data?.days.map((d) => [d.date, d]));
    for (let i = 0; +start <= to && i < 366; i++, start.setDate(start.getDate() + 1)) {
      const key = dateKey(start),
        d = map.get(key);
      bars.push({ label: key, value: d?.tokens ?? 0, requests: d?.requests ?? 0 });
    }
  }
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="usage-trend">
      <div className="usage-section-heading">
        <h2>
          Tokens <span>· 按{hourly ? '小时' : '日'}</span>
        </h2>
        <small>峰值 {compact(max === 1 ? 0 : max)}</small>
      </div>
      <div
        className="usage-bars"
        role="img"
        aria-label={`按${hourly ? '小时' : '日'}统计的 Token 趋势`}
      >
        {bars.map((b, i) => (
          <div
            className="usage-bar-column"
            key={i}
            title={`${b.label} · ${integer(b.value)} tokens · ${integer(b.requests)} 次请求`}
          >
            <span
              className="usage-bar"
              style={{ height: `${(b.value / max) * 100}%`, minHeight: b.value ? 3 : 0 }}
            />
            <small>
              {i % Math.max(1, Math.ceil(bars.length / 8)) === 0
                ? hourly
                  ? b.label.slice(-5)
                  : b.label.slice(5)
                : ''}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}

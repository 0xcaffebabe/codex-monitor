import type { UsageData } from '../../types';
import { dateKey, integer } from './format';

export function Heatmap({ days }: { days: UsageData['days'] }) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 52 * 7);
  const map = new Map(days.map((d) => [d.date, d])),
    max = Math.max(1, ...days.map((d) => d.tokens)),
    cells: { key: string; tokens: number; requests: number; future: boolean }[] = [];
  for (let i = 0; i < 371; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = dateKey(d),
      row = map.get(key);
    cells.push({ key, tokens: row?.tokens ?? 0, requests: row?.requests ?? 0, future: +d > +end });
  }
  return (
    <div className="usage-heatmap">
      <div className="usage-section-heading">
        <h2>用量热力图</h2>
        <small>
          最近 53 周 · {dateKey(start)} 至 {dateKey(end)}
        </small>
      </div>
      <div className="usage-heatmap-scroll">
        <div className="usage-heatmap-months">
          {Array.from({ length: 53 }, (_, i) => {
            const d = new Date(start);
            d.setDate(d.getDate() + i * 7);
            return (
              <span key={i}>{i === 0 || d.getDate() <= 7 ? `${d.getMonth() + 1}月` : ''}</span>
            );
          })}
        </div>
        <div className="usage-heatmap-grid" role="img" aria-label="最近 53 周每日 Token 用量热力图">
          {cells.map((d) => (
            <span
              key={d.key}
              className={`heat-cell heat-${d.future ? 'future' : !d.tokens ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(d.tokens / max) * 4)))}`}
              tabIndex={d.future ? -1 : 0}
              title={`${d.key} · ${integer(d.tokens)} tokens · ${integer(d.requests)} 次请求`}
            />
          ))}
        </div>
      </div>
      <div className="usage-heatmap-legend">
        少
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`heat-cell heat-${i}`} />
        ))}
        多
      </div>
    </div>
  );
}

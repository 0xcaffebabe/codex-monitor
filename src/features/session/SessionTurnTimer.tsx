import { Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SessionTurnTiming } from '../../types';

export function SessionTurnTimer({ timing }: { timing?: SessionTurnTiming }) {
  const [now, setNow] = useState(() => Date.now());
  const startedAt = timing?.startedAt;
  const finishedAt = timing?.finishedAt;
  useEffect(() => {
    if (startedAt === undefined || finishedAt !== null) return;
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, [startedAt, finishedAt]);
  if (!timing || !Number.isFinite(timing.startedAt) || timing.startedAt <= 0) return null;
  const seconds = Math.floor(Math.max(0, (timing.finishedAt ?? now) - timing.startedAt) / 1000);
  const duration = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return (
    <div
      className="session-turn-timer"
      data-running={timing.finishedAt === null}
      title={`从最近一条人工消息发送时开始：${new Date(timing.startedAt).toLocaleString('zh-CN', { hour12: false })}`}
    >
      <span className="session-turn-timer-label">
        <Timer size={12} aria-hidden="true" />
        <span className="session-turn-timer-caption">本轮用时</span>
      </span>
      <time role="timer" aria-label="最近一轮 AI 对话用时" dateTime={`PT${seconds}S`}>
        {duration}
      </time>
    </div>
  );
}

import { ArrowDown, FileText } from 'lucide-react';
import type { SessionOutline, SessionPage } from '../../types';
import type { TimelineModel } from './useTimeline';

export function TurnResult({
  turn,
  observed,
  page,
  outline,
  error,
  model,
}: {
  turn: string;
  observed: number;
  page: SessionPage;
  outline?: SessionOutline;
  error: string;
  model: Pick<TimelineModel, 'jumpingEntry' | 'jumpToEntry'>;
}) {
  const entries =
    turn !== 'latest'
      ? outline?.entries.filter((entry) => entry.turnId === turn)
      : page.session.updatedAt === observed &&
          ['completed', 'failed', 'interrupted'].includes(page.session.status)
        ? outline?.entries.slice(-1)
        : [];
  const anchor = entries?.[0];
  const reply = entries?.findLast((entry) => entry.reply)?.reply;
  return (
    <section className="turn-result" aria-label="本轮结果">
      <div>
        <h2>
          <FileText size={16} />
          本轮结果
        </h2>
        <p>
          {reply ||
            (error
              ? '无法读取本轮摘要。'
              : !outline
                ? '正在读取本轮记录…'
                : anchor
                  ? '本轮未记录可显示的答复。'
                  : '无法定位原轮次，请核对会话历史。')}
        </p>
      </div>
      {anchor && (
        <button
          className="secondary"
          disabled={!!model.jumpingEntry}
          onClick={() => void model.jumpToEntry(anchor)}
        >
          <ArrowDown size={14} />
          定位本轮记录
        </button>
      )}
    </section>
  );
}

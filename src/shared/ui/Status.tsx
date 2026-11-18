import type { SessionStatus } from '../../types';

const statusLabel: Record<SessionStatus, string> = {
  running: '进行中',
  waiting: '等待确认',
  completed: '已完成',
  interrupted: '已中断',
  failed: '执行失败',
  idle: '待续',
  stale: '状态待确认',
};
export function Status({ status, dot = false }: { status: SessionStatus; dot?: boolean }) {
  const label = statusLabel[status];
  return (
    <span
      className={`status ${status}${dot ? ' status-dot' : ''}`}
      role={dot ? 'img' : undefined}
      aria-label={dot ? label : undefined}
      title={dot ? label : undefined}
    >
      <span />
      {!dot && label}
    </span>
  );
}

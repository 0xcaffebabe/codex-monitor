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
export function Status({ status }: { status: SessionStatus }) {
  return (
    <span className={`status ${status}`}>
      <span />
      {statusLabel[status]}
    </span>
  );
}

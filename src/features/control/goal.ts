export const goalStatuses: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  usageLimited: '用量受限',
  budgetLimited: '预算已用尽',
  complete: '已完成',
};
export function goalDuration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    remaining = total % 60;
  return hours
    ? `${hours}时${minutes}分${remaining}秒`
    : minutes
      ? `${minutes}分${remaining}秒`
      : `${remaining}秒`;
}

export const cx = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(' ');
export const number = (n: number) =>
  new Intl.NumberFormat('zh-CN', {
    notation: n >= 100000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n);
export const time = (n: number) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    n || Date.now(),
  );
export const date = (n: number) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(n || Date.now());
export function relative(
  n: number,
  { now = Date.now(), seconds = false }: { now?: number; seconds?: boolean } = {},
) {
  const delta = Math.max(0, now - n);
  if (seconds && delta >= 1000 && delta < 60000) return `${Math.floor(delta / 1000)} 秒前`;
  return delta < 60000
    ? '刚刚'
    : delta < 3600000
      ? `${Math.floor(delta / 60000)} 分钟前`
      : delta < 86400000
        ? `${Math.floor(delta / 3600000)} 小时前`
        : date(n);
}

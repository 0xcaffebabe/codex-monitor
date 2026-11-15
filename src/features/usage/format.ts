export const compact = (n: number) =>
  new Intl.NumberFormat('en-US', {
    notation: n >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n);
export const integer = (n: number) => n.toLocaleString('zh-CN');
export const money = (n: number, digits = 2) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const seconds = (n: number | null) => (n === null ? '—' : `≈${(n / 1000).toFixed(1)}s`);
export const speed = (n: number | null) => (n === null ? '—' : `≈${n.toFixed(1)} tok/s`);
export const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const localDay = (key: string) => new Date(key + 'T00:00:00').getTime();

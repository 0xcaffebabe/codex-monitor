export async function copyText(text: string | Promise<string>) {
  if (
    typeof text !== 'string' &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== 'undefined'
  ) {
    // Safari needs the write to start during the click, before the fetch resolves.
    const data = text.then((value) => new Blob([value], { type: 'text/plain' }));
    try {
      await Promise.all([
        data,
        navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]),
      ]);
      return;
    } catch {
      await data;
    }
  }
  const value = typeof text === 'string' ? text : await text;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const t = document.createElement('textarea');
  t.value = value;
  t.style.position = 'fixed';
  t.style.opacity = '0';
  document.body.append(t);
  t.select();
  const ok = document.execCommand('copy');
  t.remove();
  if (!ok) throw new Error('请在 HTTPS 或 localhost 中复制');
}

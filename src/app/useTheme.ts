import { useEffect, useState } from 'react';

export function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('codex-monitor.theme') === 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#191919' : '#f8f8f8');
    localStorage.setItem('codex-monitor.theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, setDark };
}

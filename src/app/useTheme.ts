import { useEffect, useState } from 'react';

export function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('codex-monitor.theme') === 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('codex-monitor.theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, setDark };
}

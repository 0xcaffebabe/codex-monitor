import { useCallback, useState } from 'react';
import { getToken } from '../../api';
import { copyText } from '../../shared/clipboard';
import type { Session } from '../../types';
import { workspaceSignal, workspaceUrl } from '../../workspace-scope';

export function useSessionActions(session: Session | undefined, notify: (message: string) => void) {
  const [exporting, setExporting] = useState(false);
  const copied = useCallback(
    async (text: string) => {
      try {
        await copyText(text);
        notify('已复制到剪贴板');
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [notify],
  );
  async function download() {
    if (!session) return;
    const route = `/api/sessions/${session.id}/export`;
    const signal = workspaceSignal(route);
    setExporting(true);
    try {
      const response = await fetch(workspaceUrl(route), {
        headers: { Authorization: `Bearer ${getToken()}` },
        signal,
      });
      if (!response.ok) throw new Error('导出失败，请重试');
      const blob = await response.blob();
      signal?.throwIfAborted();
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `${session.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 70)}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('会话已导出');
    } catch (e) {
      if (!signal?.aborted) notify((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return { copied, download, exporting };
}

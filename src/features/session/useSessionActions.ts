import { useCallback } from 'react';
import { copyText } from '../../shared/clipboard';

export function useSessionActions(notify: (message: string) => void) {
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
  return { copied };
}

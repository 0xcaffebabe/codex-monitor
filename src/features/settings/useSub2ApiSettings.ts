import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Sub2ApiSettings as Configuration } from '../../sub2api-types';

const endpoint = '/api/sub2api/settings';

export type Sub2ApiSettingsOptions = {
  notify?: (message: string) => void;
  onChange?: () => void;
};

export function useSub2ApiSettings({ notify, onChange }: Sub2ApiSettingsOptions) {
  const [saved, setSaved] = useState<Configuration>();
  const [baseUrl, setBaseUrl] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [pending, setPending] = useState<'load' | 'save' | 'remove' | null>('load');
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    void api<Configuration>(endpoint, { signal: abort.signal })
      .then((data) => {
        setSaved(data);
        setBaseUrl(data.baseUrl);
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(null);
      });
    return () => abort.abort();
  }, []);

  async function update(action: 'save' | 'remove') {
    setPending(action);
    setError('');
    try {
      const result = await api<Configuration>(
        endpoint,
        action === 'remove'
          ? { method: 'DELETE' }
          : {
              method: 'PUT',
              body: JSON.stringify({ baseUrl, adminKey: adminKey.trim() || undefined }),
            },
      );
      setSaved(result);
      setBaseUrl(result.baseUrl);
      setAdminKey('');
      onChange?.();
      notify?.(action === 'remove' ? 'Sub2API 配置已移除' : 'Sub2API 配置已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  return {
    saved,
    baseUrl,
    setBaseUrl,
    adminKey,
    setAdminKey,
    pending,
    error,
    update,
    dirty: baseUrl.trim() !== (saved?.baseUrl ?? '') || !!adminKey.trim(),
  };
}

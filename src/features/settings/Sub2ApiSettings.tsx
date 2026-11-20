import { Plug } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Sub2ApiSettings as Configuration } from '../../sub2api-types';

const endpoint = '/api/sub2api/settings';

export function Sub2ApiSettings({
  notify,
  onChange,
}: {
  notify: (message: string) => void;
  onChange?: () => void;
}) {
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
      notify(action === 'remove' ? 'Sub2API 配置已移除' : 'Sub2API 配置已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void update('save');
  };
  const dirty = baseUrl.trim() !== (saved?.baseUrl ?? '') || !!adminKey.trim();
  return (
    <section aria-labelledby="sub2api-settings-title">
      <h3 id="sub2api-settings-title">
        <Plug size={16} />
        Sub2API <span>{saved?.configured ? '已配置' : '未配置'}</span>
      </h3>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <form onSubmit={submit}>
        <fieldset className="sub2api-fields" disabled={!!pending}>
          <label>
            Sub2API 站点地址
            <input
              type="url"
              required
              maxLength={2048}
              value={baseUrl}
              placeholder="https://relay.example.com"
              autoComplete="off"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            管理员 Key
            <input
              type="password"
              required={!saved?.configured}
              maxLength={512}
              value={adminKey}
              autoComplete="new-password"
              placeholder={saved?.configured ? '已保存，留空保留' : ''}
              onChange={(event) => setAdminKey(event.target.value)}
            />
          </label>
          <div className="sub2api-settings-actions">
            <button className="primary" disabled={!dirty}>
              {pending === 'save' ? '正在保存…' : '保存 Sub2API 配置'}
            </button>
            {saved?.configured && (
              <button type="button" className="secondary" onClick={() => void update('remove')}>
                {pending === 'remove' ? '正在移除…' : '移除配置'}
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}

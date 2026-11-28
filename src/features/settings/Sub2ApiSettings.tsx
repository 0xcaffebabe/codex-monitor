import { Plug } from 'lucide-react';
import { useId, type FormEvent } from 'react';
import { useSub2ApiSettings, type Sub2ApiSettingsOptions } from './useSub2ApiSettings';

export function Sub2ApiSettings(options: Sub2ApiSettingsOptions) {
  const titleId = useId();
  const { saved, baseUrl, setBaseUrl, adminKey, setAdminKey, pending, error, update, dirty } =
    useSub2ApiSettings(options);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void update('save');
  };
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId}>
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

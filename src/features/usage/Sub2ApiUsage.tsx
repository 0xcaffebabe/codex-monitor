import { ArrowLeft, ArrowRight, Coins, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type {
  Sub2ApiAccount,
  Sub2ApiCredits,
  Sub2ApiKeyUsage,
  Sub2ApiPage,
  Sub2ApiSettings,
} from '../../sub2api-types';
import { dateKey, integer, money } from './format';

type View = 'accounts' | 'keys';

function useQuery<T>(url: string | undefined, revision: number) {
  const [result, setResult] = useState<{
    url: string;
    revision: number;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    void api<T>(url, { signal: abort.signal })
      .then((data) => setResult({ url, revision, data }))
      .catch((e: Error) => {
        if (!abort.signal.aborted) setResult({ url, revision, error: e.message });
      });
    return () => abort.abort();
  }, [url, revision]);
  const current = result?.url === url ? result : undefined;
  const busy = !!url && current?.revision !== revision;
  return { data: current?.data, error: busy ? undefined : current?.error, busy };
}

function timestamp(value: string | null) {
  const epoch = value ? Date.parse(value) : NaN;
  return Number.isFinite(epoch)
    ? new Date(epoch).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;
}

function creditBalance(credits: Sub2ApiCredits | null) {
  if (!credits) return '暂无点数数据';
  if (credits.unlimited) return '不限量';
  if (credits.balance !== null) return `${credits.balance} 点`;
  return credits.hasCredits ? '点数余额未知' : '无可用点数';
}

function AccountCredits({ account }: { account: Sub2ApiAccount }) {
  const [attempt, setAttempt] = useState(0);
  const result = useQuery<Sub2ApiCredits | null>(
    attempt ? `/api/sub2api/account-credits?accountId=${account.id}` : undefined,
    attempt,
  );
  const loaded = result.data !== undefined;
  const action = loaded ? '刷新点数' : '查询点数';
  return (
    <div className="sub2api-credits">
      {loaded && <span role="status">{creditBalance(result.data ?? null)}</span>}
      <button
        type="button"
        title={action}
        aria-label={`${account.name} ${action}`}
        disabled={result.busy}
        onClick={() => setAttempt((value) => value + 1)}
      >
        {result.busy || loaded ? (
          <RefreshCw size={13} className={result.busy ? 'spin' : ''} />
        ) : (
          <Coins size={13} />
        )}
        {!loaded && action}
      </button>
      {result.error && <small role="alert">{result.error}</small>}
    </div>
  );
}

function AccountRows({ items }: { items: Sub2ApiAccount[] }) {
  const stateLabels: Record<string, string> = {
    active: '正常',
    inactive: '停用',
    disabled: '停用',
    error: '异常',
  };
  return items.map((account) => (
    <tr key={account.id}>
      <td>
        <strong>{account.name}</strong>
        <small>
          {account.platform} · #{account.id} · {stateLabels[account.status] ?? account.status}
        </small>
        {account.platform === 'openai' && <AccountCredits account={account} />}
      </td>
      <td>
        <div className="sub2api-quotas">
          {account.quotas.map((quota) => {
            const reset = timestamp(quota.resetsAt);
            return (
              <div className="sub2api-quota" key={quota.label}>
                <span>{quota.label}</span>
                <b>
                  {quota.usedPercent === null
                    ? '未知'
                    : `${quota.usedPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`}
                </b>
                {quota.usedPercent !== null && (
                  <progress
                    aria-label={`${quota.label}已用比例`}
                    max={100}
                    value={Math.min(100, Math.max(0, quota.usedPercent))}
                  />
                )}
                {reset && <small>{reset} 重置</small>}
                {(quota.requests !== null || quota.tokens !== null) && (
                  <small>
                    {[
                      quota.requests === null ? null : `${integer(quota.requests)} 次`,
                      quota.tokens === null ? null : `${integer(quota.tokens)} Token`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                )}
              </div>
            );
          })}
          {account.quotaUnavailable && (
            <span className="muted">
              {account.quotas.length ? '部分额度暂不可用' : '额度暂不可用'}
            </span>
          )}
          {!account.quotaUnavailable && !account.quotas.length && (
            <span className="muted">暂无额度快照</span>
          )}
        </div>
      </td>
      <td>{timestamp(account.updatedAt) ?? '-'}</td>
    </tr>
  ));
}

function KeyRows({ items }: { items: Sub2ApiKeyUsage[] }) {
  return items.map((key) => (
    <tr key={key.id}>
      <td>
        <strong>{key.name || `#${key.id}`}</strong>
        {key.name && <small>#{key.id}</small>}
      </td>
      <td>{integer(key.requests)}</td>
      <td>{integer(key.tokens)}</td>
      <td className="usage-cost">{key.actualCost === null ? '-' : money(key.actualCost, 4)}</td>
    </tr>
  ));
}

export function Sub2ApiUsage({
  revision = 0,
  openSettings,
}: {
  revision?: number;
  openSettings: () => void;
}) {
  const [view, setView] = useState<View>('accounts');
  const [page, setPage] = useState(1);
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [accountType, setAccountType] = useState('oauth');
  const [days, setDays] = useState('7');
  const [refresh, setRefresh] = useState(0);
  const generation = revision + refresh;
  const settings = useQuery<Sub2ApiSettings>('/api/sub2api/settings', generation);
  const configured = settings.data?.configured;
  const params = new URLSearchParams({ page: String(page), search });
  if (view === 'accounts') params.set('type', accountType);
  else {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - Number(days) + 1);
    params.set('startDate', dateKey(start));
    params.set('endDate', dateKey(end));
    params.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  const query = configured ? `/api/sub2api/${view}?${params}` : undefined;
  const accounts = useQuery<Sub2ApiPage<Sub2ApiAccount>>(
    view === 'accounts' ? query : undefined,
    generation,
  );
  const keys = useQuery<Sub2ApiPage<Sub2ApiKeyUsage>>(
    view === 'keys' ? query : undefined,
    generation,
  );
  const result = view === 'accounts' ? accounts : keys;
  const busy = settings.busy || result.busy;
  const error = settings.error || result.error;
  const nextPage = !!result.data && page * result.data.pageSize < result.data.total;

  function show(next: View) {
    if (next === view) return;
    setView(next);
    setPage(1);
    setDraftSearch('');
    setSearch('');
  }

  return (
    <section
      className="usage-card sub2api-usage"
      aria-labelledby="sub2api-usage-title"
      aria-busy={busy}
    >
      <div className="usage-section-heading sub2api-heading">
        <h2 id="sub2api-usage-title">Sub2API 用量</h2>
        {(configured || error) && (
          <button
            className="icon-button"
            title="刷新 Sub2API 用量"
            aria-label="刷新 Sub2API 用量"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
          </button>
        )}
      </div>
      {error && (
        <div className="alert error sub2api-message" role="alert">
          {error}
        </div>
      )}
      {!configured && !error && (
        <div className="sub2api-message">
          {settings.busy ? (
            <span role="status">正在读取 Sub2API 配置…</span>
          ) : (
            <button className="secondary" onClick={openSettings}>
              配置 Sub2API
            </button>
          )}
        </div>
      )}
      {configured && (
        <>
          <div className="sub2api-toolbar">
            <div className="sub2api-views" role="group" aria-label="Sub2API 用量视图">
              <button
                type="button"
                aria-pressed={view === 'accounts'}
                onClick={() => show('accounts')}
              >
                订阅账号
              </button>
              <button type="button" aria-pressed={view === 'keys'} onClick={() => show('keys')}>
                API Key
              </button>
            </div>
            <form
              className="sub2api-filters"
              onSubmit={(event) => {
                event.preventDefault();
                const nextSearch = draftSearch.trim();
                if (page === 1 && search === nextSearch && result.error) {
                  setRefresh((value) => value + 1);
                  return;
                }
                setPage(1);
                setSearch(nextSearch);
              }}
            >
              {view === 'accounts' ? (
                <select
                  aria-label="订阅账号类型"
                  value={accountType}
                  onChange={(event) => {
                    setPage(1);
                    setAccountType(event.target.value);
                  }}
                >
                  <option value="oauth">OAuth</option>
                  <option value="setup-token">Setup Token</option>
                </select>
              ) : (
                <select
                  aria-label="Sub2API Key 统计时间范围"
                  value={days}
                  onChange={(event) => {
                    setPage(1);
                    setDays(event.target.value);
                  }}
                >
                  <option value="1">今天</option>
                  <option value="7">近 7 天</option>
                  <option value="30">近 30 天</option>
                </select>
              )}
              <input
                type="search"
                aria-label={view === 'accounts' ? '订阅账号名称' : 'Key 名称或 #ID'}
                placeholder={view === 'accounts' ? '订阅账号名称' : 'Key 名称或 #ID'}
                value={draftSearch}
                maxLength={100}
                onChange={(event) => setDraftSearch(event.target.value)}
              />
              <button
                className="icon-button"
                title="查询 Sub2API 用量"
                aria-label="查询 Sub2API 用量"
              >
                <Search size={16} />
              </button>
            </form>
          </div>
          {result.data?.warning && (
            <p className="usage-warning sub2api-message" role="status">
              {result.data.warning}
            </p>
          )}
          {result.busy && (
            <p className="sub2api-message muted" role="status">
              正在查询 Sub2API…
            </p>
          )}
          {result.data && !result.data.items.length && (
            <p className="sub2api-message muted">
              {view === 'accounts' ? '未找到订阅账号' : '所选区间未找到有调用记录的 Key'}
            </p>
          )}
          {!!result.data?.items.length && (
            <div className="usage-table-scroll">
              <table
                className="sub2api-table"
                aria-label={view === 'accounts' ? '订阅账号用量' : 'API Key 用量'}
              >
                <thead>
                  {view === 'accounts' ? (
                    <tr>
                      <th scope="col">账号</th>
                      <th scope="col">额度已用</th>
                      <th scope="col">快照时间</th>
                    </tr>
                  ) : (
                    <tr>
                      <th scope="col">API Key</th>
                      <th scope="col">请求数</th>
                      <th scope="col">Token</th>
                      <th scope="col">实际扣费</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {view === 'accounts' ? (
                    <AccountRows key={generation} items={accounts.data?.items ?? []} />
                  ) : (
                    <KeyRows items={keys.data?.items ?? []} />
                  )}
                </tbody>
              </table>
            </div>
          )}
          {(page > 1 || nextPage) && (
            <div className="usage-pagination">
              <span>
                第 {page} 页{result.data ? ` · ${integer(result.data.total)} 条` : ''}
              </span>
              <button
                className="icon-button"
                title="Sub2API 上一页"
                aria-label="Sub2API 上一页"
                disabled={page === 1 || busy}
                onClick={() => setPage(page - 1)}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                className="icon-button"
                title="Sub2API 下一页"
                aria-label="Sub2API 下一页"
                disabled={!nextPage || busy}
                onClick={() => setPage(page + 1)}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
